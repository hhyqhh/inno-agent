import type { ServerResponse } from "node:http";
import { systemFonts, type SystemFontService } from "../../office/system-fonts.js";
import { json } from "../http-helpers.js";

export async function handleFontRoutes(res: ServerResponse, method: string, url: string, fonts: Pick<SystemFontService, "list" | "read"> = systemFonts): Promise<boolean> {
	if (method !== "GET") return false;
	if (url === "/api/settings/fonts") {
		json(res, 200, { faces: await fonts.list() });
		return true;
	}
	const match = /^\/api\/settings\/fonts\/([a-f0-9]{64})$/.exec(url);
	if (!match) return false;
	const bytes = await fonts.read(match[1]);
	if (!bytes) { json(res, 404, { error: "Font not found" }); return true; }
	res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": bytes.length, "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff" });
	res.end(bytes);
	return true;
}
