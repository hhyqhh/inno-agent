import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getWordPdfPreview, WordPreviewError } from "../../office/word-preview.js";
import { handleWorkspacesRoutes, type WorkspacesRouteContext } from "./workspaces.js";

vi.mock("../pdf-response.js", () => ({ servePdf: vi.fn() }));
vi.mock("../../agent/pi-runner.js", () => ({ applyWorkspaceCwd: vi.fn(), getCurrentSessionId: vi.fn() }));
vi.mock("../../office/word-preview.js", async (importOriginal) => ({
	...await importOriginal<typeof import("../../office/word-preview.js")>(), getWordPdfPreview: vi.fn(),
}));

let root: string;
let context: WorkspacesRouteContext;
function response() {
	const result = { status: 0, headers: {} as Record<string, unknown>, body: undefined as string | Buffer | undefined };
	return Object.assign(result, {
		writeHead(status: number, headers: Record<string, unknown>) { result.status = status; result.headers = headers; },
		end(body: string | Buffer) { result.body = body; },
	});
}
async function get(url: string) {
	const res = response();
	expect(await handleWorkspacesRoutes({} as IncomingMessage, res as unknown as ServerResponse, "GET", url, context)).toBe(true);
	return res;
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "word-preview-route-"));
	context = { dataDir: root, workspaceRegistry: { resolveWorkspaceDir: vi.fn().mockReturnValue(root) } } as unknown as WorkspacesRouteContext;
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); vi.resetAllMocks(); });

describe("workspace Word previews", () => {
	it.each(["doc", "docx"])("routes %s metadata to the PDF endpoint", async (extension) => {
		await writeFile(join(root, `report.${extension}`), "test");
		const res = await get(`/api/workspace/file?workspaceId=workspace-a&path=report.${extension}`);
		expect(res.status).toBe(200);
		expect(JSON.parse(res.body as string)).toMatchObject({
			kind: "office", format: extension,
			previewUrl: `/api/workspace/word-preview?workspaceId=workspace-a&path=report.${extension}`,
		});
	});

	it("returns a versioned direct PDF URL after conversion is ready", async () => {
		vi.mocked(getWordPdfPreview).mockResolvedValue({ path: "/cache/pdf", size: 123, etag: '"abc123"' });
		const res = await get("/api/workspace/word-preview?workspaceId=workspace-a&path=report.docx&metadata=1");
		expect(getWordPdfPreview).toHaveBeenCalledWith(root, root, "report.docx");
		expect(JSON.parse(res.body as string)).toEqual({ url: "/api/workspace/word-preview?workspaceId=workspace-a&path=report.docx&v=abc123", size: 123 });
	});

	it("preserves structured conversion errors for retry UI", async () => {
		vi.mocked(getWordPdfPreview).mockRejectedValue(new WordPreviewError("WORD_ENGINE_UNAVAILABLE", 503, "Engine unavailable"));
		const res = await get("/api/workspace/word-preview?path=report.docx");
		expect(res.status).toBe(503);
		expect(JSON.parse(res.body as string)).toMatchObject({ code: "WORD_ENGINE_UNAVAILABLE" });
	});
});
