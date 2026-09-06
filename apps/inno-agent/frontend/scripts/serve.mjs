// Static dev server for the exported SPA (`out/`).
//
// Because `output: 'export'` produces a pure static bundle and we never run
// `next start`, this script host `out/` and — on a per-path basis — proxies
// `/api` and `/health` to the backend on `:3000`. This is the zero-backend-
// change way to hit the real API from a static host without CORS headers:
//   1. `npm run build`   (produces `out/`)
//   2. `npm run serve:static`  → serves on :4173, proxies /api → :3000
//
// Node >= 20 built-ins only; no dependencies. Backend origin overridable via
// `BACKEND_URL` env (default http://127.0.0.1:3000).

import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(__dirname, "../out");
const port = Number(process.env.PORT || 4173);
const backend = process.env.BACKEND_URL || "http://127.0.0.1:3000";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain",
};

function contentType(file) {
  return MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
}

// NB: static hosts cannot proxy; this script is the dev/host proxy layer the
// plan describes (§3.1 option ②). For same-origin hosting (backend serves
// `out/`) the backend's own `/api` routes are used instead.
async function proxyRequest(req, res) {
  const target = new URL(req.url, backend);
  const upstream = await fetch(target, {
    method: req.method,
    headers: {
      ...(req.headers["content-type"]
        ? { "content-type": req.headers["content-type"] }
        : {}),
    },
    body: req.method === "GET" || req.method === "HEAD" ? undefined : req,
    duplex: req.method === "GET" || req.method === "HEAD" ? undefined : "half",
  });

  res.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") || "application/json",
    ...(upstream.headers.get("content-length")
      ? { "content-length": upstream.headers.get("content-length") }
      : {}),
  });
  if (req.method === "HEAD") return res.end();
  // Stream the body through instead of buffering it. `/chat/stream` (and other
  // SSE routes) must reach the browser incrementally; a full `arrayBuffer()`
  // would swallow the whole response first, so a long turn would look hung and
  // no incremental text would render.
  const upstreamBody = upstream.body;
  if (!upstreamBody) return res.end();
  for await (const chunk of upstreamBody) {
    if (chunk) res.write(chunk);
  }
  res.end();
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname.startsWith("/api") || url.pathname === "/health") {
      return proxyRequest(req, res);
    }

    let pathname = decodeURIComponent(url.pathname);
    // Trailing-slash export → default to index.html for directory routes.
    if (pathname.endsWith("/")) pathname = pathname + "index.html";
    let file = path.join(outDir, pathname);

    if (!file.startsWith(outDir)) {
      res.writeHead(403).end("Forbidden");
      return;
    }

    try {
      const stat = await fs.stat(file);
      if (stat.isDirectory()) file = path.join(file, "index.html");
    } catch {
      // Fall through to SPA fallback below.
    }

    try {
      const data = await fs.readFile(file);
      res.writeHead(200, { "content-type": contentType(file) });
      res.end(data);
      return;
    } catch {
      // SPA fallback: unknown route → index.html (client router resolves it).
      const fallback = path.join(outDir, "index.html");
      const data = await fs.readFile(fallback);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(data);
    }
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(String(err));
  }
});

server.listen(port, () => {
  console.log(`[inno-frontend] static: http://127.0.0.1:${port}`);
  console.log(`[inno-frontend] api proxy: ${backend} → /api`);
});
