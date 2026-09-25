// Self-checks for the shared harness that need no build and no permissions.
import {
  assert,
  assertBytesEqual,
  assertTextEqual,
  assertTreesEqual,
  firstDifference,
  hexWindow,
  textOf,
  unifiedDiff,
} from "./assert.ts";
import { asTree } from "./fs.ts";
import { TRAP_TEXT } from "./hosts.ts";
import { clangxx, normalizeDiagnostic } from "./oracle.ts";
import { ldflags } from "./process.ts";
import {
  parseTimeoutScale,
  scaleTimeout,
  timeoutScale,
} from "./timeout-scale.ts";

const encode = (text: string) => new TextEncoder().encode(text);

function failure(body: () => void | Promise<void>): Promise<string> {
  return Promise.resolve()
    .then(body)
    .then(() => {
      throw new Error("expected the assertion to fail");
    }, (error: Error) => error.message);
}

Deno.test("firstDifference finds the offset or reports identity", () => {
  assert(firstDifference(encode("abc"), encode("abc")) === -1, "identical");
  assert(firstDifference(encode("abc"), encode("abd")) === 2, "last byte");
  assert(firstDifference(encode("ab"), encode("abc")) === 2, "shorter");
  assert(firstDifference(encode(""), encode("")) === -1, "empty");
});

Deno.test("hexWindow marks the offset and the end of input", () => {
  assert(
    hexWindow(new Uint8Array([1, 2, 3]), 1) === "00000000: 01 [02] 03",
    hexWindow(new Uint8Array([1, 2, 3]), 1),
  );
  assert(
    hexWindow(new Uint8Array([1]), 1).endsWith("01 [end]"),
    "end marker",
  );
});

Deno.test("textOf rejects NUL bytes and invalid UTF-8", () => {
  assert(textOf(encode("plain")) === "plain", "text");
  assert(textOf(new Uint8Array([0x61, 0])) === null, "NUL");
  assert(textOf(new Uint8Array([0xff, 0xfe])) === null, "invalid UTF-8");
});

Deno.test("assertBytesEqual reports the offset, a hex window and a diff", async () => {
  const message = await failure(() =>
    assertBytesEqual(
      encode("one\ntwo\nthree\n"),
      encode("one\n2\nthree\n"),
      "sample",
    )
  );
  assert(
    message.startsWith(
      "sample: differs at byte 4 (actual 14 bytes, expected 12 bytes)",
    ),
    message,
  );
  assert(message.includes("[74]") && message.includes("[32]"), message);
  assert(message.includes("-two") && message.includes("+2"), message);
  assert(message.includes(" one") && message.includes(" three"), message);
});

Deno.test("assertTextEqual and unifiedDiff cap and trim", async () => {
  const message = await failure(() =>
    assertTextEqual("a\nb\n", "a\nc\n", "text")
  );
  assert(message.includes("-b") && message.includes("+c"), message);
  const a = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n");
  const b = a.replace("line 150", "changed");
  const diff = unifiedDiff(a, b);
  assert(diff.includes("line 151 differs"), diff);
  assert(diff.includes("-line 150") && diff.includes("+changed"), diff);
  assert(diff.split("\n").length < 20, "common prefix and suffix trimmed");
  const large = Array.from({ length: 500 }, (_, i) => `${i}`).join("\n");
  const capped = unifiedDiff(large, "");
  assert(capped.includes("more diff lines"), capped);
});

Deno.test("assertTreesEqual lists missing, extra and changed paths", async () => {
  const message = await failure(() =>
    assertTreesEqual(
      {
        "same.txt": encode("x"),
        "changed.txt": encode("a"),
        "extra.txt": encode("e"),
      },
      {
        "same.txt": encode("x"),
        "changed.txt": encode("b"),
        "missing.txt": encode("m"),
      },
      "trees",
    )
  );
  assert(message.includes("missing: missing.txt"), message);
  assert(message.includes("extra: extra.txt"), message);
  assert(message.includes("changed: changed.txt"), message);
  assert(message.includes("changed.txt: differs at byte 0"), message);
  await assertTreesEqual(
    asTree({ "b": encode("1"), "a": encode("2") }),
    new Map([["a", encode("2")], ["b", encode("1")]]),
    "order-insensitive",
  );
});

