import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
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
	it.each(["deck.pptx", "budget.xlsx"])("saves multi-megabyte %s exports without overflowing the validator stack", async (path) => {
		await writeFile(join(root, path), "original");
		const bytes = Buffer.alloc(8 * 1024 * 1024, 0xa5);
		const result = await put({ path, contentBase64: bytes.toString("base64"), confirmOverwrite: true, backupOriginal: false, expectedContentHash: createHash("sha256").update("original").digest("hex") });
		expect(result.status).toBe(200);
		expect((await readFile(join(root, path))).equals(bytes)).toBe(true);
		expect(JSON.parse(result.body).contentHash).toBe(createHash("sha256").update(bytes).digest("hex"));
	});
	it.each(["aGVsbG8=garbage!", "AAA", "AA=A", "=AAA", "A===", "====", "AAA\n", "AAA\r", "AA-_", "A💡A"])("rejects malformed base64 %j before opening the original", async (contentBase64) => {
		await writeFile(join(root, "deck.pptx"), "original");
		const result = await put({ path: "deck.pptx", contentBase64, confirmOverwrite: true, backupOriginal: false });
		expect(result.status).toBe(400);
		expect(await readFile(join(root, "deck.pptx"), "utf8")).toBe("original");
	});
	it("accepts unchanged source content despite a stale preview timestamp, then supports another save", async () => {
		const path = "budget.xlsx";
		await writeFile(join(root, path), "original");
		const hash = (text: string) => createHash("sha256").update(text).digest("hex");
		const first = await put({ path, contentBase64: Buffer.from("first").toString("base64"), confirmOverwrite: true, expectedUpdatedAt: "stale-preview", expectedContentHash: hash("original") });
		expect(first.status).toBe(200);
		expect(JSON.parse(first.body).contentHash).toBe(hash("first"));
		const second = await put({ path, contentBase64: Buffer.from("second").toString("base64"), confirmOverwrite: true, expectedContentHash: JSON.parse(first.body).contentHash });
		expect(second.status).toBe(200);
		expect(await readFile(join(root, path), "utf8")).toBe("second");
	});
    it("saves directly without generating a backup when the backup option is off", async () => {
        await writeFile(join(root, "budget.xlsx"), "old");
        const result = await put({ path: "budget.xlsx", contentBase64: "bmV3", confirmOverwrite: true, backupOriginal: false });
        expect(result.status).toBe(200);
        expect(JSON.parse(result.body).backupPath).toBeUndefined();
        expect(await fs.readdir(root)).toEqual(["budget.xlsx"]);
        expect(await readFile(join(root, "budget.xlsx"), "utf8")).toBe("new");
    });

	it("rejects changed content even when its timestamp still matches", async () => {
		const path = "deck.pptx";
		await writeFile(join(root, path), "external edit");
		const info = await fs.stat(join(root, path));
		const result = await put({ path, contentBase64: "eA==", confirmOverwrite: true, expectedUpdatedAt: info.mtime.toISOString(), expectedContentHash: createHash("sha256").update("original").digest("hex") });
		expect(result.status).toBe(409);
		expect(JSON.parse(result.body).code).toBe("FILE_CHANGED");
		expect(await readFile(join(root, path), "utf8")).toBe("external edit");
	});
	it("allows only one overwrite based on the same source content", async () => {
		await writeFile(join(root, "budget.xlsx"), "original");
		const expectedContentHash = createHash("sha256").update("original").digest("hex");
		const results = await Promise.all(["YQ==", "Yg=="].map(contentBase64 => put({ path: "budget.xlsx", contentBase64, confirmOverwrite: true, expectedContentHash })));
		expect(results.map(result => result.status).sort()).toEqual([200, 409]);
	});
	it.each(["report.docx", "budget.xlsx", "deck.pptx"])("saves binary bytes to %s without leaving old trailing bytes", async (path) => {
		await writeFile(join(root, path), "a much longer old document");
		const bytes = Buffer.from([0, 255, 128, 10]);
		expect((await put({ path, contentBase64: bytes.toString("base64"), confirmOverwrite: true })).status).toBe(200);
		expect(await readFile(join(root, path))).toEqual(bytes);
	});
    it.each(["budget.xlsx", "deck.pptx"])("creates an edited %s copy without confirmation or changing the source", async (path) => {
        await writeFile(join(root, path), "original");
        const result = await put({ path: `copy-${path}`, contentBase64: "bmV3", createOnly: true });
        expect(result.status).toBe(200);
        expect(JSON.parse(result.body).backupPath).toBeUndefined();
        expect(await readFile(join(root, path), "utf8")).toBe("original");
        expect(await readFile(join(root, `copy-${path}`), "utf8")).toBe("new");
        expect((await put({ path, contentBase64: "eA==", createOnly: true, confirmOverwrite: true })).status).toBe(409);
        expect(await readFile(join(root, path), "utf8")).toBe("original");
    });
    it("allows only one concurrent creator of a copy destination", async () => {
        const results = await Promise.all(["YQ==", "Yg=="].map(contentBase64 => put({ path: "copy.xlsx", contentBase64, createOnly: true })));
        expect(results.map(r => r.status).sort()).toEqual([200, 409]);
        expect(await readFile(join(root, "copy.xlsx"), "utf8")).toBe(["a", "b"][results.findIndex(r => r.status === 200)]);
    });

	it("requires confirmation and backs up exact original bytes before each overwrite", async () => {
		const path = "budget.xlsx";
		const original = Buffer.from([0, 128, 255]);
		await writeFile(join(root, path), original);
		expect((await put({ path, contentBase64: "eA==" })).status).toBe(409);
		expect(await readFile(join(root, path))).toEqual(original);
		const values = ["first", "second"];
		const results = await Promise.all(values.map((value) => put({ path, contentBase64: Buffer.from(value).toString("base64"), confirmOverwrite: true })));
		expect(results.map((result) => result.status)).toEqual([200, 200]);
		const backups = results.map((result) => JSON.parse(result.body).backupPath);
		expect(backups[0]).not.toBe(backups[1]);
		expect(backups.every(path => path.startsWith(".office-backups/"))).toBe(true);
		expect((await fs.readdir(root)).filter(name => name.endsWith(".xlsx"))).toEqual(["budget.xlsx"]);
		// Request-body/path resolution is asynchronous: concurrent requests can
		// reach the save queue in either order. Verify the complete backup chain,
		// rather than assuming Promise.all's input order is execution order.
		const backupBytes = await Promise.all(backups.map((backup) => readFile(join(root, backup))));
		const first = backupBytes.findIndex(bytes => bytes.equals(original));
		expect(first).toBeGreaterThanOrEqual(0);
		expect(backupBytes[1 - first].toString("utf8")).toBe(values[first]);
		expect(await readFile(join(root, path), "utf8")).toBe(values[1 - first]);
	});
    it("refuses to overwrite a source changed since it was imported", async () => {
        await writeFile(join(root, "budget.xlsx"), "new external edit");
        const result = await put({ path: "budget.xlsx", contentBase64: "eA==", confirmOverwrite: true, expectedUpdatedAt: "2000-01-01T00:00:00.000Z" });
        expect(result.status).toBe(409);
        expect(JSON.parse(result.body).code).toBe("FILE_CHANGED");
        expect(await readFile(join(root, "budget.xlsx"), "utf8")).toBe("new external edit");
        expect(await fs.readdir(root)).toEqual(["budget.xlsx"]);
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
