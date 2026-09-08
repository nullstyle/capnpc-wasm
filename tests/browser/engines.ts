export const engines = ["chromium", "firefox", "webkit"] as const;
export type Engine = typeof engines[number];

export function selectedEngines(args: string[]): Engine[] {
  if (args.length === 0 || (args.length === 1 && args[0] === "all")) {
    return [...engines];
  }
  const selected: Engine[] = [];
  for (const argument of args) {
    if (!engines.some((engine) => engine === argument)) {
      throw new TypeError(
        `Unknown browser ${argument}; use ${engines.join(", ")}, or all`,
      );
    }
    const engine = argument as Engine;
    if (!selected.includes(engine)) selected.push(engine);
  }
  return selected;
}
