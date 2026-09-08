import { createCompiler } from "./mod.ts";
import { CompileError, type Compiler } from "./types.ts";

let compiler: Compiler | undefined;
const scope = self as unknown as {
  onmessage: (event: MessageEvent) => void;
  postMessage: (data: unknown) => void;
};
scope.onmessage = async ({ data }) => {
  try {
    let result;
    if (data.kind === "init") {
      compiler = await createCompiler(data.modules);
    } else if (data.kind === "compile" && compiler) {
      result = await compiler.compile(data.request);
    } else if (data.kind === "generate" && compiler) {
      result = await compiler.generate(data.request);
    } else throw new Error("worker is not initialized or message is invalid");
    scope.postMessage({ id: data.id, result });
  } catch (cause) {
    const error = cause instanceof CompileError
      ? {
        name: cause.name,
        message: cause.message,
        stage: cause.stage,
        diagnostics: cause.diagnostics,
        exitCode: cause.exitCode,
      }
      : {
        name: cause instanceof Error ? cause.name : "Error",
        message: String(cause),
      };
    scope.postMessage({ id: data.id, error });
  }
};
