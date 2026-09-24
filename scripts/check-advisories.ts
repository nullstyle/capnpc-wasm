// Query OSV.dev for advisories against the pinned runtimes and the npm packages
// in the Deno lockfiles, which osv-scanner does not read. Needs the network;
// the supply-chain workflow runs it weekly (`mise run audit:advisories`).
//
// Queried: the deno and wasmtime pins of mise.toml and the Deno worker runtime
// of sdk/typescript/environment.ts as crates.io packages (their advisories
// are published against those crates), the go pin as the Go standard library,
// the requirements of sdk/go/go.mod as Go modules, and every npm package in
// tests/browser/deno.lock and examples/browser/deno.lock. The Go and Rust
// manifests are otherwise covered by `mise run audit:osv` and
// `mise run audit:govulncheck`.
//
// An accepted advisory names the exact pinned version it was accepted for and
// the reason; it is reported but does not fail the run. Every other advisory
// fails the run.

type Package = { ecosystem: string; name: string };
type Query = { package: Package; version: string; source: string };
type Result = { vulns?: { id: string }[] };

const accepted: {
  package: Package;
  version: string;
  ids: string[];
  reason: string;
}[] = [
  {
    package: { ecosystem: "crates.io", name: "deno" },
    version: "2.6.8",
    ids: [
      "GHSA-4c8g-jvcx-v4hv",
      "GHSA-7xh3-mhg9-jcw8",
      "GHSA-83pc-3rw9-qpwj",
      "GHSA-8xpq-cjcf-3wh9",
      "GHSA-968w-xfqw-vp9q",
      "GHSA-9xg4-qhm4-g43w",
      "GHSA-chqv-56wv-7564",
      "GHSA-cpgj-f7g3-2pp2",
      "GHSA-v8fw-85r8-5m23",
      "GHSA-x2qc-cmh9-f4hf",
    ],
    reason:
      "the worker lane pins Deno 2.6.8 knowingly: later releases do not stop a terminated worker (docs/deno-worker-termination.md); the pin is decision D1's",
  },
];

function pin(toml: string, tool: string): string {
  const match = toml.match(new RegExp(`^${tool} = "([^"]+)"$`, "m"));
  if (!match) throw new Error(`no ${tool} pin in mise.toml`);
  return match[1];
}

async function collectQueries(): Promise<Query[]> {
  const toml = await Deno.readTextFile("mise.toml");
  const worker = (await Deno.readTextFile("sdk/typescript/environment.ts"))
    .match(/^export const supportedDenoWorkerVersion = "([^"]+)";$/m);
  if (!worker) {
    throw new Error(
      "supportedDenoWorkerVersion not found in sdk/typescript/environment.ts",
    );
  }
  const queries: Query[] = [
    {
      package: { ecosystem: "crates.io", name: "deno" },
      version: pin(toml, "deno"),
      source: "mise.toml deno",
    },
    {
      package: { ecosystem: "crates.io", name: "deno" },
      version: worker[1],
      source: "sdk/typescript/environment.ts supportedDenoWorkerVersion",
    },
    {
      package: { ecosystem: "crates.io", name: "wasmtime" },
      version: pin(toml, "wasmtime"),
      source: "mise.toml wasmtime",
    },
    {
      package: { ecosystem: "Go", name: "stdlib" },
      version: pin(toml, "go"),
      source: "mise.toml go",
    },
  ];
  for (const line of (await Deno.readTextFile("sdk/go/go.mod")).split("\n")) {
    const fields = line.replace(/\/\/.*$/, "").trim().split(/\s+/);
    if (fields[0] === "require") fields.shift();
    if (
      fields.length < 2 || !fields[0].includes("/") || !/^v\d/.test(fields[1])
    ) {
      continue;
    }
    queries.push({
      package: { ecosystem: "Go", name: fields[0] },
      version: fields[1].slice(1),
      source: "sdk/go/go.mod",
    });
  }
  for (
    const lockfile of ["tests/browser/deno.lock", "examples/browser/deno.lock"]
  ) {
    const lock = JSON.parse(await Deno.readTextFile(lockfile));
    for (const key of Object.keys(lock.npm ?? {})) {
      const at = key.lastIndexOf("@");
      queries.push({
        package: { ecosystem: "npm", name: key.slice(0, at) },
        version: key.slice(at + 1),
        source: lockfile,
      });
    }
  }
  return queries;
}

const queries = await collectQueries();
const response = await fetch("https://api.osv.dev/v1/querybatch", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    queries: queries.map(({ package: pkg, version }) => ({
      package: pkg,
      version,
    })),
  }),
  signal: AbortSignal.timeout(60_000),
});
if (!response.ok) {
  throw new Error(`OSV query failed: HTTP ${response.status}`);
}
const results: Result[] = (await response.json()).results ?? [];
if (results.length !== queries.length) {
  throw new Error(
    `OSV returned ${results.length} results for ${queries.length} queries`,
  );
}

let failures = 0;
queries.forEach((query, index) => {
  const ids = (results[index].vulns ?? []).map((vuln) => vuln.id).sort();
  const label =
    `${query.package.ecosystem} ${query.package.name} ${query.version} (${query.source})`;
  if (ids.length === 0) {
    console.log(`PASS ${label}: no advisories`);
    return;
  }
  const acceptance = accepted.find((entry) =>
    entry.package.ecosystem === query.package.ecosystem &&
    entry.package.name === query.package.name &&
    entry.version === query.version
  );
  const unaccepted = ids.filter((id) => !acceptance?.ids.includes(id));
  if (unaccepted.length === 0) {
    console.log(
      `WARN ${label}: ${ids.length} accepted advisories (${acceptance?.reason}): ${
        ids.join(", ")
      }`,
    );
    return;
  }
  failures += unaccepted.length;
  console.log(`FAIL ${label}: ${unaccepted.join(", ")}`);
});
if (failures > 0) {
  console.error(
    `${failures} advisories are not accepted; fix the pin or add an accepted entry with its reason in scripts/check-advisories.ts`,
  );
  Deno.exit(1);
}
