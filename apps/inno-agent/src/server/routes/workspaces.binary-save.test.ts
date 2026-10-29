import * as fs from "node:fs/promises";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleWorkspacesRoutes, type WorkspacesRouteContext } from "./workspaces.js";

vi.mock("node:fs/promises", async (original) => {
    const actual = await original<typeof import("node:fs/promises")>();
    return { ...actual, copyFile: vi.fn(actual.copyFile) };
});
vi.mock("../../agent/pi-runner.js", () => ({ applyWorkspaceCwd: vi.fn(), getCurrentSessionId: vi.fn() }));
let root: string;
let context: WorkspacesRouteContext;
async function put(body: Record<string, unknown>) {
	const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
	req.headers = {};
	const result = { status: 0, body: "", writeHead(status: number) { this.status = status; }, end(value: string) { this.body = value; } };
	await handleWorkspacesRoutes(req, result as unknown as ServerResponse, "PUT", "/api/workspace/file", context);
	return result;
}
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "office-save-"));
	context = { workspaceRegistry: { listWorkspacesAsync: async () => [{ id: "tmp" }], resolveWorkspaceDirAsync: async () => root } } as unknown as WorkspacesRouteContext;
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
describe("workspace in-place saves", () => {
	it.each(["report.docx", "budget.xlsx", "deck.pptx"])("saves binary bytes to %s without leaving old trailing bytes", async (path) => {
		await writeFile(join(root, path), "a much longer old document");
		const bytes = Buffer.from([0, 255, 128, 10]);
		expect((await put({ path, contentBase64: bytes.toString("base64"), confirmOverwrite: true })).status).toBe(200);
		expect(await readFile(join(root, path))).toEqual(bytes);
	});
	it("requires confirmation and backs up exact original bytes before each overwrite", async () => {
		const path = "budget.xlsx";
		const original = Buffer.from([0, 128, 255]);
		await writeFile(join(root, path), original);
		expect((await put({ path, contentBase64: "eA==" })).status).toBe(409);
		expect(await readFile(join(root, path))).toEqual(original);
		const results = await Promise.all(["first", "second"].map((value) => put({ path, contentBase64: Buffer.from(value).toString("base64"), confirmOverwrite: true })));
		expect(results.map((result) => result.status)).toEqual([200, 200]);
		const backups = results.map((result) => JSON.parse(result.body).backupPath);
		expect(backups[0]).not.toBe(backups[1]);
		expect(await readFile(join(root, backups[0]))).toEqual(original);
		expect(await readFile(join(root, backups[1]), "utf8")).toBe("first");
		expect(await readFile(join(root, path), "utf8")).toBe("second");
	});
	it("leaves the original unchanged when backup creation fails", async () => {
		await writeFile(join(root, "deck.pptx"), "original");
		vi.mocked(fs.copyFile).mockRejectedValueOnce(new Error("disk full"));
		const result = await put({ path: "deck.pptx", contentBase64: "eA==", confirmOverwrite: true });
		expect(result.status).toBe(500);
		expect(JSON.parse(result.body).code).toBe("OFFICE_BACKUP_FAILED");
		expect(await readFile(join(root, "deck.pptx"), "utf8")).toBe("original");
	});
	it("rejects malformed base64 without changing the original", async () => {
		await writeFile(join(root, "deck.pptx"), "original");
		expect((await put({ path: "deck.pptx", contentBase64: "aGVsbG8=garbage!" })).status).toBe(400);
		expect(await readFile(join(root, "deck.pptx"), "utf8")).toBe("original");
	});
	it("keeps existing text saves and requires an existing regular file", async () => {
		await writeFile(join(root, "note.txt"), "a long old value");
		expect((await put({ path: "note.txt", content: "新" })).status).toBe(200);
		expect(await readFile(join(root, "note.txt"), "utf8")).toBe("新");
		expect((await put({ path: "missing.docx", contentBase64: "eA==" })).status).toBe(404);
		expect((await put({ path: ".", content: "" })).status).toBe(404);
	});
	it("rejects traversal, absolute paths, and symlink escapes", async () => {
		for (const path of ["../escape.xlsx", "/escape.xlsx", "C:/escape.xlsx"]) {
			expect((await put({ path, contentBase64: "eA==" })).status).toBe(403);
		}
		await symlink(tmpdir(), join(root, "outside"));
		expect((await put({ path: "outside/escape.xlsx", contentBase64: "eA==" })).status).toBe(403);
	});
});
