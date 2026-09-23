/**
 * Guest-driven host allocation bounds. Every guest here declares one or two
 * pages of memory and asks the host for far more: iovec arrays, random
 * bytes, descriptors, or writes at pointers outside memory. The SDK must
 * answer each request with an errno (or a clean CompileError) in well under a
 * second and without allocating in proportion to the guest's arguments.
 */
import { CompileError, type CompileResult, createCompiler } from "./mod.ts";
import { hostileGuests } from "./testdata/hostile_guests.ts";
import { assert, equalBytes, rejects } from "./testdata/support.ts";

const rssBudget = 256 * 1024 * 1024;

Deno.test("SDK bounds guest-sized WASI imports on one-page guests", async (t) => {
  for (const [guestName, guest] of Object.entries(hostileGuests)) {
    await t.step(guestName, async () => {
      const rssBefore = Deno.memoryUsage().rss;
      const started = performance.now();
      const compiler = await createCompiler({
        compiler: guest.bytes,
        generators: guest.stage === "generator" ? { cpp: guest.bytes } : {},
      });
      const run = () =>
        guest.stage === "compiler"
          ? compiler.compile({
            files: { a: "x" },
            entrypoints: ["a"],
            generators: [],
          })
          : compiler.generate({
            request: new Uint8Array(1),
            generators: ["cpp"],
          });
      if (guest.expectError) {
        const failure = await rejects(
          run,
          guest.expectError.name,
          guest.expectError.message,
        );
        assert(!("outputs" in failure), `${guestName} exposed outputs`);
        assert(
          failure instanceof CompileError && failure.cause instanceof Error,
          `${guestName} lost its cause`,
        );
      } else {
        const result = await run();
        if (guest.expectRequest) {
          equalBytes(
            (result as CompileResult).request,
            Uint8Array.from(guest.expectRequest),
            `${guestName} reported errnos`,
          );
        }
        if (guest.expectOutputs) {
          const files = result.outputs.cpp!;
          assert(
            Object.getPrototypeOf(files) === Object.prototype &&
              Object.getPrototypeOf(result.outputs) === Object.prototype,
            `${guestName} outputs are not plain objects`,
          );
          assert(
            JSON.stringify(Object.keys(files).sort()) ===
              JSON.stringify(Object.keys(guest.expectOutputs).sort()),
            `${guestName} output names differ: ${Object.keys(files)}`,
          );
          for (const [path, bytes] of Object.entries(guest.expectOutputs)) {
            assert(Object.hasOwn(files, path), `${guestName} lost ${path}`);
            equalBytes(files[path], Uint8Array.from(bytes), path);
          }
          // Guest-chosen names never reach the prototype chain.
          assert(
            Object.getPrototypeOf(files) === Object.prototype &&
              typeof files.hasOwnProperty === "function",
            `${guestName} polluted the result prototype`,
          );
        }
      }
      const elapsed = performance.now() - started;
      assert(elapsed < 1000, `${guestName} took ${elapsed.toFixed(0)} ms`);
      const growth = Deno.memoryUsage().rss - rssBefore;
      assert(
        growth < rssBudget,
        `${guestName} grew RSS by ${(growth / 1048576).toFixed(0)} MiB`,
      );
    });
  }
});
