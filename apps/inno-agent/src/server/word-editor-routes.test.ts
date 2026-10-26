import { createServer, request, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WordDocumentService, WordEditorError, WORD_MIME } from "../office/word-document.js";
import { handleWordEditorRoutes } from "./word-editor-routes.js";
let server: Server;
let base: string;
let editor: WordDocumentService;
beforeEach(async () => {
	editor = new WordDocumentService("/unused", async () => null);
	server = createServer(async (req, res) => { if (!await handleWordEditorRoutes(req, res, req.method!, req.url!, editor)) { res.writeHead(404); res.end(); } });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/workspace/word-editor`;
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); vi.restoreAllMocks(); });
describe("browser Word routes", () => {
	it("serves binary DOCX and a content ETag without caching", async () => {
		const open = vi.spyOn(editor, "open").mockResolvedValue({ bytes: Buffer.from("docx"), version: "abc" });
		const response = await fetch(`${base}/document?workspaceId=owner&path=a.docx`);
		expect(response.headers.get("etag")).toBe('"abc"'); expect(response.headers.get("cache-control")).toBe("no-store"); expect(await response.text()).toBe("docx"); expect(open).toHaveBeenCalledWith("owner", "a.docx");
	});
	it("saves bytes and the original workspace/version only after commit", async () => {
		let finish!: (value: { version: string; savedAt: string }) => void;
		const save = vi.spyOn(editor, "save").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
		const pending = fetch(`${base}/document?workspaceId=owner&path=a.docx`, { method: "PUT", headers: { "Content-Type": WORD_MIME, "If-Match": '"original"' }, body: "edited" });
		await vi.waitFor(() => expect(save).toHaveBeenCalledWith("owner", "a.docx", "original", Buffer.from("edited")));
		finish({ version: "new", savedAt: "now" }); expect(await (await pending).json()).toEqual({ version: "new", savedAt: "now" });
	});
	it("rejects cross-site and incorrect content-type writes", async () => {
		const save = vi.spyOn(editor, "save");
		const cross = await fetch(`${base}/document`, { method: "PUT", headers: { "Content-Type": WORD_MIME, "Sec-Fetch-Site": "cross-site" }, body: "bad" });
		expect(cross.status).toBe(403);
		expect((await fetch(`${base}/document`, { method: "PUT", body: "bad" })).status).toBe(403); expect(save).not.toHaveBeenCalled();
	});
	it("returns a structured conflict and no success acknowledgement", async () => {
		vi.spyOn(editor, "save").mockRejectedValue(new WordEditorError("WORD_EDITOR_CONFLICT", 409));
		const response = await fetch(`${base}/document`, { method: "PUT", headers: { "Content-Type": WORD_MIME, "If-Match": '"old"' }, body: "edit" });
		expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: "WORD_EDITOR_CONFLICT", code: "WORD_EDITOR_CONFLICT" });
	});
	it("bounds binary uploads and closes the rejected connection", async () => {
		const save = vi.spyOn(editor, "save");
		// Send only headers first: a compliant client can receive 413 before
		// transmitting a 32 MB body. Fetch races its own upload against close.
		const response = await new Promise<{ status: number; connection?: string }>((resolve, reject) => {
			const req = request(`${base}/document`, { method: "PUT", headers: { "Content-Type": WORD_MIME, "Content-Length": 32 * 1024 * 1024 + 1 } }, (res) => {
				res.resume(); res.on("end", () => resolve({ status: res.statusCode!, connection: res.headers.connection }));
			});
			req.on("error", reject); req.flushHeaders();
		});
		expect(response.status).toBe(413); expect(response.connection).toBe("close"); expect(save).not.toHaveBeenCalled();
	});
});
