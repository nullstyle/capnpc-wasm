// Assertions shared by the Deno test suites. Byte and tree mismatches report
// what to look at: the first differing offset with a hex window, or the
// missing, extra and changed paths plus a unified diff of the first changed
// text file.

import { asTree, readTree, type Tree, type TreeLike } from "./fs.ts";

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Index of the first differing byte, or -1 when the arrays are identical. */
export function firstDifference(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    if (a[i] !== b[i]) return i;
  }
  return a.length === b.length ? -1 : length;
}

/** Hex bytes around an offset, with the offset's byte marked. */
export function hexWindow(
  bytes: Uint8Array,
  offset: number,
  radius = 16,
): string {
  const start = Math.max(0, offset - radius);
  const end = Math.min(bytes.length, offset + radius);
  const cells: string[] = [];
  for (let i = start; i < end; i++) {
    const hex = bytes[i].toString(16).padStart(2, "0");
    cells.push(i === offset ? `[${hex}]` : hex);
  }
  if (offset >= bytes.length) cells.push("[end]");
  return `${start.toString(16).padStart(8, "0")}: ${cells.join(" ")}`;
}

const strictDecoder = new TextDecoder("utf-8", { fatal: true });

/** Decodes bytes as UTF-8 text, or returns null for invalid UTF-8 or NUL bytes. */
export function textOf(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return strictDecoder.decode(bytes);
  } catch {
    return null;
  }
}

/** Fails with the first differing offset and, for text, a unified diff. */
export function assertBytesEqual(
  actual: Uint8Array,
  expected: Uint8Array,
  label: string,
): void {
  const offset = firstDifference(actual, expected);
  if (offset === -1) return;
  const lines = [
    `${label}: differs at byte ${offset} (actual ${actual.length} bytes, expected ${expected.length} bytes)`,
    `  actual   ${hexWindow(actual, offset)}`,
    `  expected ${hexWindow(expected, offset)}`,
  ];
  const actualText = textOf(actual);
  const expectedText = textOf(expected);
  if (actualText !== null && expectedText !== null) {
    lines.push(unifiedDiff(actualText, expectedText, "actual", "expected"));
  }
  throw new Error(lines.join("\n"));
}

/** Fails with a unified diff when two texts differ. */
export function assertTextEqual(
  actual: string,
  expected: string,
  label: string,
): void {
  if (actual === expected) return;
  throw new Error(
    `${label}: text differs\n${
      unifiedDiff(actual, expected, "actual", "expected")
    }`,
  );
}

/**
 * Compares two trees (directories or in-memory file maps). The failure lists
 * paths missing from `actual`, paths only in `actual`, and changed paths, then
 * shows the first changed file the way assertBytesEqual does.
 */
export async function assertTreesEqual(
  actual: string | TreeLike,
  expected: string | TreeLike,
  label: string,
): Promise<void> {
  const left = typeof actual === "string"
    ? await readTree(actual)
    : asTree(actual);
  const right = typeof expected === "string"
    ? await readTree(expected)
    : asTree(expected);
  const missing = [...right.keys()].filter((name) => !left.has(name));
  const extra = [...left.keys()].filter((name) => !right.has(name));
  const changed = [...right.keys()].filter((name) =>
    left.has(name) && firstDifference(left.get(name)!, right.get(name)!) !== -1
  );
  if (missing.length === 0 && extra.length === 0 && changed.length === 0) {
    return;
  }
  const lines = [`${label}: generated trees differ`];
  if (missing.length > 0) lines.push(`  missing: ${missing.join(", ")}`);
  if (extra.length > 0) lines.push(`  extra: ${extra.join(", ")}`);
  if (changed.length > 0) lines.push(`  changed: ${changed.join(", ")}`);
  if (typeof actual === "string") lines.push(`  actual tree: ${actual}`);
  if (typeof expected === "string") lines.push(`  expected tree: ${expected}`);
  if (changed.length > 0) {
    try {
      assertBytesEqual(
        left.get(changed[0])!,
        right.get(changed[0])!,
        changed[0],
      );
    } catch (error) {
      lines.push((error as Error).message);
    }
  }
  throw new Error(lines.join("\n"));
}

/** Convenience: the tree at a directory must contain exactly these paths. */
export function treePaths(tree: Tree): string[] {
  return [...tree.keys()];
}

/**
 * A unified diff of two texts. Common leading and trailing lines are trimmed
 * first; the remaining middle is diffed by longest common subsequence when it
 * is small enough, and otherwise shown as one replacement hunk. Output is
 * capped so a failure message stays readable.
 */
export function unifiedDiff(
  actual: string,
  expected: string,
  actualName = "actual",
  expectedName = "expected",
  context = 3,
  maxLines = 120,
): string {
  const a = splitLines(actual);
  const b = splitLines(expected);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < a.length - prefix && suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) suffix++;
  const middleA = a.slice(prefix, a.length - suffix);
  const middleB = b.slice(prefix, b.length - suffix);
  const ops = middleA.length * middleB.length <= 4_000_000
    ? lcsOps(middleA, middleB)
    : [
      ...middleA.map((line) => ["-", line] as Op),
      ...middleB.map((line) => ["+", line] as Op),
    ];
  const before = a.slice(Math.max(0, prefix - context), prefix);
  const after = a.slice(a.length - suffix, a.length - suffix + context);
  const body = [
    ...before.map((line) => ` ${line}`),
    ...ops.map(([kind, line]) => `${kind}${line}`),
    ...after.map((line) => ` ${line}`),
  ];
  const aStart = prefix - before.length + 1;
  const bStart = prefix - before.length + 1;
  const aCount = before.length + middleA.length + after.length;
  const bCount = before.length + middleB.length + after.length;
  const header = [
    `--- ${actualName} (line ${prefix + 1} differs)`,
    `+++ ${expectedName}`,
    `@@ -${aStart},${aCount} +${bStart},${bCount} @@`,
  ];
  const shown = body.slice(0, maxLines);
  if (body.length > maxLines) {
    shown.push(`... (${body.length - maxLines} more diff lines)`);
  }
  return [...header, ...shown].join("\n");
}

type Op = [" " | "-" | "+", string];

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function lcsOps(a: string[], b: string[]): Op[] {
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j]
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push([" ", a[i]]);
      i++;
      j++;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      ops.push(["-", a[i++]]);
    } else {
      ops.push(["+", b[j++]]);
    }
  }
  while (i < a.length) ops.push(["-", a[i++]]);
  while (j < b.length) ops.push(["+", b[j++]]);
  return ops;
}
