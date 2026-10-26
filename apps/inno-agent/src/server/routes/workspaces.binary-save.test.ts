import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleWorkspacesRoutes, type WorkspacesRouteContext } from "./workspaces.js";
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
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
describe("binary Office copy saves", () => {
    it("writes a new binary copy while preserving the source", async () => {
        await writeFile(join(root, "source.xlsx"), "source");
        const bytes = Buffer.from([0, 255, 128, 10]);
        expect((await put({ path: "copy.xlsx", contentBase64: bytes.toString("base64"), createOnly: true })).status).toBe(200);
        expect(await readFile(join(root, "copy.xlsx"))).toEqual(bytes);
        expect(await readFile(join(root, "source.xlsx"), "utf8")).toBe("source");
    });
    it("rejects malformed base64 without creating a file", async () => {
        expect((await put({ path: "copy.pptx", contentBase64: "aGVsbG8=garbage!", createOnly: true })).status).toBe(400);
        await expect(readFile(join(root, "copy.pptx"))).rejects.toMatchObject({ code: "ENOENT" });
    });
    it("cannot overwrite an existing file, including simultaneous saves", async () => {
        const payload = { path: "copy.xlsx", contentBase64: "eA==", createOnly: true };
        const results = await Promise.all([put(payload), put(payload)]);
        expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
        expect(await readFile(join(root, "copy.xlsx"), "utf8")).toBe("x");
        expect((await put({ ...payload, contentBase64: "eQ==" })).status).toBe(409);
    });
    it("requires a new spreadsheet/presentation target", async () => {
        expect((await put({ path: "file.xlsx", contentBase64: "eA==" })).status).toBe(400);
        expect((await put({ path: "file.docx", contentBase64: "eA==", createOnly: true })).status).toBe(400);
    });
    it("rejects traversal and symlink escapes", async () => {
        expect((await put({ path: "../escape.xlsx", contentBase64: "eA==", createOnly: true })).status).toBe(403);
        await symlink(tmpdir(), join(root, "outside"));
        expect((await put({ path: "outside/escape.xlsx", contentBase64: "eA==", createOnly: true })).status).toBe(403);
    });
    it("retains existing text saves and removes the old trailing bytes", async () => {
        await writeFile(join(root, "note.txt"), "a long old value");
        expect((await put({ path: "note.txt", content: "新" })).status).toBe(200);
        expect(await readFile(join(root, "note.txt"), "utf8")).toBe("新");
    });
});
