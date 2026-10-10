// Compare the shipped TypeScript declarations and Go's complete public docs
// with the reviewed 0.1.0 API baseline. Tool pins make the printers repeatable.
// A difference requires contract, stability-policy, and changelog review before
// updating the baseline; this check does not decide semantic compatibility.
//
// Usage: mise run test:sdk-api [-- --write]
// --write is an explicit baseline update, never part of CI.

import {
  publicDocument,
  publicNames,
  publicValueNames,
} from "./fix-sdk-declarations.ts";

const directory = "tests/fixtures/contract";
const names = ["typescript-api.d.ts", "go-api.txt"] as const;
export type Api = Record<(typeof names)[number], string>;

async function output(command: string, args: string[]): Promise<string> {
  const result = await new Deno.Command(command, {
    args,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return new TextDecoder().decode(result.stdout).replaceAll("\r\n", "\n");
}

export async function captureSdkApi(): Promise<Api> {
  const [source, declarations] = await Promise.all([
    publicDocument("sdk/typescript/mod.ts", true),
    publicDocument("dist/typescript/mod.d.ts"),
  ]);
  if (
    JSON.stringify(publicNames(source)) !==
      JSON.stringify(publicNames(declarations)) ||
    JSON.stringify(publicValueNames(source)) !==
      JSON.stringify(publicValueNames(declarations))
  ) {
    throw new Error(
      "the shipped declarations do not export the SDK entrypoint's public symbols",
    );
  }
  const runtime = await import(
    new URL("../dist/typescript/mod.js", import.meta.url).href
  );
  if (
    JSON.stringify(Object.keys(runtime).sort()) !==
      JSON.stringify(publicValueNames(source))
  ) {
    throw new Error(
      "the shipped JavaScript does not export the SDK entrypoint's public values",
    );
  }
  // Format the declarations with the same pinned formatter that checks the
  // fixture; bundler formatting alone is not a supported interface.
  const formatter = new Deno.Command(Deno.execPath(), {
    args: ["fmt", "--ext=ts", "-"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = formatter.stdin.getWriter();
  await writer.write(await Deno.readFile("dist/typescript/mod.d.ts"));
  await writer.close();
  const formatted = await formatter.output();
  if (!formatted.success) {
    throw new Error(new TextDecoder().decode(formatted.stderr));
  }
  return {
    "typescript-api.d.ts": new TextDecoder().decode(formatted.stdout)
      .replaceAll("\r\n", "\n"),
    "go-api.txt": await output("go", ["-C", "sdk/go", "doc", "-all", "."]),
  };
}

export function apiProblems(actual: Api, expected: Api): string[] {
  return names.flatMap((name) => {
    if (actual[name] === expected[name]) return [];
    const lines = actual[name].split("\n");
    const baseline = expected[name].split("\n");
    const line = Array.from({ length: Math.max(lines.length, baseline.length) })
      .findIndex((_, index) => lines[index] !== baseline[index]) + 1;
    return [`${directory}/${name}: public API differs at line ${line}`];
  });
}

export async function checkSdkApi(): Promise<void> {
  const expected = Object.fromEntries(
    await Promise.all(
      names.map(async (
        name,
      ) => [name, await Deno.readTextFile(`${directory}/${name}`)]),
    ),
  ) as Api;
  const problems = apiProblems(await captureSdkApi(), expected);
  if (problems.length) {
    throw new Error(
      `${
        problems.join("\n")
      }\nReview docs/sdk-contract.md, docs/api-stability.md, and CHANGELOG.md before updating the baseline with mise run test:sdk-api -- --write.`,
    );
  }
}

if (import.meta.main) {
  if (Deno.args.length === 1 && Deno.args[0] === "--write") {
    const actual = await captureSdkApi();
    for (const name of names) {
      await Deno.writeTextFile(`${directory}/${name}`, actual[name]);
    }
    console.log(
      "Updated the TypeScript and Go API baselines; review the diff.",
    );
  } else if (Deno.args.length) {
    throw new Error("usage: check-sdk-api.ts [--write]");
  } else {
    await checkSdkApi();
    console.log("TypeScript and Go public APIs match the reviewed baseline.");
  }
}
