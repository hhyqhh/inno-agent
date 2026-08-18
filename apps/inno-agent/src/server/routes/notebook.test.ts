import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const unarchiveMock = vi.hoisted(() => vi.fn());
const regenerateMock = vi.hoisted(() => vi.fn());
vi.mock("../../memory/l2/notebook-unarchive-service.js", () => ({
	unarchiveL2NotebookItem: unarchiveMock,
}));
vi.mock("../../memory/l2/sources-service.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../memory/l2/sources-service.js")>();
	return { ...actual, regenerateL2Source: regenerateMock };
});

import { handleNotebookRoutes, type NotebookRouteContext } from "./notebook.js";

const roots: string[] = [];
afterEach(() => {
	unarchiveMock.mockReset();
	regenerateMock.mockReset();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function request(body: unknown): IncomingMessage {
	const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
	req.headers = {};
	return req;
}

function response(): { res: ServerResponse; result: { status: number; body: string } } {
	const result = { status: 0, body: "" };
	const res = {
		writeHead(status: number) {
			result.status = status;
			return res;
		},
		end(body: string) {
			result.body = body;
			return res;
		},
	} as unknown as ServerResponse;
	return { res, result };
}

describe("notebook unarchive route", () => {
	it("validates the raw path and forwards the archive runtime", async () => {
		const root = mkdtempSync(join(tmpdir(), "inno-notebook-route-"));
		roots.push(root);
		mkdirSync(join(root, "raw", "uploads"), { recursive: true });
		writeFileSync(join(root, "raw", "uploads", "source.md"), "source", "utf-8");
		const runtime = { model: {} as never };
		const ctx = {
			l2DataDir: root,
			codeDir: root,
			getArchiveRuntime: () => runtime,
		} as NotebookRouteContext;
		unarchiveMock.mockResolvedValue({ rawPath: "raw/uploads/source.md", status: "uploaded" });
		const { res, result } = response();

		await expect(handleNotebookRoutes(
			request({ rawPath: "raw/uploads/source.md" }),
			res,
			"POST",
			"/api/l2/notes/unarchive",
			ctx,
		)).resolves.toBe(true);
		expect(result.status).toBe(200);
		expect(unarchiveMock).toHaveBeenCalledWith(root, "raw/uploads/source.md", runtime);
	});
});

describe("notebook raw file route", () => {
	it("serves browser-safe image formats inline", async () => {
		const root = mkdtempSync(join(tmpdir(), "inno-notebook-image-"));
		roots.push(root);
		mkdirSync(join(root, "raw", "uploads"), { recursive: true });
		writeFileSync(join(root, "raw", "uploads", "image.gif"), Buffer.from("GIF89a", "ascii"));
		const headers: Record<string, string | number> = {};
		let status = 0;
		const res = new PassThrough() as unknown as ServerResponse;
		res.writeHead = ((nextStatus: number, nextHeaders: Record<string, string | number>) => {
			status = nextStatus;
			Object.assign(headers, nextHeaders);
			return res;
		}) as ServerResponse["writeHead"];
		const finished = new Promise<void>((resolve) => res.on("finish", resolve));
		const ctx = { l2DataDir: root, codeDir: root, getArchiveRuntime: () => ({}) } as NotebookRouteContext;

		await expect(handleNotebookRoutes(
			request({}),
			res,
			"GET",
			"/api/l2/raw/file?path=raw%2Fuploads%2Fimage.gif",
			ctx,
		)).resolves.toBe(true);
		await finished;
		expect(status).toBe(200);
		expect(headers["Content-Type"]).toBe("image/gif");
		expect(String(headers["Content-Disposition"])).toContain("inline");
	});
});

describe("source regeneration route", () => {
	it("forwards the source id and archive runtime", async () => {
		const root = mkdtempSync(join(tmpdir(), "inno-notebook-regenerate-"));
		roots.push(root);
		const runtime = { memory: {} as never };
		const ctx = { l2DataDir: root, codeDir: root, getArchiveRuntime: () => runtime } as NotebookRouteContext;
		regenerateMock.mockResolvedValue({ sourceId: "l2src_test", status: "indexed" });
		const { res, result } = response();

		expect(await handleNotebookRoutes(
			request({ sourceId: "l2src_test" }),
			res,
			"POST",
			"/api/l2/sources/regenerate",
			ctx,
		)).toBe(true);
		expect(result.status).toBe(200);
		expect(regenerateMock).toHaveBeenCalledWith(root, "l2src_test", runtime);
	});
});
