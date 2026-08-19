import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const parseDocumentMock = vi.hoisted(() => vi.fn());

vi.mock("./document-parser.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./document-parser.js")>();
	return { ...actual, parseDocument: parseDocumentMock };
});

import type { L2Memory } from "./l2-memory.js";
import { createL2Tools } from "./l2-tools.js";
import { runL2Lint } from "./l2-lint.js";
import { upsertManifest, readManifest } from "./manifest-store.js";
import { writeText } from "../../storage/file-store.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "inno-l2-tools-"));
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

async function archive(root: string, content: string) {
	const tool = createL2Tools(root, undefined, fakeMemory(root))[0];
	return (tool.execute as (...args: any[]) => Promise<any>)(
		"call-1",
		{ title: "学习资料", content, sourceType: "markdown", tags: ["test"] },
		undefined,
		undefined,
		{ model: undefined, modelRegistry: undefined },
	);
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

async function archiveFile(
	tool: ReturnType<typeof createL2Tools>[number],
	callId: string,
	title: string,
	filePath: string,
) {
	return (tool.execute as (...args: any[]) => Promise<any>)(
		callId,
		{ title, filePath, sourceType: "pdf", tags: ["test"] },
		undefined,
		undefined,
		{ model: undefined, modelRegistry: undefined },
	);
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	parseDocumentMock.mockReset();
});

