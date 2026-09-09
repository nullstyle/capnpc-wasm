const contentTypes: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
  wasm: "application/wasm",
  capnp: "text/plain; charset=utf-8",
};

export async function serveStudio(request: Request): Promise<Response> {
  let path: string;
  try {
    path = decodeURIComponent(new URL(request.url).pathname);
  } catch {
    return new Response("Invalid path", { status: 400 });
  }
  // Retain links to the previous browser example.
  if (
    path === "/examples/browser/" || path === "/examples/browser/index.html"
  ) {
    return Response.redirect(new URL("/", request.url));
  }
  if (path === "/") path = "/index.html";
  if (
    /[\\\0]/.test(path) ||
    path.split("/").some((part) => part === "." || part === "..")
  ) {
    return new Response("Not found", { status: 404 });
  }
  try {
    return new Response(await Deno.readFile(`dist/studio${path}`), {
      headers: {
        "content-type": contentTypes[path.split(".").pop()!] ??
          "application/octet-stream",
        "x-content-type-options": "nosniff",
        "cache-control": "no-cache",
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
}

if (import.meta.main) {
  const port = Number(Deno.args[0] ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Pass a port from 1 to 65535.");
  }
  Deno.serve({ hostname: "127.0.0.1", port }, serveStudio);
  console.log(`Open Schema Studio at http://127.0.0.1:${port}/`);
}
