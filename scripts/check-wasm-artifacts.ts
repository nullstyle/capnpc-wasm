// The contract every shipped Wasm command module meets. `mise run
// check:wasm-artifacts` checks dist/wasm, each build script checks the module
// it just linked (--module), and tests/toolchain_test.ts imports the feature
// profile, so the profile has one definition.
//
// - Feature profile: wasm-tools validates the module with every proposal
//   disabled except the class's allow-list, and a module that declares
//   target_features must declare exactly the recorded set. A toolchain bump
//   that starts emitting another proposal fails here instead of silently
//   raising the minimum engine version.
// - Sections: no DWARF (`.debug_*`); the C++ modules keep their name section
//   so engine traps stay symbolized.
// - Paths: no build-host paths, so the bytes are the same from any checkout.
// - Size: a budget per module, so debug data or a larger runtime cannot
//   reappear unnoticed.

export type ModuleClass = "cpp" | "generator";

export interface FeatureProfile {
  /**
   * wasm-tools feature names the module may use. Everything else, including
   * the proposals wasm-tools enables by default, is disabled during
   * validation.
   */
  features: readonly string[];
  /**
   * The exact `target_features` section the class declares, or null when the
   * class emits none. The C++ modules declare what the SDK 34 sysroot's
   * objects were compiled with; `bulk-memory` and `extended-const` are
   * declared but no instruction of theirs is emitted, so they stay out of
   * `features`.
   */
  declared: readonly string[] | null;
}

/**
 * The engine baseline. Each feature is part of WebAssembly 2.0 except
 * `exceptions` (the standardized try_table/exnref proposal) and
 * `call-indirect-overlong` (the reference-types encoding of call_indirect's
 * table index, accepted by every engine that has reference types).
 */
const baseline = [
  "floats",
  "mutable-global",
  "saturating-float-to-int",
  "sign-extension",
  "multi-value",
  "bulk-memory-opt",
  "call-indirect-overlong",
] as const;

export const featureProfiles: Record<ModuleClass, FeatureProfile> = {
  cpp: {
    features: [...baseline, "reference-types", "exceptions"],
    declared: [
      "bulk-memory",
      "bulk-memory-opt",
      "call-indirect-overlong",
      "exception-handling",
      "extended-const",
      "multivalue",
      "mutable-globals",
      "nontrapping-fptoint",
      "reference-types",
      "sign-ext",
    ],
  },
  generator: {
    features: [...baseline],
    declared: null,
  },
};

export interface ModuleContract {
  class: ModuleClass;
  /** Maximum size in bytes; about 10 to 15 percent above the current size. */
  budget: number;
}

export const modules: Record<string, ModuleContract> = {
  capnp: { class: "cpp", budget: 2_300_000 },
  "capnpc-c++": { class: "cpp", budget: 1_950_000 },
  "capnpc-capnp": { class: "cpp", budget: 900_000 },
  "capnpc-rust": { class: "generator", budget: 500_000 },
  "capnpc-go": { class: "generator", budget: 10_000_000 },
  "capnpc-zig": { class: "generator", budget: 1_900_000 },
};

/** The `--features` argument for `wasm-tools validate`. */
export function featureFlag(moduleClass: ModuleClass): string {
  return `--features=-all,${featureProfiles[moduleClass].features.join(",")}`;
}

/**
 * Absolute path prefixes that identify a build host. `/private/` alone would
 * match `capnp/src/private/` inside the remapped Rust paths, so a prefix
 * counts only where a path starts.
 */
