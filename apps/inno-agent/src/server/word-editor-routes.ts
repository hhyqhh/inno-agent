import type { IncomingMessage, ServerResponse } from "node:http";
import { WordDocumentService, WordEditorError, WORD_MAX_BYTES, WORD_MIME } from "../office/word-document.js";
import { json } from "./http-helpers.js";

/** Read bounded binary content without destroying the socket before a 413 response. */
async function readDocument(req: IncomingMessage): Promise<Buffer> {
	if (Number(req.headers["content-length"]) > WORD_MAX_BYTES) throw new WordEditorError("WORD_EDITOR_TOO_LARGE", 413);
	const chunks: Buffer[] = [];
	let length = 0;
	const iterator = req.iterator({ destroyOnReturn: false });
	for await (const chunk of iterator) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		length += bytes.length;
		if (length > WORD_MAX_BYTES) throw new WordEditorError("WORD_EDITOR_TOO_LARGE", 413);
		chunks.push(bytes);
	}
	return Buffer.concat(chunks);
}

export async function handleWordEditorRoutes(req: IncomingMessage, res: ServerResponse, method: string, url: string, editor: WordDocumentService): Promise<boolean> {
	const parsed = new URL(url, "http://localhost");
	const prefix = "/api/workspace/word-editor";
	if (parsed.pathname !== prefix && !parsed.pathname.startsWith(`${prefix}/`)) return false;
	res.setHeader("Cache-Control", "no-store");
	try {
		if (parsed.pathname !== `${prefix}/document` || !["GET", "PUT"].includes(method)) {
			json(res, 404, { error: "Not found" });
			return true;
		}
		const path = parsed.searchParams.get("path") || "";
		const workspaceId = parsed.searchParams.get("workspaceId") || "tmp";
		if (method === "GET") {
			const file = await editor.open(workspaceId, path);
			res.writeHead(200, { "Content-Type": WORD_MIME, "Content-Length": file.bytes.length, ETag: `"${file.version}"` });
			res.end(file.bytes);
		} else {
			if (req.headers["sec-fetch-site"] === "cross-site" || req.headers["content-type"] !== WORD_MIME) throw new WordEditorError("WORD_EDITOR_UNAUTHORIZED", 403);
			const version = typeof req.headers["if-match"] === "string" ? req.headers["if-match"].replace(/^"|"$/g, "") : "";
			json(res, 200, await editor.save(workspaceId, path, version, await readDocument(req)));
		}
	} catch (error) {
		const code = error instanceof WordEditorError ? error.code : "WORD_EDITOR_SAVE_FAILED";
		const status = error instanceof WordEditorError ? error.statusCode : 500;
		if (status === 413) res.setHeader("Connection", "close");
		json(res, status, { error: code, code });
	}
	return true;
}
