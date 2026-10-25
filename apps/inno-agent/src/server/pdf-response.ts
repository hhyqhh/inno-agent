import { open } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import type { WordPdfPreview } from "../office/word-preview.js";

/** Native PDF viewers request byte ranges; do not buffer the whole PDF in React. */
export async function servePdf(req: IncomingMessage, res: ServerResponse, pdf: WordPdfPreview, head = false): Promise<void> {
	const headers: Record<string, string | number> = {
		"Content-Type": "application/pdf", "Accept-Ranges": "bytes", ETag: pdf.etag,
		"Cache-Control": "private, no-cache", "X-Content-Type-Options": "nosniff",
	};
	if (req.headers?.["if-none-match"]?.split(/\s*,\s*/).some((tag) => tag === pdf.etag || tag === `W/${pdf.etag}` || tag === "*")) {
		res.writeHead(304, headers); res.end(); return;
	}
	let start = 0, end = pdf.size - 1, status = 200;
	const range = req.headers?.range;
	if (range && (!req.headers["if-range"] || req.headers["if-range"] === pdf.etag)) {
		const match = /^bytes=(\d*)-(\d*)$/.exec(range);
		if (match && (match[1] || match[2])) {
			start = match[1] ? Number(match[1]) : Math.max(0, pdf.size - Number(match[2]));
			end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
			if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= end && start < pdf.size && (match[1] || Number(match[2]) > 0)) status = 206;
			else status = 416;
		} else status = 416;
		if (status === 416) { res.writeHead(416, { ...headers, "Content-Range": `bytes */${pdf.size}` }); res.end(); return; }
		headers["Content-Range"] = `bytes ${start}-${end}/${pdf.size}`;
	}
	headers["Content-Length"] = end - start + 1;
	if (head) { res.writeHead(status, headers); res.end(); return; }
	const handle = await open(pdf.path, "r");
	const stream = handle.createReadStream({ start, end, autoClose: true });
	res.writeHead(status, headers);
	// pipeline closes the file descriptor when a viewer disconnects mid-transfer.
	await pipeline(stream, res).catch((error) => { if (!res.destroyed) throw error; });
}