describe("l2_archive", () => {
	it("writes traceable raw, extracted, manifest, and wiki records", async () => {
		const root = makeTempDir();
		await archive(root, "正文包含 [[间隔重复]] 概念。");

		const entries = readManifest(root);
		expect(entries).toHaveLength(1);
		expect(entries[0].status).toBe("indexed");
		expect(readFileSync(join(root, entries[0].rawPath), "utf8")).toContain("间隔重复");
		expect(readFileSync(join(root, entries[0].extractedPath!), "utf8")).toContain("间隔重复");
		expect(entries[0].wikiPages.length).toBeGreaterThan(0);
		for (const pagePath of entries[0].wikiPages) {
			expect(readFileSync(join(root, pagePath), "utf8")).toContain(entries[0].id);
		}
	});

	it("deduplicates repeated content by hash", async () => {
		const root = makeTempDir();
		await archive(root, "完全相同的资料");
		const duplicate = await archive(root, "完全相同的资料");

		expect(readManifest(root)).toHaveLength(1);
		expect(duplicate.details).toMatchObject({ duplicate: true });
	});

	it("discovers a linked concept near the end of a long source without a model", async () => {
		const root = makeTempDir();
		const content = `${"前置内容。\n\n".repeat(6_000)}末尾定义 [[尾部概念]]。`;
		await archive(root, content);

		const entry = readManifest(root)[0];
		const linkedPage = entry.wikiPages.find((pagePath) => pagePath.includes("尾部概念"));
		expect(linkedPage).toBeDefined();
		expect(readFileSync(join(root, linkedPage!), "utf8")).toContain(entry.id);
	});

	it("downgrades excess wikilinks instead of persisting broken links", async () => {
		const root = makeTempDir();
		const titles = Array.from({ length: 22 }, (_, index) => `概念${index + 1}`);
		await archive(root, titles.map((title) => `[[${title}]]`).join("、"));

		const entry = readManifest(root)[0];
		const sourcePage = readFileSync(join(root, entry.wikiPages[0]), "utf8");
		expect(entry.wikiPages).toHaveLength(21);
		expect(sourcePage).toContain("[[概念20]]");
		expect(sourcePage).toContain("概念21");
		expect(sourcePage).not.toContain("[[概念21]]");
		expect(runL2Lint(root).findings.filter((finding) => finding.code === "dangling_link")).toEqual([]);
	});

	it("resumes an incomplete manifest record instead of duplicating the source", async () => {
		const root = makeTempDir();
		const content = "可恢复的资料";
		const rawPath = "raw/uploads/existing.md";
		const extractedPath = "extracted/existing.md";
		writeText(join(root, rawPath), content);
		writeText(join(root, extractedPath), content);
		upsertManifest(root, {
			id: "l2src_resume1",
			title: "学习资料",
			sourceType: "markdown",
			rawPath,
			extractedPath,
			wikiPages: [],
			tags: ["test"],
			contentHash: createHash("sha256").update(content).digest("hex").slice(0, 16),
			status: "error",
			source: { origin: "user_upload" },
			createdAt: "2026-07-30T00:00:00.000Z",
			updatedAt: "2026-07-30T00:00:00.000Z",
		});

		await archive(root, content);
		const entries = readManifest(root);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ id: "l2src_resume1", rawPath, extractedPath, status: "indexed" });
	});

	it("resolves relative files against the active session workspace", async () => {
		const root = makeTempDir();
		const fallbackWorkspace = makeTempDir();
		const activeWorkspace = makeTempDir();
		const sourceDir = join(activeWorkspace, "sources");
		const sourcePath = join(sourceDir, "lesson.pdf");
		mkdirSync(sourceDir, { recursive: true });
		writeFileSync(sourcePath, "%PDF-active-workspace");
		parseDocumentMock.mockResolvedValue({
			text: "当前会话工作区中的完整资料",
			pageCount: 1,
			pages: [{ pageNumber: 1, text: "当前会话工作区中的完整资料" }],
		});

		const previousWorkspace = process.env.INNO_WORKSPACE_DIR;
		process.env.INNO_WORKSPACE_DIR = fallbackWorkspace;
		try {
			const tool = createL2Tools(root, undefined, fakeMemory(root), () => activeWorkspace)[0];
			await (tool.execute as (...args: any[]) => Promise<any>)(
				"call-file",
				{ title: "会话资料", filePath: "sources/lesson.pdf", sourceType: "pdf" },
				undefined,
				undefined,
				{ model: undefined, modelRegistry: undefined },
			);
		} finally {
			if (previousWorkspace === undefined) delete process.env.INNO_WORKSPACE_DIR;
			else process.env.INNO_WORKSPACE_DIR = previousWorkspace;
		}

		expect(parseDocumentMock).toHaveBeenCalledWith(sourcePath);
		const entry = readManifest(root)[0];
		expect(readFileSync(join(root, entry.rawPath), "utf8")).toBe("%PDF-active-workspace");
		expect(readFileSync(join(root, entry.extractedPath!), "utf8")).toContain("当前会话工作区中的完整资料");
	});

	it("serializes concurrent archives that target the same L2 directory", async () => {
		const root = makeTempDir();
		const firstFile = join(makeTempDir(), "first.pdf");
		const secondFile = join(makeTempDir(), "second.pdf");
		writeFileSync(firstFile, "%PDF-first");
		writeFileSync(secondFile, "%PDF-second");
		const firstParse = deferred<{ text: string; pageCount: number; pages: Array<{ pageNumber: number; text: string }> }>();
		parseDocumentMock
			.mockImplementationOnce(() => firstParse.promise)
			.mockResolvedValueOnce({
				text: "第二篇资料",
				pageCount: 1,
				pages: [{ pageNumber: 1, text: "第二篇资料" }],
			});

		const firstTool = createL2Tools(root, undefined, fakeMemory(root))[0];
		const secondTool = createL2Tools(root, undefined, fakeMemory(root))[0];
		const firstArchive = archiveFile(firstTool, "call-first", "第一篇", firstFile);
		await vi.waitFor(() => expect(parseDocumentMock).toHaveBeenCalledTimes(1));

		const secondArchive = archiveFile(secondTool, "call-second", "第二篇", secondFile);
		await Promise.resolve();
		expect(parseDocumentMock).toHaveBeenCalledTimes(1);

		firstParse.resolve({
			text: "第一篇资料",
			pageCount: 1,
			pages: [{ pageNumber: 1, text: "第一篇资料" }],
		});
		await Promise.all([firstArchive, secondArchive]);

		expect(parseDocumentMock.mock.calls.map(([filePath]) => filePath)).toEqual([firstFile, secondFile]);
		expect(readManifest(root).map((entry) => entry.title)).toEqual(["第一篇", "第二篇"]);
	});

	it("continues the archive queue after an earlier archive fails", async () => {
		const root = makeTempDir();
		const firstIndex = deferred<void>();
		const memory = fakeMemory(root);
		vi.mocked(memory.indexPageByPath)
			.mockImplementationOnce(() => firstIndex.promise)
			.mockResolvedValue(undefined);
		const firstTool = createL2Tools(root, undefined, memory)[0];
		const secondTool = createL2Tools(root, undefined, memory)[0];

		const firstArchive = (firstTool.execute as (...args: any[]) => Promise<any>)(
			"call-first",
			{ title: "失败资料", content: "第一篇正文", sourceType: "markdown" },
			undefined,
			undefined,
			{ model: undefined, modelRegistry: undefined },
		);
		await vi.waitFor(() => expect(memory.indexPageByPath).toHaveBeenCalledTimes(1));
		const secondArchive = (secondTool.execute as (...args: any[]) => Promise<any>)(
			"call-second",
			{ title: "后续资料", content: "第二篇正文", sourceType: "markdown" },
			undefined,
			undefined,
			{ model: undefined, modelRegistry: undefined },
		);
		await Promise.resolve();
		expect(readManifest(root)).toHaveLength(1);

		firstIndex.reject(new Error("index failed"));
		await expect(firstArchive).rejects.toThrow("index failed");
		await expect(secondArchive).resolves.toMatchObject({ details: { wikiPagePath: expect.any(String) } });
		expect(readManifest(root).find((entry) => entry.title === "后续资料")?.status).toBe("indexed");
	});

	it("does not serialize archives that target different L2 directories", async () => {
		const firstRoot = makeTempDir();
		const secondRoot = makeTempDir();
		const firstFile = join(makeTempDir(), "first.pdf");
		const secondFile = join(makeTempDir(), "second.pdf");
		writeFileSync(firstFile, "%PDF-first");
		writeFileSync(secondFile, "%PDF-second");
		const firstParse = deferred<{ text: string; pageCount: number; pages: Array<{ pageNumber: number; text: string }> }>();
		parseDocumentMock
			.mockImplementationOnce(() => firstParse.promise)
			.mockResolvedValueOnce({
				text: "第二个知识库的资料",
				pageCount: 1,
				pages: [{ pageNumber: 1, text: "第二个知识库的资料" }],
			});

		const firstArchive = archiveFile(createL2Tools(firstRoot, undefined, fakeMemory(firstRoot))[0], "call-first", "第一篇", firstFile);
		await vi.waitFor(() => expect(parseDocumentMock).toHaveBeenCalledTimes(1));
		const secondArchive = archiveFile(createL2Tools(secondRoot, undefined, fakeMemory(secondRoot))[0], "call-second", "第二篇", secondFile);
		await vi.waitFor(() => expect(parseDocumentMock).toHaveBeenCalledTimes(2));
		await secondArchive;

		firstParse.resolve({
			text: "第一个知识库的资料",
			pageCount: 1,
			pages: [{ pageNumber: 1, text: "第一个知识库的资料" }],
		});
		await firstArchive;
	});
});

describe("l2_regenerate", () => {
	it("reprocesses an existing source without changing its id", async () => {
		const root = makeTempDir();
		await archive(root, "初始正文包含 [[Agent]] 概念。");
		const before = readManifest(root)[0];
		writeText(join(root, before.rawPath), "更新后的正文仍包含 [[Agent]] 概念。\n");
		const tool = createL2Tools(root, undefined, fakeMemory(root)).find((candidate) => candidate.name === "l2_regenerate");
		expect(tool).toBeDefined();

		const result = await (tool!.execute as (...args: any[]) => Promise<any>)(
			"call-regenerate",
			{ sourceId: before.id },
			undefined,
			undefined,
			{ model: undefined, modelRegistry: undefined },
		);

		expect(result.details).toMatchObject({ sourceId: before.id, duplicate: false });
		expect(readManifest(root)).toHaveLength(1);
		expect(readManifest(root)[0].id).toBe(before.id);
	});
});