Deno.test("normalizeDiagnostic strips prefixes, masks ids and drops stack lines", () => {
  const native = [
    "build/test/toolchain-1/input/invalid/missing-id.capnp:1:1: error: Add @0x8d934a9c4099e00a;",
    "stack: 1004c71e7 100483a1b",
    "/native/bin/capnp compile: --bogus: unrecognized option",
  ].join("\n");
  const normalized = normalizeDiagnostic(native, {
    stripPrefixes: ["build/test/toolchain-1/input/"],
    programNames: { "/native/bin/capnp": "capnp" },
  });
  assertTextEqual(
    normalized,
    [
      "invalid/missing-id.capnp:1:1: error: Add @0x<id>;",
      "capnp compile: --bogus: unrecognized option",
    ].join("\n"),
    "normalized diagnostic",
  );
});

Deno.test("clangxx keeps the arguments and appends the split LDFLAGS", () => {
  // Without --allow-env there are no LDFLAGS to splice; the shape still holds.
  assert(ldflags().length === 0, "LDFLAGS unreadable here must give no flags");
  const command = clangxx(["-std=c++23", "a.cpp"]);
  assert(
    command[0] === "clang++" && command[1] === "-std=c++23" &&
      command[2] === "a.cpp" && command.length === 3,
    command.join(" "),
  );
});

Deno.test("TRAP_TEXT matches runtime failures and not KJ diagnostics", () => {
  for (
    const text of [
      "Error: failed to run main module `x.wasm`\n\nCaused by:\n    2: wasm trap: wasm `unreachable` instruction executed",
      "wazero-run: module[] function[_start] failed: wasm error: unreachable",
      "deno-wasi-run: unreachable",
      "terminating due to uncaught exception of type kj::Exception",
    ]
  ) assert(TRAP_TEXT.test(text), `should match: ${text}`);
  for (
    const text of [
      "*** Uncaught exception ***\nkj/io.c++:53: failed: expected n >= minBytes [0 >= 8]; Premature EOF",
      "invalid/syntax.capnp:3:13: error: Parse error.",
      "capnpc-rust: Premature end of file",
      "Error parsing CodeGeneratorRequest: error.TruncatedMessage\nerror: TruncatedMessage",
    ]
  ) assert(!TRAP_TEXT.test(text), `should not match: ${text}`);
});

Deno.test("CAPNP_TEST_TIMEOUT_SCALE: unset is 1, a positive number scales, anything else fails", async () => {
  for (const unset of [undefined, "", "  "]) {
    assert(parseTimeoutScale(unset) === 1, `${JSON.stringify(unset)} is not 1`);
  }
  for (const [value, factor] of [["3", 3], ["1.5", 1.5], ["0.5", 0.5]]) {
    assert(
      parseTimeoutScale(value as string) === factor,
      `${value} is not ${factor}`,
    );
  }
  for (const bad of ["0", "-1", "abc", "3x", "Infinity", "NaN"]) {
    const message = await failure(() => {
      parseTimeoutScale(bad);
    });
    assert(
      message.includes("CAPNP_TEST_TIMEOUT_SCALE must be a positive number"),
      `${bad} was accepted: ${message}`,
    );
  }
  assert(
    scaleTimeout(60_000, 3) === 180_000 && scaleTimeout(10, 1.25) === 13 &&
      scaleTimeout(60_000, 1) === 60_000,
    "scaleTimeout",
  );
  // This task grants no environment access: the factor is read only where the
  // variable may be read, so here it is 1 whatever the variable says.
  assert(timeoutScale === 1, `timeoutScale ${timeoutScale} without permission`);
});
