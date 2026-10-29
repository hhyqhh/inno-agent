import { existsSync, realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";
import { extname, relative, sep } from "node:path";
import { canonicalContainmentRoot, isWithin } from "../utils/path-safety.js";

export const MIME_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".mjs": "application/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	// HarfBuzz uses streaming WASM compilation, which requires this exact MIME.
	".wasm": "application/wasm",
	".otf": "font/otf",
	".ttf": "font/ttf",
	".woff": "font/woff",
	".woff2": "font/woff2",
};

export function isHashedStaticAsset(filePath: string, staticRoot: string): boolean {
	const rel = relative(staticRoot, filePath).split(sep).join("/");
	return /^assets\/.+-[A-Za-z0-9_-]{8,}\.[^.]+$/.test(rel);
}

export function acceptEncodingHeader(req: HttpReq): string {
	const value = req.headers["accept-encoding"];
	return Array.isArray(value) ? value.join(",") : value ?? "";
}

export function encodingAccepted(acceptEncoding: string, encoding: "br" | "gzip"): boolean {
	let wildcardQ: number | undefined;
	for (const part of acceptEncoding.split(",")) {
		const [rawToken, ...params] = part.trim().split(";");
		const token = rawToken.trim().toLowerCase();
		if (!token) continue;
		let q = 1;
		for (const param of params) {
			const [name, value] = param.trim().split("=", 2);
			if (name?.trim().toLowerCase() !== "q") continue;
			const parsed = Number.parseFloat(value?.trim() ?? "");
			q = Number.isFinite(parsed) ? parsed : 0;
			break;
		}
		if (token === encoding) return q > 0;
		if (token === "*") wildcardQ = q;
	}
	return wildcardQ !== undefined ? wildcardQ > 0 : false;
}

export async function serveStatic(req: HttpReq, res: ServerResponse, filePath: string, sendBody = true, staticRoot?: string): Promise<boolean> {
	try {
		if (!existsSync(filePath) || !statSync(filePath).isFile()) return false;
		const ext = extname(filePath);
		const contentType = MIME_TYPES[ext] || "application/octet-stream";
		const acceptEncoding = acceptEncodingHeader(req);
		let responsePath = filePath;
		let contentEncoding: "br" | "gzip" | undefined;
		// The pre-compressed sibling never went through safeJoinReal, so verify
		// its realpath stays inside the static root — a planted symlink like
		// `assets/index.js.gz -> /etc/passwd` must not be served.
		const canonicalRoot = staticRoot ? canonicalContainmentRoot(staticRoot) : null;
		const pickCompressedSibling = (suffix: string): string | null => {
			const candidate = `${filePath}${suffix}`;
			try {
				if (!existsSync(candidate)) return null;
				if (canonicalRoot && !isWithin(canonicalRoot, realpathSync(candidate))) return null;
				return candidate;
			} catch {
				return null;
			}
		};
		const brSibling = encodingAccepted(acceptEncoding, "br") ? pickCompressedSibling(".br") : null;
		const gzSibling = !brSibling && encodingAccepted(acceptEncoding, "gzip") ? pickCompressedSibling(".gz") : null;
		if (brSibling) {
			responsePath = brSibling;
			contentEncoding = "br";
		} else if (gzSibling) {
			responsePath = gzSibling;
			contentEncoding = "gzip";
		}

		const content = await readFile(responsePath);
		const headers: Record<string, string | number> = {
			"Content-Type": contentType,
			"Content-Length": content.length,
			"Cache-Control": ext === ".html"
				? "no-cache"
				: staticRoot && isHashedStaticAsset(filePath, staticRoot)
					? "public, max-age=31536000, immutable"
					: "no-cache",
		};
		if (contentEncoding) {
			headers["Content-Encoding"] = contentEncoding;
			headers.Vary = "Accept-Encoding";
		}
		res.writeHead(200, headers);
		res.end(sendBody ? content : undefined);
		return true;
	} catch (err) {
		return false;
	}
}
