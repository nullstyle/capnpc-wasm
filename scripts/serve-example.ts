const contentTypes: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  wasm: "application/wasm",
};
Deno.serve({ hostname: "127.0.0.1", port: 8080 }, async (request) => {
  let path: string;
  try {
    path = decodeURIComponent(new URL(request.url).pathname);
  } catch {
    return new Response("Invalid path", { status: 400 });
  }
  if (path === "/") {
    return Response.redirect(new URL("/examples/browser/", request.url));
  }
  if (path === "/examples/browser/") path += "index.html";
  if (
    !["/examples/browser/", "/dist/typescript/", "/dist/wasm/"].some((prefix) =>
      path.startsWith(prefix)
    ) ||
    /[\\\0]/.test(path) || path.split("/").some((part) =>
      part === "." || part === ".."
    )
  ) return new Response("Not found", { status: 404 });
  try {
    return new Response(await Deno.readFile(`.${path}`), {
      headers: {
        "content-type": contentTypes[path.split(".").pop()!] ??
          "application/octet-stream",
      },
    });
  } catch (error) {
    if (
      error instanceof Deno.errors.NotFound ||
      error instanceof Deno.errors.IsADirectory
    ) {
      return new Response("Not found", { status: 404 });
    }
    throw error;
  }
});
console.log("Open http://127.0.0.1:8080/examples/browser/");
