// The TypeScript SDK against the shared failure and limit corpus
// (tests/fixtures/conformance): direct execution on the pinned Deno, worker
// execution on the supported worker runtime. The Go SDK, the packaged
// launcher, the browsers, and the Studio adapter run the same corpus against
// the same expectations.
import { defaultLimits } from "./mod.ts";
import { assert, workerTest } from "./testdata/support.ts";
import { runTsSurface } from "../../tests/conformance/ts-surface.ts";

Deno.test("SDK defaultLimits match the contract fixture", async () => {
  const contract = JSON.parse(
    await Deno.readTextFile(
      new URL("../../tests/fixtures/contract/limits.json", import.meta.url),
    ),
  ) as Record<string, number>;
  const actual = JSON.stringify(Object.entries({ ...defaultLimits }).sort());
  const expected = JSON.stringify(Object.entries(contract).sort());
  assert(
    actual === expected,
    `defaultLimits ${actual} differ from tests/fixtures/contract/limits.json ${expected}`,
  );
});

Deno.test("SDK direct execution conforms to the failure and limit corpus", async (t) => {
  await runTsSurface(t, "ts-direct");
});

workerTest(
  "SDK worker execution conforms to the failure and limit corpus",
  async (t) => {
    await runTsSurface(t, "ts-worker");
  },
);
