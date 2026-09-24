// A static file server for dist/studio, used by `mise run example:browser` and
// by the Studio browser test. It serves public files only; schemas and
// compilation results never leave the browser.
const contentTypes: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
  wasm: "application/wasm",
  capnp: "text/plain; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
};

// Loopback names only: a page on another origin that resolves its own name to
// 127.0.0.1 (DNS rebinding) gets no content from this server.
const allowedHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

// index.html carries the page's own Content-Security-Policy in a meta tag so
// any static host applies it; these headers add what a meta tag cannot carry
// (frame-ancestors) and the cross-origin and referrer policies.
export const securityHeaders: Record<string, string> = {
  "content-security-policy": "frame-ancestors 'none'",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

function contentType(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const known = dot >= 0 ? contentTypes[name.slice(dot + 1).toLowerCase()] : "";
  if (known) return known;
  // License texts ship without extensions.
  if (path.startsWith("/assets/licenses/")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

export function hostAllowed(host: string | null): boolean {
  if (!host) return false;
  const name = host.startsWith("[")
    ? host.slice(0, host.indexOf("]") + 1)
    : host.split(":")[0];
  return allowedHosts.has(name.toLowerCase());
}

export async function serveStudio(request: Request): Promise<Response> {
  if (!hostAllowed(request.headers.get("host"))) {
    return new Response("Misdirected request", {
      status: 421,
      headers: securityHeaders,
    });
  }
  let path: string;
  try {
    path = decodeURIComponent(new URL(request.url).pathname);
  } catch {
    return new Response("Invalid path", {
      status: 400,
      headers: securityHeaders,
    });
  }
  // Retain links to the previous browser example.
  if (
    path === "/examples/browser/" || path === "/examples/browser/index.html"
  ) {
    return Response.redirect(new URL("/", request.url));
  }
  if (path === "/") path = "/index.html";
  // Dot-prefixed names cover the build's staging directories as well as any
  // hidden file; none of them is part of the site.
  if (
    /[\\\0]/.test(path) ||
    path.split("/").some((part) =>
      part === "." || part === ".." ||
      part.startsWith(".")
    )
  ) {
    return new Response("Not found", { status: 404, headers: securityHeaders });
  }
  try {
    return new Response(await Deno.readFile(`dist/studio${path}`), {
      headers: {
        ...securityHeaders,
        "content-type": contentType(path),
        "cache-control": "no-cache",
      },
    });
  } catch (error) {
    if (
      error instanceof Deno.errors.NotFound ||
      error instanceof Deno.errors.IsADirectory
    ) {
      return new Response("Not found", {
        status: 404,
        headers: securityHeaders,
      });
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
