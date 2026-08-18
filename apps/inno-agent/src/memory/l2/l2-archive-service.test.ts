import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { writeText } from "../../storage/file-store.js";
import { ArchiveReplacementRequiredError, archiveL2Source } from "./l2-archive-service.js";
import type { L2Memory } from "./l2-memory.js";
import { createL2Tools } from "./l2-tools.js";
import { readManifest } from "./manifest-store.js";
import { ensureL2Directories } from "./wiki-maintainer.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "inno-l2-archive-"));
	tempDirs.push(dir);
	return dir;
}

function fakeMemory(root: string): L2Memory {
	return {
		dataDir: root,
		indexPageByPath: vi.fn().mockResolvedValue(undefined),
		removePage: vi.fn().mockResolvedValue(undefined),
	} as unknown as L2Memory;
}

function deferred<T>() {
	let resolvePromise!: (value: T) => void;
	let rejectPromise!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	return { promise, resolve: resolvePromise, reject: rejectPromise };
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("archiveL2Source", () => {
	it("archives an existing raw file without replacing its path", async () => {
		const root = makeTempDir();
		ensureL2Directories(root);
		const rawPath = "raw/uploads/existing.md";
		writeText(join(root, rawPath), "正文包含 [[共享归档]] 概念。");
		const memory = fakeMemory(root);

		const result = await archiveL2Source(
			root,
			{
				title: "已有文件",
				source: { kind: "existing", rawPath, sourceType: "markdown" },
				dedupeBy: "rawPath",
			},
			{ memory },
		);

		expect(result).toMatchObject({ rawPath, status: "indexed", duplicate: false });
		expect(readManifest(root)).toHaveLength(1);
		expect(readFileSync(join(root, rawPath), "utf8")).toContain("共享归档");
		expect(memory.indexPageByPath).toHaveBeenCalled();
	});

	it("serializes direct and agent-tool archives for the same directory", async () => {
		const root = makeTempDir();
		const firstIndex = deferred<void>();
		const memory = fakeMemory(root);
		vi.mocked(memory.indexPageByPath)
			.mockImplementationOnce(() => firstIndex.promise)
			.mockResolvedValue(undefined);

		const first = archiveL2Source(
			root,
			{ title: "直接归档", source: { kind: "content", content: "第一篇正文", sourceType: "markdown" } },
			{ memory },
		);
		await vi.waitFor(() => expect(memory.indexPageByPath).toHaveBeenCalledTimes(1));

		const tool = createL2Tools(root, undefined, memory)[0];
		const second = (tool.execute as (...args: any[]) => Promise<any>)(
			"call-tool",
			{ title: "工具归档", content: "第二篇正文", sourceType: "markdown" },
			undefined,
			undefined,
			{ model: undefined, modelRegistry: undefined },
		);
		await Promise.resolve();
		expect(readManifest(root)).toHaveLength(1);

		firstIndex.resolve();
		await Promise.all([first, second]);
		expect(readManifest(root).map((entry) => entry.title)).toEqual(["直接归档", "工具归档"]);
	});

	it("rejects changed raw-path content until replacement support is stacked", async () => {
		const root = makeTempDir();
		const rawPath = "raw/uploads/mutable.md";
		ensureL2Directories(root);
		writeText(join(root, rawPath), "第一版正文");
		await archiveL2Source(
			root,
			{
				title: "可更新资料",
				source: { kind: "existing", rawPath, sourceType: "markdown" },
				dedupeBy: "rawPath",
			},
			{ memory: fakeMemory(root) },
		);
		writeText(join(root, rawPath), "第二版正文");

		await expect(archiveL2Source(
			root,
			{
				title: "可更新资料",
				source: { kind: "existing", rawPath, sourceType: "markdown" },
				dedupeBy: "rawPath",
			},
			{ memory: fakeMemory(root) },
		)).rejects.toBeInstanceOf(ArchiveReplacementRequiredError);
	});

	it("preserves content-mode force semantics", async () => {
		const root = makeTempDir();
		const request = {
			title: "强制归档",
			source: { kind: "content" as const, content: "相同正文", sourceType: "markdown" as const },
		};
		const first = await archiveL2Source(root, request, { memory: fakeMemory(root) });
		const second = await archiveL2Source(root, { ...request, force: true }, { memory: fakeMemory(root) });

		expect(second.id).not.toBe(first.id);
		expect(readManifest(root)).toHaveLength(2);
	});

});
