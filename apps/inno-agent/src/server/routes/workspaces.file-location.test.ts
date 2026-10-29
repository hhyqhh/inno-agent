import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { handleWorkspacesRoutes, type WorkspacesRouteContext } from "./workspaces.js";
vi.mock("../../agent/pi-runner.js", () => ({ applyWorkspaceCwd: vi.fn(), getCurrentSessionId: vi.fn() }));
let root: string;
let context: WorkspacesRouteContext;
async function locate(path: string, workspaceId = "owner") {
	const result = { status: 0, body: "", writeHead(status: number) { this.status = status; }, end(value: string) { this.body = value; } };
	await handleWorkspacesRoutes({} as IncomingMessage, result as unknown as ServerResponse, "GET", `/api/workspace/file-location?${new URLSearchParams({ path, workspaceId })}`, context);
	return { status: result.status, body: JSON.parse(result.body) };
}
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "workspace-open-"));
	context = { workspaceRegistry: {
		listWorkspacesAsync: async () => [{ id: "owner" }, { id: "other" }],
		resolveWorkspaceDirAsync: async (workspace: { id: string }) => join(root, workspace.id),
	} } as unknown as WorkspacesRouteContext;
	await mkdir(join(root, "owner", "docs"), { recursive: true });
	await mkdir(join(root, "other"));
	await writeFile(join(root, "owner", "docs", "报告.docx"), "original");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
it("returns the original file from the requested owner workspace", async () => {
	const result = await locate("docs/报告.docx");
	expect(result).toEqual({ status: 200, body: { absolutePath: join(root, "owner", "docs", "报告.docx") } });
	expect((await locate("docs/报告.docx", "other")).status).toBe(404);
});
it("rejects missing workspaces, missing files, directories and empty paths", async () => {
	expect((await locate("docs/报告.docx", "unknown")).status).toBe(404);
	expect((await locate("missing.docx")).status).toBe(404);
	expect((await locate("docs")).status).toBe(404);
	expect((await locate("")).status).toBe(400);
});
it("rejects absolute paths, traversal and symlinks outside the owner workspace", async () => {
	for (const path of ["../other/a.txt", "/etc/passwd", "C:\\outside.txt"]) expect((await locate(path)).status).toBe(403);
	await symlink(join(root, "other"), join(root, "owner", "outside"));
	expect((await locate("outside/file.txt")).status).toBe(403);
});
