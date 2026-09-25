// The Schema Studio compiler adapter with the SDK class it throws, bundled
// together for the browser conformance rows so `instanceof CompileError`
// refers to the adapter's own SDK copy. Bundled at test time with the pinned
// Deno (`deno bundle --platform browser`), like build-studio.ts bundles the
// application; the built site is Studio's own driver's concern.
export { studioCompiler } from "../../examples/browser/compiler.js";
export { CompileError } from "../../sdk/typescript/mod.ts";
