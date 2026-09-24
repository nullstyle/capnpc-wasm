// The failure and limit conformance corpus: one list of inputs that every host
// surface runs (TypeScript direct and worker, Go, the packaged launcher, the
// browsers in both modes, and the Schema Studio adapter), with the expected
// outcome per surface in tests/fixtures/conformance/expected.json.
//
// The corpus is materialized into tests/fixtures/conformance/cases.json so the
// Go test can read it. Large synthetic inputs (deep chains) are recipes that
// every runner expands itself; the recorded workspace digest pins the
// expansion, so a runner that expands a recipe differently fails before it
// runs the case. Regenerate the JSON after editing this file:
//
//   mise exec -- deno run --allow-read --allow-write=tests/fixtures/conformance tests/conformance/cases.ts --write
//
// `mise run test:conformance` fails when the JSON no longer matches this file.

export type Language = "cpp" | "rust" | "go" | "zig";

export type LimitName =
  | "memoryPages"
  | "workspaceBytes"
  | "workspaceEntries"
  | "pathBytes"
  | "requestBytes"
  | "outputBytes"
  | "outputEntries"
  | "stdoutBytes"
  | "stderrBytes";

/** A schema file: literal text or a recipe every runner expands identically. */
export type FileSpec =
  | { text: string }
  | {
    recipe: "constChain" | "nestedStructs" | "nestedList" | "nestedExpr";
    depth: number;
  };

/** The generation requests derived from a compile of `simpleSchema`. */
export type RequestVariant = "valid" | "half" | "one" | "zeros8" | "pattern4k";

export interface CaseSpec {
  name: string;
  op: "compile" | "generate";
  /** Compile inputs by path; `filesRecipe` replaces them for multi-file recipes. */
  files?: Record<string, FileSpec>;
  filesRecipe?: { recipe: "importChain"; depth: number };
  /** Standard schemas by their include name, read from the pinned references. */
  includeFiles?: Record<string, { standard: string }>;
  entrypoints?: string[];
  importPaths?: string[];
  sourcePrefix?: string;
  generators: Language[];
  /** Generation input; every surface compiles `simpleSchema` itself for "valid". */
  request?: RequestVariant;
  /** A guest from guests/ that replaces the compiler module. */
  compiler?: string;
  /** Guests from guests/ that replace generator modules. */
  generatorGuests?: Partial<Record<Language, string>>;
  limits?: Partial<Record<LimitName, number>>;
  /** Run under this deadline where the surface has one; the row expects `timeout`. */
  deadlineMs?: number;
  /** sha256 of the expanded workspace, recorded by --write and checked by every runner. */
  sha256?: string;
}

const ID = "@0xece4bf9c1f867623;";
export const simpleSchema = `${ID} struct Person { name @0 :Text; }`;
const brokenSchema = `${ID} struct Broken { invalid`;

/** Hex of a schema id derived from `n`, the same on every surface. */
function schemaId(n: number): string {
  return "@0x" + (0xc000000000000000n + BigInt(n) * 7919n).toString(16) + ";";
}

export function constChain(depth: number): string {
  let text = `${schemaId(1)}\n`;
  for (let i = 0; i < depth; i++) text += `const c${i} :UInt32 = .c${i + 1};\n`;
  return text + `const c${depth} :UInt32 = 7;\n`;
}

export function nestedStructs(depth: number): string {
  let text = "";
  for (let i = 0; i < depth; i++) text += `struct S${i} { `;
  text += "x @0 :UInt8; ";
  for (let i = 0; i < depth; i++) text += "} ";
  return `${ID}\n${text}\n`;
}

export function nestedList(depth: number): string {
  return `${ID}\nstruct A { f @0 :${"List(".repeat(depth)}Text${
    ")".repeat(depth)
  }; }\n`;
}

export function nestedExpr(depth: number): string {
  return `${ID}\nconst c :UInt32 = ${"(".repeat(depth)}1${
    ")".repeat(depth)
  };\n`;
}

export function importChain(depth: number): Record<string, string> {
  const files: Record<string, string> = {};
  for (let i = 0; i < depth; i++) {
    files[`f${i}.capnp`] = `${schemaId(i + 10)}\nusing Next = import "f${
      i + 1
    }.capnp";\nstruct T { t @0 :Next.T; }\n`;
  }
  files[`f${depth}.capnp`] = `${
    schemaId(depth + 10)
  }\nstruct T { x @0 :UInt8; }\n`;
  return files;
}

/** A relative path of exactly `bytes` UTF-8 bytes ending in .capnp. */
export function longPath(bytes: number): string {
  const parts: string[] = [];
  let remaining = bytes;
  while (remaining > 250 + 1 + 20) {
    parts.push("d".repeat(250));
    remaining -= 251;
  }
  parts.push("f".repeat(remaining - ".capnp".length) + ".capnp");
  const path = parts.join("/");
  if (new TextEncoder().encode(path).length !== bytes) {
    throw new Error(`longPath(${bytes}) produced ${path.length} bytes`);
  }
  return path;
}

