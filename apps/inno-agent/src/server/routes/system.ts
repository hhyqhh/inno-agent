import type { IncomingMessage, ServerResponse } from "node:http";
import { SystemFontService } from "../../office/system-fonts.js";
import { json } from "../http-helpers.js";

/**
 * Same-origin font service: the renderer registers the machine's real font
 * binaries into the editor's font store so documents render with the fonts
 * they name instead of bundled substitutes. GET-only; the bytes never leave
 * the machine (no CORS headers are emitted).
 */
export async function handleSystemFontRoutes(req: IncomingMessage, res: ServerResponse, method: string, url: string, fonts: SystemFontService): Promise<boolean> {
	const parsed = new URL(url, "http://localhost");
	if (!parsed.pathname.startsWith("/api/system/fonts")) return false;
	if (method !== "GET") {
		json(res, 405, { error: "Method not allowed" });
		return true;
	}
	res.setHeader("Cache-Control", "no-store");
	try {
		if (parsed.pathname === "/api/system/fonts") {
			const faces = await fonts.list();
			json(res, 200, { faces });
			return true;
		}
		if (parsed.pathname === "/api/system/fonts/file") {
			const file = parsed.searchParams.get("file") || "";
			const bytes = await fonts.readFaceBytes(file);
			if (!bytes) {
				json(res, 404, { error: "FONT_FILE_MISSING" });
				return true;
			}
			res.writeHead(200, { "Content-Type": "font/octet-stream", "Content-Length": bytes.length, "Cache-Control": "no-store" });
			res.end(bytes);
			return true;
		}
		json(res, 404, { error: "Not found" });
		return true;
	} catch {
		json(res, 500, { error: "FONT_SERVICE_FAILED" });
		return true;
	}
}
