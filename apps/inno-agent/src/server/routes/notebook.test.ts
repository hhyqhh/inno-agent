import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const unarchiveMock = vi.hoisted(() => vi.fn());
vi.mock("../../memory/l2/notebook-unarchive-service.js", () => ({
	unarchiveL2NotebookItem: unarchiveMock,
}));

import { handleNotebookRoutes, type NotebookRouteContext } from "./notebook.js";

const roots: string[] = [];
afterEach(() => {
	unarchiveMock.mockReset();
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