/** Standard include names to their pinned reference paths. */
export const standardIncludes: Record<string, string> = {
  "go.capnp": "ref/go-capnp/std/go.capnp",
  "capnp/c++.capnp": "ref/capnproto/c++/src/capnp/c++.capnp",
};

const goAnnotated =
  `@0xece4bf9c1f867624;\nusing Go = import "/go.capnp";\n$Go.package("a");\n$Go.import("example.com/a");\nstruct A { x @0 :UInt8; }\n`;

/** The ceiling below which every surface, worker threads included, must compile a const-reference chain. */
export const passingConstChainDepth = 100;
/** A const-reference chain no surface's stack holds. */
export const failingConstChainDepth = 4000;
/** An import chain every surface must compile. */
export const passingImportChainDepth = 100;

const text = (value: string): FileSpec => ({ text: value });
const simpleWorkspace = {
  files: { "a.capnp": text(simpleSchema) },
  entrypoints: ["a.capnp"],
};

function generation(
  name: string,
  guest: string,
  extra: Partial<CaseSpec> = {},
): CaseSpec {
  return {
    name,
    op: "generate",
    request: "valid",
    generators: ["cpp"],
    generatorGuests: { cpp: guest },
    ...extra,
  };
}

function limitCase(
  name: string,
  limits: Partial<Record<LimitName, number>>,
  extra: Partial<CaseSpec> = {},
): CaseSpec {
  return {
    name,
    op: "compile",
    ...simpleWorkspace,
    generators: [],
    limits,
    ...extra,
  };
}

