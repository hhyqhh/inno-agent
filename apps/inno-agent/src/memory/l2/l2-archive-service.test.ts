import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { writeText } from "../../storage/file-store.js";
import { archiveL2Source } from "./l2-archive-service.js";
import { runL2Lint } from "./l2-lint.js";
import type { L2Memory } from "./l2-memory.js";
import { createL2Tools } from "./l2-tools.js";
import { readManifest } from "./manifest-store.js";
import { ensureL2Directories, parseFrontmatter, serializeFrontmatter } from "./wiki-maintainer.js";

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

	it("replaces stale linked-page provenance when existing content changes", async () => {
		const root = makeTempDir();
		ensureL2Directories(root);
		const rawPath = "raw/uploads/mutable.md";
		writeText(join(root, rawPath), "正文包含 [[旧概念]]。");
		const memory = fakeMemory(root);
		const first = await archiveL2Source(
			root,
			{
				title: "可更新资料",
				source: { kind: "existing", rawPath, sourceType: "markdown" },
				dedupeBy: "rawPath",
			},
			{ memory },
		);
		const oldLinkedPage = first.linkedPages[0];
		expect(existsSync(join(root, oldLinkedPage))).toBe(true);
		writeText(
			join(root, oldLinkedPage),
			`${readFileSync(join(root, oldLinkedPage), "utf8").trimEnd()}\n\n## 用户补充\n\n这段手工内容必须可恢复。\n`,
		);

		writeText(join(root, rawPath), "正文改为 [[新概念]]。");
		const second = await archiveL2Source(
			root,
			{
				title: "可更新资料",
				source: { kind: "existing", rawPath, sourceType: "markdown" },
				dedupeBy: "rawPath",
			},
			{ memory },
		);

		expect(second).toMatchObject({ id: first.id, rawPath, duplicate: false });
		expect(second.wikiPagePath).toBe(first.wikiPagePath);
		expect(second.linkedPages).not.toContain(oldLinkedPage);
		expect(existsSync(join(root, oldLinkedPage))).toBe(true);
		expect(readFileSync(join(root, oldLinkedPage), "utf8")).toContain("旧页面内容已备份");
		const backups = readdirSync(join(root, "wiki", "orphans"));
		expect(backups).toHaveLength(1);
		expect(readFileSync(join(root, "wiki", "orphans", backups[0]), "utf8")).toContain("这段手工内容必须可恢复");
		expect(memory.indexPageByPath).toHaveBeenCalledWith(oldLinkedPage);
		expect(readManifest(root)).toHaveLength(1);
		expect(runL2Lint(root).findings.filter((finding) =>
			finding.code === "missing_source_file" || finding.code === "dangling_link"
		)).toEqual([]);
	});

	it("keeps the source-summary path stable when a source title changes", async () => {
		const root = makeTempDir();
		const memory = fakeMemory(root);
		const content = "正文包含 [[稳定概念]]。";
		const first = await archiveL2Source(
			root,
			{ title: "旧标题", source: { kind: "content", content, sourceType: "markdown" } },
			{ memory },
		);
		const linkedPath = first.linkedPages[0];
		const linkedBefore = readFileSync(join(root, linkedPath), "utf8");
		const parsed = parseFrontmatter(linkedBefore);
		expect(parsed.frontmatter).not.toBeNull();
		parsed.frontmatter!.contested = true;
		parsed.frontmatter!.contradictions = [first.id];
		writeText(
			join(root, linkedPath),
			`${serializeFrontmatter(parsed.frontmatter!)}\n${parsed.body.trimEnd()}\n\n## 争议\n\n- 测试争议（来源 [[旧标题]] \`${first.id}\`）\n`,
		);
		const second = await archiveL2Source(
			root,
			{
				title: "新标题",
				source: { kind: "existing", rawPath: first.rawPath, sourceType: "markdown", content },
				dedupeBy: "rawPath",
				force: true,
			},
			{ memory },
		);

		expect(second.id).toBe(first.id);
		expect(second.wikiPagePath).toBe(first.wikiPagePath);
		const linkedContent = readFileSync(join(root, second.linkedPages[0]), "utf8");
		expect(linkedContent).toContain(`[[新标题]] — \`${second.wikiPagePath}\``);
		expect(linkedContent).not.toContain("[[旧标题]]");
		expect(runL2Lint(root).findings.filter((finding) =>
			finding.code === "missing_source_file" || finding.code === "dangling_link"
		)).toEqual([]);
	});

	it("reconciles the semantic index after an interrupted cleanup", async () => {
		const root = makeTempDir();
		const rawPath = "raw/uploads/retry.md";
		ensureL2Directories(root);
		writeText(join(root, rawPath), "第一版 [[旧重试概念]]");
		const first = await archiveL2Source(
			root,
			{
				title: "可重试资料",
				source: { kind: "existing", rawPath, sourceType: "markdown" },
				dedupeBy: "rawPath",
			},
			{ memory: fakeMemory(root) },
		);
		const oldLinkedPage = first.linkedPages[0];
		writeText(join(root, rawPath), "第二版 [[新重试概念]]");

		const failingMemory = fakeMemory(root);
		vi.mocked(failingMemory.indexPageByPath).mockImplementation(async (path) => {
			if (path === oldLinkedPage) throw new Error("simulated index interruption");
		});
		await expect(archiveL2Source(
			root,
			{
				title: "可重试资料",
				source: { kind: "existing", rawPath, sourceType: "markdown" },
				dedupeBy: "rawPath",
			},
			{ memory: failingMemory },
		)).rejects.toThrow("simulated index interruption");
		expect(readManifest(root)[0].status).toBe("error");

		const retryMemory = fakeMemory(root);
		await archiveL2Source(
			root,
			{
				title: "可重试资料",
				source: { kind: "existing", rawPath, sourceType: "markdown" },
				dedupeBy: "rawPath",
			},
			{ memory: retryMemory },
		);
		expect(retryMemory.indexPageByPath).toHaveBeenCalledWith(oldLinkedPage);
		expect(readManifest(root)[0].status).toBe("indexed");
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
