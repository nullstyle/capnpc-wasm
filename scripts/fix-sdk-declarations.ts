// Deno's declaration bundle promotes declarations from internal dependency
// modules to exports. Preserve every declaration, then export only symbols
// resolved from the SDK's actual entrypoint by the pinned Deno doc parser.
// No list of public names is maintained separately from mod.ts.

export function publicNames(document: unknown): string[] {
  const doc = document as {
    version?: unknown;
    nodes?: Record<string, { symbols?: { name?: unknown }[] }>;
  };
  const modules = doc?.nodes && Object.values(doc.nodes);
  if (doc?.version !== 2 || !modules || modules.length !== 1) {
    throw new Error("unexpected Deno doc format for the SDK entrypoint");
  }
  const symbols = modules[0].symbols;
  if (!Array.isArray(symbols) || symbols.length === 0) {
    throw new Error("Deno doc found no SDK public symbols");
  }
  const names = symbols.map((symbol) => {
    if (
      typeof symbol.name !== "string" || !/^[A-Za-z_$][\w$]*$/.test(symbol.name)
    ) {
      throw new Error("Deno doc returned an unsupported public symbol name");
    }
    return symbol.name;
  });
  return [...new Set(names)].sort();
}

export function fixDeclarations(
  text: string,
  names: readonly string[],
): string {
  const declarations = new Set<string>();
  const body = text.replace(
    /^export ((?:declare )?(?:const|type|interface|class|function) ([A-Za-z_$][\w$]*))/gm,
    (_, declaration: string, name: string) => {
      declarations.add(name);
      return declaration;
    },
  );
  if (/^export\b/m.test(body)) {
    throw new Error("unsupported export in the SDK declaration bundle");
  }
  for (const name of names) {
    if (!declarations.has(name)) {
      throw new Error(
        `public SDK symbol ${name} is missing from the declarations`,
      );
    }
  }
  return `${body.trimEnd()}\n\nexport { ${names.join(", ")} };\n`;
}

export function publicValueNames(document: unknown): string[] {
  publicNames(document);
  const doc = document as {
    nodes: Record<string, {
      symbols: { name: string; declarations: { kind: string }[] }[];
    }>;
  };
  return Object.values(doc.nodes)[0].symbols.filter((symbol) =>
    symbol.declarations.some((declaration) =>
      ["function", "variable", "class", "enum"].includes(declaration.kind)
    )
  ).map((symbol) => symbol.name).sort();
}

export async function publicDocument(
  path: string,
  source = false,
): Promise<unknown> {
  const result = await new Deno.Command(Deno.execPath(), {
    args: [
      "doc",
      "--json",
      "--no-remote",
      "--no-npm",
      ...(source
        ? ["--config", "sdk/typescript/deno.json", "--unstable-sloppy-imports"]
        : ["--no-config"]),
      path,
    ],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
  return JSON.parse(new TextDecoder().decode(result.stdout));
}

if (import.meta.main) {
  if (Deno.args.length !== 1) {
    throw new Error("usage: fix-sdk-declarations.ts <staged mod.d.ts>");
  }
  const names = publicNames(
    await publicDocument("sdk/typescript/mod.ts", true),
  );
  const path = Deno.args[0];
  await Deno.writeTextFile(
    path,
    fixDeclarations(await Deno.readTextFile(path), names),
  );
}