const hostPathPattern =
  /(?<![\w./-])(?:\/(?:Users|home|root|tmp|var\/folders|private\/tmp|private\/var)\/[^\0\s"'`]*|[A-Za-z]:\\(?:Users|home)\\[^\0\s"'`]*)/g;

/**
 * The WASI SDK's own build directory. Two libc++abi assertion messages in the
 * prebuilt sysroot name their source file this way; the strings are part of
 * the SDK release and identical on every host.
 */
const sdkBuildPathPrefix =
  "/Users/runner/work/wasi-sdk/wasi-sdk/src/llvm-project/";

interface Sections {
  custom: string[];
  targetFeatures: string[] | null;
}

function readSections(bytes: Uint8Array): Sections {
  const header = [0, 97, 115, 109, 1, 0, 0, 0];
  if (
    bytes.length < 8 || header.some((value, index) => bytes[index] !== value)
  ) {
    throw new Error("not a Wasm module");
  }
  let position = 8;
  const u32 = (end: number) => {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      if (position >= end) throw new Error("truncated section");
      const byte = bytes[position++];
      value += (byte & 127) * 2 ** (7 * i);
      if (!(byte & 128)) return value;
    }
    throw new Error("invalid u32");
  };
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const sections: Sections = { custom: [], targetFeatures: null };
  while (position < bytes.length) {
    const id = bytes[position++];
    const size = u32(bytes.length);
    const end = position + size;
    if (end > bytes.length) throw new Error("truncated section");
    if (id === 0) {
      const nameLength = u32(end);
      const name = decoder.decode(
        bytes.subarray(position, position + nameLength),
      );
      position += nameLength;
      sections.custom.push(name);
      if (name === "target_features") {
        const count = u32(end);
        const features: string[] = [];
        for (let i = 0; i < count; i++) {
          const prefix = String.fromCharCode(bytes[position++]);
          const length = u32(end);
          features.push(
            prefix +
              decoder.decode(bytes.subarray(position, position + length)),
          );
          position += length;
        }
        sections.targetFeatures = features;
      }
    }
    position = end;
  }
  return sections;
}

export interface CheckOptions {
  /** The checkout being built; its absolute path must not appear. */
  root: string;
  /** The home directory; its absolute path must not appear. */
  home?: string;
}

/** Checks one module and returns its problems, empty when it conforms. */
export async function checkModule(
  path: string,
  name: string,
  options: CheckOptions,
): Promise<string[]> {
  const contract = modules[name];
  if (!contract) return [`${name} is not a shipped module`];
  const profile = featureProfiles[contract.class];
  const problems: string[] = [];
  const bytes = await Deno.readFile(path);

  const validation = await new Deno.Command("wasm-tools", {
    args: ["validate", featureFlag(contract.class), path],
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!validation.success) {
    problems.push(
      `uses features outside the ${contract.class} profile [${
        profile.features.join(", ")
      }]: ${new TextDecoder().decode(validation.stderr).trim()}`,
    );
  }

  let sections: Sections;
  try {
    sections = readSections(bytes);
  } catch (error) {
    return [`unreadable module: ${(error as Error).message}`];
  }
  const debug = sections.custom.filter((section) =>
    section.startsWith(".debug")
  );
  if (debug.length > 0) {
    problems.push(`carries DWARF sections ${debug.join(", ")}`);
  }
  if (contract.class === "cpp" && !sections.custom.includes("name")) {
    problems.push("lacks the name section that symbolizes traps");
  }
  const declared = sections.targetFeatures === null
    ? null
    : sections.targetFeatures.map((feature) => feature.replace(/^\+/, ""))
      .sort();
  if (profile.declared === null) {
    if (declared !== null) {
      problems.push(
        `declares target_features [${
          declared.join(", ")
        }] but the ${contract.class} profile declares none`,
      );
    }
  } else if (declared === null) {
    problems.push("declares no target_features section");
  } else if (
    JSON.stringify(declared) !== JSON.stringify([...profile.declared].sort())
  ) {
    problems.push(
      `declares target_features [${declared.join(", ")}], expected [${
        profile.declared.join(", ")
      }]`,
    );
  }

  const text = new TextDecoder("latin1").decode(bytes);
  const found = new Set<string>();
  for (const match of text.matchAll(hostPathPattern)) {
    if (!match[0].startsWith(sdkBuildPathPrefix)) found.add(match[0]);
  }
  for (const literal of [options.root, options.home]) {
    if (literal && text.includes(literal)) found.add(literal);
  }
  if (found.size > 0) {
    const sample = [...found].slice(0, 5);
    problems.push(
      `embeds build-host paths (${found.size}): ${sample.join(", ")}`,
    );
  }

  if (bytes.length > contract.budget) {
    problems.push(
      `is ${bytes.length} bytes, over its ${contract.budget}-byte budget`,
    );
  }
  return problems;
}

function usage(): never {
  console.error(
    "usage: check-wasm-artifacts.ts [--dir <directory>] | --module <path>...",
  );
  Deno.exit(2);
}

if (import.meta.main) {
  const args = [...Deno.args];
  let directory = "dist/wasm";
  const paths: string[] = [];
  while (args.length > 0) {
    const arg = args.shift()!;
    if (arg === "--dir") {
      directory = args.shift() ?? usage();
    } else if (arg === "--module") {
      if (args.length === 0) usage();
      paths.push(...args.splice(0));
    } else {
      usage();
    }
  }
  if (paths.length === 0) {
    for (const name of Object.keys(modules)) {
      paths.push(`${directory}/${name}.wasm`);
    }
  }
  const options: CheckOptions = {
    root: Deno.realPathSync("."),
    home: Deno.env.get("HOME") || undefined,
  };
  let failed = false;
  for (const path of paths) {
    const name = path.slice(path.lastIndexOf("/") + 1).replace(/\.wasm$/, "");
    let problems: string[];
    try {
      problems = await checkModule(path, name, options);
    } catch (error) {
      problems = [(error as Error).message];
    }
    if (problems.length === 0) {
      const size = (await Deno.stat(path)).size;
      console.log(
        `ok ${path}: ${modules[name].class} profile, ${size} of ${
          modules[name].budget
        } bytes`,
      );
    } else {
      failed = true;
      for (const problem of problems) console.error(`${path}: ${problem}`);
    }
  }
  if (failed) Deno.exit(1);
}
