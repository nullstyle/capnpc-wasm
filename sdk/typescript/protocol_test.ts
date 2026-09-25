import {
  decodeError,
  encodeError,
  postReply,
  type WorkerReply,
} from "./protocol.ts";
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
  const limited = decodeError(encodeError(
    new CompileError("over", "zig", [], undefined, {
      kind: "limit",
      limit: "outputBytes",
    }),
  ));
  assert(
    limited instanceof CompileError && limited.kind === "limit" &&
      limited.limit === "outputBytes" && limited.exitCode === undefined,
    `limit round trip: ${JSON.stringify(limited)}`,
  );
  assert(
    (compile as CompileError).kind === "exit" &&
      (compile as CompileError).limit === undefined,
    "exit kind lost",
  );
  // Unknown or missing wire values fall back to the constructor's defaults.
  const unknown = decodeError({
    kind: "compile",
    message: "m",
    stage: "cpp",
    diagnostics: [],
    failure: "bogus" as never,
    limit: "nope" as never,
  });
  assert(
    unknown instanceof CompileError && unknown.kind === "trap" &&
      unknown.limit === undefined,
    `unknown kind: ${JSON.stringify(unknown)}`,
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
  // A job the worker stopped at its deadline or through the shared cell
  // arrives as the DOMException the direct path throws.
  for (const name of ["TimeoutError", "AbortError"]) {
    const cancelled = decodeError(encodeError(new DOMException("t", name)));
    assert(
      cancelled instanceof DOMException && cancelled.name === name &&
        cancelled.message === "t",
      `${name} round trip: ${cancelled}`,
    );
  }
  const named = decodeError(
    encodeError(new DOMException("n", "NotSupportedError")),
  );
  assert(
    named instanceof Error && !(named instanceof DOMException) &&
      named.name === "NotSupportedError" && named.message === "n",
    "named error round trip",
  );
  const plain = decodeError(encodeError("just text"));
  assert(
    plain instanceof Error && plain.message === "just text",
    "non-Error value",
  );
});

Deno.test("worker replies the engine refuses are answered with the failure", () => {
  const posted: { data: WorkerReply; transfer?: Transferable[] }[] = [];
  let refuse = true;
  const scope = {
    postMessage(data: WorkerReply, transfer?: Transferable[]) {
      if (refuse) {
        refuse = false;
        throw new DOMException("could not clone the reply", "DataCloneError");
      }
      posted.push({ data, transfer });
    },
  };
  const buffer = new ArrayBuffer(4);
  postReply(scope, {
    id: 7,
    result: { request: new Uint8Array(buffer) },
  } as WorkerReply, () => [buffer]);
  assert(posted.length === 1, `${posted.length} replies posted`);
  const [{ data, transfer }] = posted;
  assert(
    data.id === 7 && data.error !== undefined && transfer === undefined,
    `unexpected fallback reply: ${JSON.stringify(data)}`,
  );
  const error = decodeError(data.error!);
  assert(
    error.message === "worker reply could not be posted" &&
      (error.cause as Error)?.name === "DataCloneError",
    `fallback lost its cause: ${error.message}`,
  );
  // A reply the engine accepts is posted once, with its transfer list.
  postReply(scope, { id: 8, result: {} } as WorkerReply, () => [buffer]);
  assert(
    (posted.length as number) === 2 && posted[1].data.id === 8 &&
      posted[1].transfer?.[0] === buffer,
    "an accepted reply was changed",
  );
});