export const cases: CaseSpec[] = [
  // Compiler diagnostics: exit 1 with the compiler's stderr on every surface.
  {
    name: "invalid-schema",
    op: "compile",
    files: { "broken.capnp": text(brokenSchema) },
    entrypoints: ["broken.capnp"],
    generators: ["cpp"],
  },
  {
    name: "missing-import",
    op: "compile",
    files: {
      "m.capnp": text(
        `${ID}\nusing Missing = import "not-here.capnp";\nstruct B { f @0 :Missing.T; }\n`,
      ),
    },
    entrypoints: ["m.capnp"],
    generators: [],
  },
  // Import roots and source prefixes that name no directory are caller errors
  // for the SDKs; the launcher passes them through to the compiler.
  {
    name: "missing-import-root",
    op: "compile",
    ...simpleWorkspace,
    importPaths: ["nope"],
    generators: [],
  },
  {
    name: "missing-source-prefix",
    op: "compile",
    ...simpleWorkspace,
    sourcePrefix: "nope",
    generators: [],
  },
  // Depth: the parser bounds nesting itself (exit 1), while reference and
  // import chains recurse until an engine's stack ends (GAP3-02).
  {
    name: "nested-structs-60",
    op: "compile",
    files: { "d.capnp": { recipe: "nestedStructs", depth: 60 } },
    entrypoints: ["d.capnp"],
    generators: ["cpp", "rust", "zig"],
  },
  {
    name: "nested-structs-200",
    op: "compile",
    files: { "d.capnp": { recipe: "nestedStructs", depth: 200 } },
    entrypoints: ["d.capnp"],
    generators: ["cpp"],
  },
  {
    name: "nested-list-200",
    op: "compile",
    files: { "d.capnp": { recipe: "nestedList", depth: 200 } },
    entrypoints: ["d.capnp"],
    generators: [],
  },
  {
    name: "nested-expr-200",
    op: "compile",
    files: { "d.capnp": { recipe: "nestedExpr", depth: 200 } },
    entrypoints: ["d.capnp"],
    generators: [],
  },
  {
    name: `const-chain-${passingConstChainDepth}`,
    op: "compile",
    files: {
      "c.capnp": { recipe: "constChain", depth: passingConstChainDepth },
    },
    entrypoints: ["c.capnp"],
    generators: ["cpp", "rust", "zig"],
  },
  {
    name: `const-chain-${failingConstChainDepth}`,
    op: "compile",
    files: {
      "c.capnp": { recipe: "constChain", depth: failingConstChainDepth },
    },
    entrypoints: ["c.capnp"],
    generators: [],
  },
  {
    name: `import-chain-${passingImportChainDepth}`,
    op: "compile",
    filesRecipe: { recipe: "importChain", depth: passingImportChainDepth },
    entrypoints: ["f0.capnp"],
    generators: ["cpp", "rust", "zig"],
  },
  // Paths at and past the default pathBytes budget.
  {
    name: "path-4096",
    op: "compile",
    files: { [longPath(4096)]: text(simpleSchema) },
    entrypoints: [longPath(4096)],
    generators: [],
  },
  {
    name: "path-4097",
    op: "compile",
    files: { [longPath(4097)]: text(simpleSchema) },
    entrypoints: [longPath(4097)],
    generators: [],
  },
  // A real generator that fails after the compiler succeeded.
  {
    name: "go-missing-package",
    op: "compile",
    ...simpleWorkspace,
    generators: ["go"],
  },
  {
    name: "go-partial-output",
    op: "compile",
    files: {
      "a.capnp": text(goAnnotated),
      "b.capnp": text(`@0xece4bf9c1f867625;\nstruct B { x @0 :UInt8; }\n`),
    },
    includeFiles: { "go.capnp": { standard: "go.capnp" } },
    entrypoints: ["a.capnp", "b.capnp"],
    generators: ["go"],
  },
  // Compiler guests that trap, exhaust the stack, or never return.
  {
    name: "compiler-trap",
    op: "compile",
    ...simpleWorkspace,
    generators: [],
    compiler: "trap",
  },
  {
    name: "compiler-stack-overflow",
    op: "compile",
    ...simpleWorkspace,
    generators: [],
    compiler: "recurse",
  },
  {
    name: "compiler-timeout",
    op: "compile",
    ...simpleWorkspace,
    generators: [],
    compiler: "loop",
    deadlineMs: 500,
  },
  // Budgets detected before any guest starts (validation) and while the
  // compiler runs (limit), per docs/sdk-contract.md.
  limitCase("limit-memoryPages-initial", { memoryPages: 100 }),
  limitCase("limit-memoryPages-runtime", { memoryPages: 130 }),
  limitCase("limit-workspaceBytes", { workspaceBytes: 10 }),
  limitCase("limit-workspaceEntries", { workspaceEntries: 2 }, {
    files: { "a.capnp": text(simpleSchema), "b/c.capnp": text(simpleSchema) },
  }),
  limitCase("limit-pathBytes", { pathBytes: 5 }, {
    files: { "abcdef.capnp": text(simpleSchema) },
    entrypoints: ["abcdef.capnp"],
  }),
  limitCase("limit-requestBytes-compile", { requestBytes: 100 }),
  limitCase("limit-stdoutBytes-compile", { stdoutBytes: 100 }),
  limitCase("limit-stderrBytes", { stderrBytes: 10 }, {
    files: { "broken.capnp": text(brokenSchema) },
    entrypoints: ["broken.capnp"],
  }),
  // Generator guests: partial output, names, floods, growth, traps, warnings.
  generation("generator-partial-exit", "partial-exit"),
  generation("generator-partial-trap", "partial-trap"),
  generation("generator-bad-name", "bad-name"),
  generation("generator-long-name", "long-name", { limits: { pathBytes: 16 } }),
  generation("generator-stderr-flood", "stderr-flood"),
  generation("generator-stdout-flood", "stdout-flood"),
  generation("generator-many-files", "many-files"),
  generation("generator-big-file", "big-file"),
  generation("generator-memory-grow", "memory-grow"),
  generation("generator-trap", "trap"),
  generation("generator-stack-overflow", "recurse"),
  generation("generator-warning", "warn"),
  generation("generator-timeout", "loop", { deadlineMs: 500 }),
  // Budgets around generation with the real C++ generator.
  {
    name: "limit-requestBytes-generate",
    op: "generate",
    request: "valid",
    generators: ["cpp"],
    limits: { requestBytes: 100 },
  },
  {
    name: "limit-outputBytes",
    op: "generate",
    request: "valid",
    generators: ["cpp"],
    limits: { outputBytes: 100 },
  },
  {
    name: "limit-outputEntries",
    op: "generate",
    request: "valid",
    generators: ["cpp"],
    limits: { outputEntries: 1 },
  },
  // Malformed requests: every generator exits 1 with its own diagnostic.
  ...(["cpp", "rust", "go", "zig"] as const).flatMap((language) =>
    (["half", "one", "zeros8", "pattern4k"] as const).map((
      variant,
    ): CaseSpec => ({
      name: `request-${variant}-${language}`,
      op: "generate",
      request: variant,
      generators: [language],
    }))
  ),
];

/** The expanded, byte-level inputs of a compile case. */
export interface Workspace {
  files: Record<string, Uint8Array>;
  includeFiles: Record<string, Uint8Array>;
}

const encoder = new TextEncoder();

function expandFile(spec: FileSpec): string {
  if ("text" in spec) return spec.text;
  switch (spec.recipe) {
    case "constChain":
      return constChain(spec.depth);
    case "nestedStructs":
      return nestedStructs(spec.depth);
    case "nestedList":
      return nestedList(spec.depth);
    case "nestedExpr":
      return nestedExpr(spec.depth);
  }
}

