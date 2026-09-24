import { decodeError, encodeError } from "./protocol.ts";
import { CompileError } from "./types.ts";
import { assert } from "./testdata/support.ts";

function chainDepth(error: Error): number {
  let depth = 0;
  let cause: unknown = error.cause;
  while (cause instanceof Error) {
    depth++;
    cause = cause.cause;
  }
  return depth;
}

Deno.test("SDK protocol decoding is total and bounds cause chains", () => {
  const cycle: Record<string, unknown> = { name: "CycleError", message: "l" };
  cycle.cause = cycle;
  const cyclic = decodeError({
    kind: "type",
    message: "top",
    cause: cycle as never,
  });
  assert(
    cyclic instanceof TypeError && cyclic.message === "top" &&
      chainDepth(cyclic) === 8 && (cyclic.cause as Error).name === "CycleError",
    `cyclic cause: ${cyclic} depth ${chainDepth(cyclic)}`,
  );

  let deep: Record<string, unknown> = { name: "Leaf", message: "leaf" };
  for (let i = 0; i < 100_000; i++) {
    deep = { name: "Link", message: String(i), cause: deep };
  }
  const long = decodeError({
    kind: "compile",
    message: "m",
    stage: "cpp",
    diagnostics: [],
    cause: deep as never,
  });
  assert(
    long instanceof CompileError && long.stage === "cpp" &&
      chainDepth(long) === 8,
    "deep cause chain was not bounded",
  );

  const odd = decodeError(
    { kind: "error", name: 5, message: undefined, cause: "text" } as never,
  );
  assert(
    odd instanceof Error && odd.name === "Error" &&
      odd.message === "undefined" &&
      odd.cause === undefined,
    `wrong field types: ${odd}`,
  );
  assert(decodeError(null as never) instanceof Error, "null reply");
  const unknownKind = decodeError({ kind: "mystery", message: "m" } as never);
  assert(
    unknownKind instanceof Error && unknownKind.message === "m",
    "unknown kind",
  );
  const noDiagnostics = decodeError(
    { kind: "compile", message: "m", stage: "zig", exitCode: "1" } as never,
  );
  assert(
    noDiagnostics instanceof CompileError &&
      noDiagnostics.diagnostics.length === 0 &&
      noDiagnostics.exitCode === undefined,
    "missing diagnostics and a non-numeric exit code were not normalized",
  );
});

Deno.test("SDK protocol round-trips error classes, fields and causes", () => {
  const inner = new RangeError("deep", { cause: new Error("deeper") });
  const compile = decodeError(encodeError(
    new CompileError("boom", "go", [{ stage: "go", stderr: "x" }], 3, {
      cause: inner,
    }),
  ));
  assert(
    compile instanceof CompileError && compile.stage === "go" &&
      compile.exitCode === 3 && compile.diagnostics[0].stderr === "x" &&
      (compile.cause as Error).name === "RangeError" &&
      ((compile.cause as Error).cause as Error).message === "deeper",
    `compile round trip: ${compile}`,
  );
  const type = decodeError(encodeError(new TypeError("bad input")));
  assert(
    type instanceof TypeError && type.message === "bad input" &&
      type.cause === undefined,
    "TypeError round trip",
  );
  const range = decodeError(encodeError(new RangeError("too big")));
  assert(
    range instanceof RangeError && range.message === "too big",
    "RangeError",
  );
  const named = decodeError(encodeError(new DOMException("t", "TimeoutError")));
  assert(
    named instanceof Error && named.name === "TimeoutError" &&
      named.message === "t",
    "named error round trip",
  );
  const plain = decodeError(encodeError("just text"));
  assert(
    plain instanceof Error && plain.message === "just text",
    "non-Error value",
  );
});
