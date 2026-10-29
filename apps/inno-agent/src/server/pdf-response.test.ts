import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { servePdf } from "./pdf-response.js";
let root: string, server: Server, base: string;
const bytes = "%PDF-1.7\n0123456789";
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pdf-http-"));
	const path = join(root, "test.pdf"); await writeFile(path, bytes);
	server = createServer((req, res) => { void servePdf(req, res, { path, size: bytes.length, etag: '"v1"' }, req.method === "HEAD"); });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
describe("streamed PDF responses", () => {
	it("streams full PDF and handles HEAD without a body", async () => {
		const response = await fetch(base); expect(await response.text()).toBe(bytes);
		expect(response.headers.get("accept-ranges")).toBe("bytes");
		const head = await fetch(base, { method: "HEAD" }); expect(head.headers.get("content-length")).toBe(String(bytes.length)); expect(await head.text()).toBe("");
	});
	it.each([["bytes=0-4", "%PDF-"], ["bytes=9-", "0123456789"], ["bytes=-3", "789"]])("serves %s", async (range, expected) => {
		const response = await fetch(base, { headers: { Range: range } });
		expect(response.status).toBe(206); expect(await response.text()).toBe(expected); expect(response.headers.get("content-range")).toContain(`/${bytes.length}`);
	});
	it.each(["bytes=999-", "bytes=8-2", "bytes=-0", "bytes=1-2,4-5"])("rejects invalid range %s", async (range) => {
		const response = await fetch(base, { headers: { Range: range } }); expect(response.status).toBe(416);
	});
	it("revalidates ETags and ignores an obsolete If-Range", async () => {
		expect((await fetch(base, { headers: { "If-None-Match": 'W/"v1"' } })).status).toBe(304);
		const response = await fetch(base, { headers: { Range: "bytes=0-4", "If-Range": '"v0"' } });
		expect(response.status).toBe(200); expect(await response.text()).toBe(bytes);
	});
});