/**
 * Expand a case's files and includes. `readStandard` supplies the pinned
 * standard schemas by include name (the Deno runners read the reference
 * checkout; browser drivers post the same bytes into the page).
 */
export async function expandWorkspace(
  spec: CaseSpec,
  readStandard: (name: string) => Promise<Uint8Array>,
): Promise<Workspace> {
  const files: Record<string, Uint8Array> = {};
  if (spec.filesRecipe) {
    for (
      const [path, text] of Object.entries(importChain(spec.filesRecipe.depth))
    ) {
      files[path] = encoder.encode(text);
    }
  }
  for (const [path, file] of Object.entries(spec.files ?? {})) {
    files[path] = encoder.encode(expandFile(file));
  }
  const includeFiles: Record<string, Uint8Array> = {};
  for (const [path, include] of Object.entries(spec.includeFiles ?? {})) {
    includeFiles[path] = await readStandard(include.standard);
  }
  return { files, includeFiles };
}

/** sha256 over every mount's entries in byte order; the Go runner computes the same. */
export async function workspaceDigest(workspace: Workspace): Promise<string> {
  const parts: Uint8Array[] = [];
  for (
    const [tag, entries] of [["f", workspace.files], [
      "i",
      workspace.includeFiles,
    ]] as const
  ) {
    for (const path of Object.keys(entries).sort()) {
      parts.push(
        encoder.encode(`${tag}\0${path}\0`),
        entries[path],
        new Uint8Array([0]),
      );
    }
  }
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    buffer.set(part, offset);
    offset += part.length;
  }
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  )
    .join("");
}

/** Derive the malformed request variants from a valid request. */
export function requestVariant(
  variant: RequestVariant,
  valid: Uint8Array,
): Uint8Array {
  switch (variant) {
    case "valid":
      return valid;
    case "half":
      return valid.slice(0, valid.length >> 1);
    case "one":
      return Uint8Array.of(1);
    case "zeros8":
      return new Uint8Array(8);
    case "pattern4k":
      return Uint8Array.from({ length: 4096 }, (_, i) => (i * 167 + 89) & 0xff);
  }
}

/** The generators a case runs with real modules (custom guests replace the rest). */
export function usesCustomGuests(spec: CaseSpec): boolean {
  return spec.compiler !== undefined ||
    Object.keys(spec.generatorGuests ?? {}).length > 0;
}

/** Read a pinned standard schema from the repository root. */
export function standardReader(root: string | URL) {
  return async (name: string): Promise<Uint8Array> => {
    const relative = standardIncludes[name];
    if (!relative) throw new Error(`unknown standard include ${name}`);
    return await Deno.readFile(new URL(relative, root));
  };
}

/** The materialized corpus with workspace digests. */
export async function materialize(
  readStandard: (name: string) => Promise<Uint8Array>,
): Promise<CaseSpec[]> {
  const names = new Set<string>();
  const result: CaseSpec[] = [];
  for (const spec of cases) {
    if (names.has(spec.name)) throw new Error(`duplicate case ${spec.name}`);
    names.add(spec.name);
    const entry: CaseSpec = { ...spec };
    delete entry.sha256;
    if (spec.op === "compile") {
      entry.sha256 = await workspaceDigest(
        await expandWorkspace(spec, readStandard),
      );
    }
    result.push(entry);
  }
  return result;
}

export const casesPath = "tests/fixtures/conformance/cases.json";

/** Load the materialized corpus from the repository root. */
export async function loadCases(root: string | URL): Promise<CaseSpec[]> {
  return JSON.parse(await Deno.readTextFile(new URL(casesPath, root)));
}

/** Expand a loaded case and check its digest against the recorded one. */
export async function expandCase(
  spec: CaseSpec,
  readStandard: (name: string) => Promise<Uint8Array>,
): Promise<Workspace> {
  const workspace = await expandWorkspace(spec, readStandard);
  if (spec.op === "compile") {
    const digest = await workspaceDigest(workspace);
    if (digest !== spec.sha256) {
      throw new Error(
        `${spec.name}: expanded workspace digest ${digest} differs from the recorded ${spec.sha256}`,
      );
    }
  }
  return workspace;
}

if (import.meta.main) {
  const root = new URL("../../", import.meta.url);
  const json =
    JSON.stringify(await materialize(standardReader(root)), null, 2) +
    "\n";
  if (Deno.args.includes("--write")) {
    await Deno.writeTextFile(new URL(casesPath, root), json);
    console.log(`wrote ${casesPath} (${cases.length} cases)`);
  } else {
    const current = await Deno.readTextFile(new URL(casesPath, root));
    if (
      JSON.stringify(JSON.parse(current)) !== JSON.stringify(JSON.parse(json))
    ) {
      console.error(`${casesPath} is stale; run with --write`);
      Deno.exit(1);
    }
    console.log(`${casesPath} matches (${cases.length} cases)`);
  }
}
