import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const parseDocumentMock = vi.hoisted(() => vi.fn());
const parseDocumentBytesMock = vi.hoisted(() => vi.fn());
const summarizeContentMock = vi.hoisted(() => vi.fn());
const summarizeContentGroundedMock = vi.hoisted(() => vi.fn());
const completeMock = vi.hoisted(() => vi.fn());

vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-ai")>();
	return { ...actual, complete: completeMock };
});

vi.mock("./document-parser.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./document-parser.js")>();
	return {
		...actual,
		parseDocument: parseDocumentMock,
		parseDocumentBytes: parseDocumentBytesMock,
	};
});

vi.mock("./summarizer.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./summarizer.js")>();
	return {
		...actual,
		summarizeContent: summarizeContentMock,
		summarizeContentGrounded: summarizeContentGroundedMock,
	};
});

import type { L2Memory } from "./l2-memory.js";
import { DocumentParseError } from "./document-parser.js";
import { readEvidenceIndex } from "./evidence-index.js";
import type { EvidenceCandidateSelector, EvidenceSelectionInput } from "./evidence-selector.js";
import { decodeEvidenceRefs } from "./evidence-types.js";
import { createL2Tools } from "./l2-tools.js";
import { runL2Lint } from "./l2-lint.js";
import { upsertManifest, readManifest } from "./manifest-store.js";
import { writeText } from "../../storage/file-store.js";
import { bodyRevision, parseFrontmatter, serializeFrontmatter } from "./wiki-maintainer.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "inno-l2-tools-"));
	tempDirs.push(dir);
	return dir;
}

function isDescendant(root: string, candidate: string): boolean {
	const rel = relative(resolve(root), resolve(candidate));
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function fakeMemory(root: string): L2Memory {
	return {
		dataDir: root,
		indexPageByPath: vi.fn().mockResolvedValue(undefined),
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
	parseDocumentBytesMock.mockReset();
	summarizeContentMock.mockReset();
	summarizeContentGroundedMock.mockReset();
	completeMock.mockReset();
});

describe("l2_archive", () => {
	it("writes traceable raw, extracted, manifest, and wiki records", async () => {
		const root = makeTempDir();
		await archive(root, "正文包含 [[间隔重复]] 概念。");

		const entries = readManifest(root);
		expect(entries).toHaveLength(1);
		expect(entries[0].status).toBe("indexed");
		const rawBytes = readFileSync(join(root, entries[0].rawPath));
		expect(rawBytes.toString("utf8")).toContain("间隔重复");
		expect(entries[0]).toMatchObject({
			rawContentHash: createHash("sha256").update(rawBytes).digest("hex"),
			rawSize: rawBytes.length,
			rawMtimeMs: expect.any(Number),
			rawKind: "archived-text",
		});
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

		expect(parseDocumentMock).toHaveBeenCalledOnce();
		const controlledPath = parseDocumentMock.mock.calls[0][0];
		expect(isDescendant(join(root, "raw"), controlledPath)).toBe(true);
		expect(controlledPath).not.toBe(sourcePath);
		expect(readFileSync(controlledPath, "utf8")).toBe("%PDF-active-workspace");
		const entry = readManifest(root)[0];
		expect(entry.rawPath).toBe(relative(root, controlledPath));
		expect(readFileSync(join(root, entry.rawPath), "utf8")).toBe("%PDF-active-workspace");
		expect(readFileSync(join(root, entry.extractedPath!), "utf8")).toContain("当前会话工作区中的完整资料");
	});

	it("archives a Markdown file byte-for-byte before parsing only the final controlled copy", async () => {
		const root = makeTempDir();
		const workspace = makeTempDir();
		const sourcePath = join(workspace, "lesson.md");
		const originalBytes = Buffer.from("# 原始标题\r\n\r\n正文 🌱\n", "utf8");
		writeFileSync(sourcePath, originalBytes);
		const injectedParser = vi.fn(async (controlledPath: string) => {
			const controlledText = readFileSync(controlledPath, "utf8");
			writeFileSync(sourcePath, "# 工作区已改变\n", "utf8");
			return {
				text: controlledText,
				pageCount: 1,
				pages: [{ pageNumber: 1, text: controlledText }],
			};
		});
		const tool = createL2Tools(root, undefined, fakeMemory(root), () => workspace, injectedParser)[0];

		await (tool.execute as (...args: any[]) => Promise<any>)(
			"call-markdown-file",
			{ title: "原始 Markdown", filePath: "lesson.md", sourceType: "markdown" },
			undefined,
			undefined,
			{ model: undefined, modelRegistry: undefined },
		);

		expect(injectedParser).toHaveBeenCalledOnce();
		const controlledPath = injectedParser.mock.calls[0][0];
		expect(controlledPath).not.toBe(sourcePath);
		expect(isDescendant(join(root, "raw"), controlledPath)).toBe(true);
		expect(controlledPath).not.toContain(`${join("raw", ".staging")}`);
		expect(readFileSync(controlledPath)).toEqual(originalBytes);
		expect(readFileSync(sourcePath, "utf8")).toBe("# 工作区已改变\n");
		expect(readdirSync(join(root, "raw", ".staging"))).toEqual([]);
		const entry = readManifest(root)[0];
		expect(entry).toMatchObject({
			rawPath: relative(root, controlledPath),
			rawContentHash: createHash("sha256").update(originalBytes).digest("hex"),
			rawSize: originalBytes.length,
			rawMtimeMs: expect.any(Number),
			rawKind: "uploaded-original",
		});
	});

	it("keeps image bytes while parsing only the final controlled copy", async () => {
		const root = makeTempDir();
		const sourcePath = join(makeTempDir(), "diagram.png");
		const originalBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
		writeFileSync(sourcePath, originalBytes);
		const injectedParser = vi.fn(async (_controlledPath: string) => ({
			text: "图片中的文字",
			pageCount: 1,
			pages: [{ pageNumber: 1, text: "图片中的文字" }],
		}));
		parseDocumentMock.mockResolvedValue({
			text: "错误的默认 parser",
			pageCount: 1,
			pages: [{ pageNumber: 1, text: "错误的默认 parser" }],
		});
		const tool = createL2Tools(root, undefined, fakeMemory(root), undefined, injectedParser)[0];

		await (tool.execute as (...args: any[]) => Promise<any>)(
			"call-image-file",
			{ title: "图示", filePath: sourcePath, sourceType: "image" },
			undefined,
			undefined,
			{ model: undefined, modelRegistry: undefined },
		);

		expect(injectedParser).toHaveBeenCalledOnce();
		const controlledPath = injectedParser.mock.calls[0][0];
		expect(isDescendant(join(root, "raw"), controlledPath)).toBe(true);
		expect(readFileSync(controlledPath)).toEqual(originalBytes);
		expect(readManifest(root)[0]).toMatchObject({
			rawContentHash: createHash("sha256").update(originalBytes).digest("hex"),
			rawSize: originalBytes.length,
			rawKind: "uploaded-original",
		});
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

		const controlledPaths = parseDocumentMock.mock.calls.map(([filePath]) => filePath);
		expect(controlledPaths.every((filePath) => isDescendant(join(root, "raw"), filePath))).toBe(true);
		expect(controlledPaths.map((filePath) => readFileSync(filePath, "utf8"))).toEqual(["%PDF-first", "%PDF-second"]);
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

	it("generates validated evidence from a real immutable Markdown original without an API key", async () => {
		const root = makeTempDir();
		const workspace = makeTempDir();
		const sourcePath = join(workspace, "forces.md");
		const quote = "Balanced forces have equal magnitude and opposite directions";
		const originalBytes = Buffer.from(
			`# Physics\r\n\r\n${quote}. See [[Balanced Forces]].\r\n`,
			"utf8",
		);
		writeFileSync(sourcePath, originalBytes);
		const actualParser = (await vi.importActual<typeof import("./document-parser.js")>(
			"./document-parser.js",
		)).parseDocument;
		const selector: EvidenceCandidateSelector = {
			select: vi.fn(async (input: Parameters<EvidenceCandidateSelector["select"]>[0]) => {
				const supportingBlock = input.blocks.find((block) => block.text.includes(quote));
				return supportingBlock
					? [{ source_id: input.sourceId, block_id: supportingBlock.id, quote }]
					: [];
			}),
		};
		const selectorFactory = vi.fn(() => selector);
		const tool = createL2Tools(root, undefined, fakeMemory(root), () => workspace, {
			parseDocument: actualParser,
			selectorFactory,
		})[0];

		await (tool.execute as (...args: any[]) => Promise<any>)(
			"call-evidence-markdown",
			{ title: "Forces", filePath: "forces.md", sourceType: "markdown", tags: ["physics"] },
			undefined,
			undefined,
			{ model: undefined, modelRegistry: undefined },
		);

		const manifestEntries = readManifest(root);
		expect(manifestEntries).toHaveLength(1);
		const source = manifestEntries[0];
		expect(source).toMatchObject({
			status: "indexed",
			rawKind: "uploaded-original",
			rawContentHash: createHash("sha256").update(originalBytes).digest("hex"),
			rawSize: originalBytes.length,
		});
		expect(readFileSync(join(root, source.rawPath))).toEqual(originalBytes);
		const evidenceIndex = readEvidenceIndex(root, source.id, source.rawContentHash!);
		expect(evidenceIndex.status).toBe("ready");
		if (evidenceIndex.status !== "ready") throw new Error("expected a ready evidence index");
		expect(evidenceIndex.index.blocks.some((block) => block.text.includes(quote))).toBe(true);
		expect(selectorFactory).toHaveBeenCalledOnce();
		expect(source.wikiPages.length).toBeGreaterThanOrEqual(2);
		for (const pagePath of source.wikiPages) {
			const page = parseFrontmatter(readFileSync(join(root, pagePath), "utf8"));
			const decoded = decodeEvidenceRefs(page.frontmatter?.evidence_refs, page.frontmatter?.source_ids ?? []);
			expect(decoded.issues).toEqual([]);
			expect(decoded.valid).toContainEqual(expect.objectContaining({
				source_id: source.id,
				quote,
				source_revision: `sha256:${source.rawContentHash}`,
				page_revision: bodyRevision(page.body),
				index_version: 1,
				selected_by: "model",
				locator: expect.objectContaining({ kind: "markdown-block", block_id: expect.any(String) }),
			}));
		}
	});

	it("keeps text, conversation, and image archives file-level without invoking evidence selection", async () => {
		const selectorFactory = vi.fn((): EvidenceCandidateSelector => ({
			select: vi.fn(async () => []),
		}));
		const cases: Array<{
			sourceType: "text" | "conversation" | "image";
			params: Record<string, unknown>;
			parseDocument?: (path: string) => Promise<{ text: string; pageCount: number; pages: Array<{ pageNumber: number; text: string }> }>;
		}> = [
			{ sourceType: "text", params: { content: "Plain text source" } },
			{ sourceType: "conversation", params: { content: "Conversation source" } },
			{
				sourceType: "image",
				params: { filePath: "diagram.png" },
				parseDocument: async () => ({
					text: "Text extracted from an image",
					pageCount: 1,
					pages: [{ pageNumber: 1, text: "Text extracted from an image" }],
				}),
			},
		];

		for (const testCase of cases) {
			const root = makeTempDir();
			const workspace = makeTempDir();
			if (testCase.sourceType === "image") {
				writeFileSync(
					join(workspace, "diagram.png"),
					Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]),
				);
			}
			const tool = createL2Tools(root, undefined, fakeMemory(root), () => workspace, {
				parseDocument: testCase.parseDocument ?? parseDocumentMock,
				selectorFactory,
			})[0];

			await (tool.execute as (...args: any[]) => Promise<any>)(
				`call-${testCase.sourceType}`,
				{ title: `${testCase.sourceType} source`, sourceType: testCase.sourceType, ...testCase.params },
				undefined,
				undefined,
				{ model: undefined, modelRegistry: undefined },
			);

			const source = readManifest(root)[0];
			expect(source).toMatchObject({
				status: "indexed",
				rawContentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
				rawSize: expect.any(Number),
				rawMtimeMs: expect.any(Number),
				rawKind: testCase.sourceType === "image" ? "uploaded-original" : "archived-text",
			});
			expect(readEvidenceIndex(root, source.id, source.rawContentHash!)).toEqual({ status: "missing-index" });
			const page = parseFrontmatter(readFileSync(join(root, source.wikiPages[0]), "utf8"));
			expect(page.frontmatter?.sources).toEqual([source.rawPath]);
			expect(page.frontmatter?.source_ids).toEqual([source.id]);
			expect(page.frontmatter?.evidence_refs).toBeUndefined();
		}
		expect(selectorFactory).not.toHaveBeenCalled();
	});

	it("uses a plain summary for sources without a precise evidence index", async () => {
		const root = makeTempDir();
		const plainSummary = "## Summary\n\nA summary without inline evidence markers.";
		summarizeContentMock.mockResolvedValue(plainSummary);
		summarizeContentGroundedMock.mockResolvedValue({
			body: "## Summary\n\nAn unsupported citation [1].",
			citations: [{ marker: 1, quote: "Plain text source" }],
		});
		const tool = createL2Tools(root, undefined, fakeMemory(root))[0];

		await (tool.execute as (...args: any[]) => Promise<any>)(
			"call-text-with-model",
			{ title: "Plain source", sourceType: "text", content: "Plain text source" },
			undefined,
			undefined,
			{ model: {} as never, modelRegistry: {} as never },
		);

		const source = readManifest(root)[0];
		const page = parseFrontmatter(readFileSync(join(root, source.wikiPages[0]), "utf8"));
		expect(summarizeContentMock).toHaveBeenCalledOnce();
		expect(summarizeContentGroundedMock).not.toHaveBeenCalled();
		expect(page.body).toContain(plainSummary);
		expect(page.body).not.toContain("[1]");
		expect(page.frontmatter?.evidence_refs).toBeUndefined();
	});

	it("does not overwrite a source page edited while linked-page maintenance is running", async () => {
		const root = makeTempDir();
		const summary = [
			"## Key concepts",
			"",
			...Array.from({ length: 21 }, (_, index) => `- [[Concept ${index + 1}]]`),
		].join("\n");
		summarizeContentMock.mockResolvedValue(summary);
		const maintenanceStarted = deferred<{ stopReason: string; content: Array<{ type: string; text: string }> }>();
		completeMock
			.mockImplementationOnce(() => maintenanceStarted.promise)
			.mockResolvedValue({
				stopReason: "stop",
				content: [{ type: "text", text: "not valid JSON" }],
			});

		const tool = createL2Tools(root, undefined, fakeMemory(root))[0];
		const archivePromise = (tool.execute as (...args: any[]) => Promise<any>)(
			"call-source-page-edit-race",
			{ title: "Source page race", sourceType: "text", content: "Original source" },
			undefined,
			undefined,
			{
				model: {} as never,
				modelRegistry: { getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: "test", headers: {} }) } as never,
			},
		);

		let sourceFile = "";
		await vi.waitFor(() => {
			const files = readdirSync(join(root, "wiki", "sources"));
			expect(files).toHaveLength(1);
			sourceFile = files[0];
		});
		const sourceAbsolutePath = join(root, "wiki", "sources", sourceFile);
		const current = parseFrontmatter(readFileSync(sourceAbsolutePath, "utf8"));
		expect(current.frontmatter).not.toBeNull();
		const edited = `${serializeFrontmatter(current.frontmatter!)}\n# User edited source summary\n\nThis edit must survive archive maintenance.\n`;
		writeText(sourceAbsolutePath, edited);

		maintenanceStarted.resolve({
			stopReason: "stop",
			content: [{ type: "text", text: "not valid JSON" }],
		});
		await archivePromise;

		expect(readFileSync(sourceAbsolutePath, "utf8")).toBe(edited);
	});

	it("does not attach grounded refs to a source page edited during linked-page maintenance", async () => {
		const root = makeTempDir();
		parseDocumentMock.mockResolvedValue({
			text: "The index reduces scans.",
			pageCount: 1,
			pages: [{ pageNumber: 1, text: "The index reduces scans." }],
		});
		summarizeContentGroundedMock.mockResolvedValue({
			body: "## Summary\n\nThe index reduces scans [1].",
			citations: [{ marker: 1, quote: "The index reduces scans." }],
		});
		const maintenanceStarted = deferred<{ stopReason: string; content: Array<{ type: string; text: string }> }>();
		completeMock.mockImplementationOnce(() => maintenanceStarted.promise);

		const tool = createL2Tools(root, undefined, fakeMemory(root))[0];
		const archivePromise = (tool.execute as (...args: any[]) => Promise<any>)(
			"call-grounded-source-page-edit-race",
			{ title: "Grounded source page race", sourceType: "markdown", content: "The index reduces scans." },
			undefined,
			undefined,
			{
				model: {} as never,
				modelRegistry: { getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: "test", headers: {} }) } as never,
			},
		);

		let sourceFile = "";
		await vi.waitFor(() => {
			const files = readdirSync(join(root, "wiki", "sources"));
			expect(files).toHaveLength(1);
			sourceFile = files[0];
		});
		const sourceAbsolutePath = join(root, "wiki", "sources", sourceFile);
		const current = parseFrontmatter(readFileSync(sourceAbsolutePath, "utf8"));
		expect(current.frontmatter).not.toBeNull();
		const edited = `${serializeFrontmatter(current.frontmatter!)}\n# User edited grounded summary\n\nThe user version keeps [1].\n`;
		writeText(sourceAbsolutePath, edited);

		maintenanceStarted.resolve({
			stopReason: "stop",
			content: [{ type: "text", text: "not valid JSON" }],
		});
		await archivePromise;

		expect(readFileSync(sourceAbsolutePath, "utf8")).toBe(edited);
	});

	it("rejects a linked-page selector quote outside the grounded summary identity", async () => {
		const root = makeTempDir();
		const canonicalQuote = "Balanced forces have equal magnitude";
		const alternateQuote = "opposite directions";
		const sourceText = `${canonicalQuote} and ${alternateQuote}.`;
		parseDocumentMock.mockResolvedValue({
			text: sourceText,
			pageCount: 1,
			pages: [{ pageNumber: 1, text: sourceText }],
		});
		summarizeContentGroundedMock.mockResolvedValue({
			body: `## Summary\n\n[[Balanced Forces]] are supported by the source [1].`,
			citations: [{ marker: 1, quote: canonicalQuote }],
		});
		const selector: EvidenceCandidateSelector = {
			select: vi.fn(async (input: EvidenceSelectionInput) => {
				const block = input.blocks.find((candidate) => candidate.text.includes(alternateQuote));
				return block
					? [{ source_id: input.sourceId, block_id: block.id, quote: alternateQuote }]
					: [];
			}),
		};
		const tool = createL2Tools(root, undefined, fakeMemory(root), undefined, {
			selectorFactory: () => selector,
		})[0];

		await (tool.execute as (...args: any[]) => Promise<any>)(
			"call-grounded-identity",
			{ title: "Grounded identity", sourceType: "markdown", content: sourceText },
			undefined,
			undefined,
			{
				model: {} as never,
				modelRegistry: { getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: false }) } as never,
			},
		);

		const source = readManifest(root)[0];
		expect(source.wikiPages).toHaveLength(2);
		const sourceSummary = parseFrontmatter(readFileSync(join(root, source.wikiPages[0]), "utf8"));
		const summaryRefs = decodeEvidenceRefs(
			sourceSummary.frontmatter?.evidence_refs,
			sourceSummary.frontmatter?.source_ids ?? [],
		).valid;
		expect(summaryRefs).toEqual([
			expect.objectContaining({ quote: canonicalQuote, marker: 1 }),
		]);

		const linkedPage = parseFrontmatter(readFileSync(join(root, source.wikiPages[1]), "utf8"));
		const linkedRefs = decodeEvidenceRefs(
			linkedPage.frontmatter?.evidence_refs,
			linkedPage.frontmatter?.source_ids ?? [],
		).valid;
		expect(linkedRefs).toEqual([]);
		expect(linkedPage.frontmatter?.evidence_refs).toBeUndefined();
	});

	it("preserves an edited source page when retrying a failed archive", async () => {
		const root = makeTempDir();
		const firstMemory = fakeMemory(root);
		vi.mocked(firstMemory.indexPageByPath).mockRejectedValueOnce(new Error("injected index failure"));
		const firstTool = createL2Tools(root, undefined, firstMemory)[0];

		await expect((firstTool.execute as (...args: any[]) => Promise<any>)(
			"call-source-page-retry-first",
			{ title: "Retry page", sourceType: "text", content: "Recoverable source" },
			undefined,
			undefined,
			{ model: undefined, modelRegistry: undefined },
		)).rejects.toThrow("injected index failure");

		const failedEntry = readManifest(root)[0];
		expect(failedEntry).toMatchObject({ status: "error", wikiPages: [expect.any(String)] });
		const sourcePagePath = failedEntry.wikiPages[0];
		const sourceAbsolutePath = join(root, sourcePagePath);
		const current = parseFrontmatter(readFileSync(sourceAbsolutePath, "utf8"));
		expect(current.frontmatter).not.toBeNull();
		const edited = `${serializeFrontmatter(current.frontmatter!)}\n# Manually recovered summary\n\nThis edit must survive the retry.\n`;
		writeText(sourceAbsolutePath, edited);

		const retryMemory = fakeMemory(root);
		const retryTool = createL2Tools(root, undefined, retryMemory)[0];
		await (retryTool.execute as (...args: any[]) => Promise<any>)(
			"call-source-page-retry-second",
			{ title: "Retry page", sourceType: "text", content: "Recoverable source" },
			undefined,
			undefined,
			{ model: undefined, modelRegistry: undefined },
		);

		const recoveredEntry = readManifest(root)[0];
		expect(recoveredEntry).toMatchObject({
			id: failedEntry.id,
			status: "indexed",
			wikiPages: [sourcePagePath],
		});
		expect(readFileSync(sourceAbsolutePath, "utf8")).toBe(edited);
		expect(retryMemory.indexPageByPath).toHaveBeenCalledWith(sourcePagePath);
	});

	it("refreshes an unchanged system-managed source page when retrying a failed archive", async () => {
		const root = makeTempDir();
		const firstSummary = "## Summary\n\nOld system-generated summary.";
		const retrySummary = "## Summary\n\nFresh system-generated summary.";
		summarizeContentMock
			.mockResolvedValueOnce(firstSummary)
			.mockResolvedValueOnce(retrySummary);
		completeMock.mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "not valid JSON" }],
		});
		const modelContext = {
			model: {} as never,
			modelRegistry: {
				getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: "test", headers: {} }),
			} as never,
		};
		const firstMemory = fakeMemory(root);
		vi.mocked(firstMemory.indexPageByPath).mockRejectedValueOnce(new Error("injected index failure"));
		const firstTool = createL2Tools(root, undefined, firstMemory)[0];

		await expect((firstTool.execute as (...args: any[]) => Promise<any>)(
			"call-system-source-page-retry-first",
			{ title: "System retry page", sourceType: "text", content: "Recoverable source" },
			undefined,
			undefined,
			modelContext,
		)).rejects.toThrow("injected index failure");

		const failedEntry = readManifest(root)[0];
		const sourcePagePath = failedEntry.wikiPages[0];
		const sourceAbsolutePath = join(root, sourcePagePath);
		const oldPage = readFileSync(sourceAbsolutePath, "utf8");
		expect(oldPage).toContain(firstSummary);

		const retryMemory = fakeMemory(root);
		const retryTool = createL2Tools(root, undefined, retryMemory)[0];
		await (retryTool.execute as (...args: any[]) => Promise<any>)(
			"call-system-source-page-retry-second",
			{ title: "System retry page", sourceType: "text", content: "Recoverable source" },
			undefined,
			undefined,
			modelContext,
		);

		const recoveredEntry = readManifest(root)[0];
		const refreshedPage = readFileSync(sourceAbsolutePath, "utf8");
		expect(recoveredEntry).toMatchObject({
			id: failedEntry.id,
			status: "indexed",
			wikiPages: [sourcePagePath],
		});
		expect(refreshedPage).toContain(retrySummary);
		expect(refreshedPage).not.toContain(firstSummary);
		expect(retryMemory.indexPageByPath).toHaveBeenCalledWith(sourcePagePath);
	});

	it("persists parse failures and retries only the same immutable raw revision", async () => {
		const root = makeTempDir();
		const workspace = makeTempDir();
		const sourcePath = join(workspace, "retry.pdf");
		writeFileSync(sourcePath, "%PDF-original-revision", "utf8");
		const failingParser = vi.fn(async () => {
			throw new DocumentParseError("injected parse failure", "PARSE_ERROR");
		});
		const firstTool = createL2Tools(root, undefined, fakeMemory(root), () => workspace, {
			parseDocument: failingParser,
		})[0];

		const failure = await (firstTool.execute as (...args: any[]) => Promise<any>)(
			"call-failed-parse",
			{ title: "Retry source", filePath: "retry.pdf", sourceType: "pdf" },
			undefined,
			undefined,
			{ model: undefined, modelRegistry: undefined },
		);

		expect(failure.details.error).toBe("PARSE_ERROR");
		const failedEntry = readManifest(root)[0];
		expect(failedEntry).toMatchObject({
			status: "error",
			rawContentHash: createHash("sha256").update("%PDF-original-revision").digest("hex"),
			rawKind: "uploaded-original",
		});
		expect(failedEntry.extractedPath).toBeUndefined();
		expect(readFileSync(join(root, failedEntry.rawPath), "utf8")).toBe("%PDF-original-revision");

		writeFileSync(sourcePath, "%PDF-workspace-now-different", "utf8");
		parseDocumentBytesMock.mockImplementation(async (_controlledPath: string, bytes: Buffer) => {
			const controlledText = bytes.toString("utf8");
			return {
				text: `Parsed ${controlledText}`,
				pageCount: 1,
				pages: [{ pageNumber: 1, text: `Parsed ${controlledText}` }],
			};
		});
		const retryTool = createL2Tools(root, undefined, fakeMemory(root), () => workspace, {
			parseDocument: vi.fn(),
		})[0];
		await (retryTool.execute as (...args: any[]) => Promise<any>)(
			"call-retry-parse",
			{ title: "Retry source", filePath: "retry.pdf", sourceType: "pdf" },
			undefined,
			undefined,
			{ model: undefined, modelRegistry: undefined },
		);

		const recoveredEntries = readManifest(root);
		expect(recoveredEntries).toHaveLength(1);
		expect(recoveredEntries[0]).toMatchObject({
			id: failedEntry.id,
			rawPath: failedEntry.rawPath,
			rawContentHash: failedEntry.rawContentHash,
			status: "indexed",
		});
		expect(parseDocumentBytesMock).toHaveBeenCalledOnce();
		expect(parseDocumentBytesMock.mock.calls[0][0].toLowerCase()).toBe(
			join(root, failedEntry.rawPath).toLowerCase(),
		);
		expect(parseDocumentBytesMock.mock.calls[0][1]).toEqual(Buffer.from("%PDF-original-revision", "utf8"));
		expect(readFileSync(join(root, recoveredEntries[0].extractedPath!), "utf8")).toContain(
			"%PDF-original-revision",
		);
		expect(readEvidenceIndex(root, failedEntry.id, failedEntry.rawContentHash!).status).toBe("ready");
		expect(readFileSync(sourcePath, "utf8")).toBe("%PDF-workspace-now-different");
	});

	it("does not recover a manifest raw path through a directory link", async () => {
		const root = makeTempDir();
		const outside = makeTempDir();
		const workspace = makeTempDir();
		const escapedBytes = Buffer.from("%PDF-escaped-revision", "utf8");
		const workspaceBytes = Buffer.from("%PDF-workspace-revision", "utf8");
		mkdirSync(join(root, "raw"), { recursive: true });
		writeFileSync(join(outside, "escaped.pdf"), escapedBytes);
		symlinkSync(outside, join(root, "raw", "escape"), process.platform === "win32" ? "junction" : "dir");
		writeFileSync(join(workspace, "retry.pdf"), workspaceBytes);
		upsertManifest(root, {
			id: "l2src_escaped",
			title: "Escaped recovery",
			sourceType: "pdf",
			rawPath: "raw/escape/escaped.pdf",
			wikiPages: [],
			tags: [],
			contentHash: "failed-content",
			rawContentHash: createHash("sha256").update(escapedBytes).digest("hex"),
			rawKind: "uploaded-original",
			status: "error",
			source: { origin: "user_upload" },
			createdAt: "2026-08-14T00:00:00.000Z",
			updatedAt: "2026-08-14T00:00:00.000Z",
		});
		const parser = vi.fn(async (controlledPath: string) => {
			const text = readFileSync(controlledPath, "utf8");
			return { text, pageCount: 1, pages: [{ pageNumber: 1, text }] };
		});
		const tool = createL2Tools(root, undefined, fakeMemory(root), () => workspace, {
			parseDocument: parser,
		})[0];

		await (tool.execute as (...args: any[]) => Promise<any>)(
			"call-escaped-recovery",
			{ title: "Escaped recovery", filePath: "retry.pdf", sourceType: "pdf" },
			undefined,
			undefined,
			{ model: undefined, modelRegistry: undefined },
		);

		const entries = readManifest(root);
		expect(entries).toHaveLength(2);
		expect(entries[0]).toMatchObject({ id: "l2src_escaped", status: "error" });
		expect(entries[1]).toMatchObject({
			status: "indexed",
			rawContentHash: createHash("sha256").update(workspaceBytes).digest("hex"),
		});
		expect(parser).toHaveBeenCalledOnce();
		expect(readFileSync(parser.mock.calls[0][0])).toEqual(workspaceBytes);
	});

	it("parses recovered raw bytes from the same verified snapshot used for its revision", async () => {
		const root = makeTempDir();
		const workspace = makeTempDir();
		const originalBytes = Buffer.from("%PDF-original-snapshot", "utf8");
		const replacementBytes = Buffer.from("%PDF-replaced-snapshot", "utf8");
		const rawPath = "raw/uploads/retry.pdf";
		writeText(join(root, rawPath), originalBytes.toString("utf8"));
		writeFileSync(join(workspace, "retry.pdf"), "%PDF-workspace-now-different", "utf8");
		upsertManifest(root, {
			id: "l2src_snapshot",
			title: "Snapshot recovery",
			sourceType: "pdf",
			rawPath,
			wikiPages: [],
			tags: [],
			contentHash: "failed-content",
			rawContentHash: createHash("sha256").update(originalBytes).digest("hex"),
			rawKind: "uploaded-original",
			status: "error",
			source: { origin: "user_upload" },
			createdAt: "2026-08-14T00:00:00.000Z",
			updatedAt: "2026-08-14T00:00:00.000Z",
		});
		parseDocumentMock.mockImplementation(async (controlledPath: string) => {
			writeFileSync(controlledPath, replacementBytes);
			const text = readFileSync(controlledPath, "utf8");
			return { text, pageCount: 1, pages: [{ pageNumber: 1, text }] };
		});
		parseDocumentBytesMock.mockImplementation(async (_displayPath: string, bytes: Buffer) => {
			const text = bytes.toString("utf8");
			return { text, pageCount: 1, pages: [{ pageNumber: 1, text }] };
		});
		const tool = createL2Tools(root, undefined, fakeMemory(root), () => workspace)[0];

		await (tool.execute as (...args: any[]) => Promise<any>)(
			"call-snapshot-recovery",
			{ title: "Snapshot recovery", filePath: "retry.pdf", sourceType: "pdf" },
			undefined,
			undefined,
			{ model: undefined, modelRegistry: undefined },
		);

		expect(parseDocumentBytesMock).toHaveBeenCalledOnce();
		expect(parseDocumentBytesMock.mock.calls[0][1]).toEqual(originalBytes);
		expect(parseDocumentMock).not.toHaveBeenCalled();
		const entry = readManifest(root)[0];
		expect(entry).toMatchObject({
			id: "l2src_snapshot",
			rawContentHash: createHash("sha256").update(originalBytes).digest("hex"),
			status: "indexed",
		});
		expect(readFileSync(join(root, entry.extractedPath!), "utf8")).toContain(originalBytes.toString("utf8"));
		expect(readFileSync(join(root, rawPath))).toEqual(originalBytes);
	});

	it("creates a new source record when a failed archive's raw revision has changed", async () => {
		const root = makeTempDir();
		const workspace = makeTempDir();
		const sourcePath = join(workspace, "changed.pdf");
		writeFileSync(sourcePath, "%PDF-first-revision", "utf8");
		const failingTool = createL2Tools(root, undefined, fakeMemory(root), () => workspace, {
			parseDocument: vi.fn(async () => {
				throw new DocumentParseError("first parse failed", "PARSE_ERROR");
			}),
		})[0];
		await (failingTool.execute as (...args: any[]) => Promise<any>)(
			"call-first-revision",
			{ title: "Changed retry", filePath: "changed.pdf", sourceType: "pdf" },
			undefined,
			undefined,
			{ model: undefined, modelRegistry: undefined },
		);
		const failedEntry = readManifest(root)[0];
		writeFileSync(join(root, failedEntry.rawPath), "%PDF-tampered-archive", "utf8");
		writeFileSync(sourcePath, "%PDF-second-revision", "utf8");
		const retryTool = createL2Tools(root, undefined, fakeMemory(root), () => workspace, {
			parseDocument: async (controlledPath) => ({
				text: readFileSync(controlledPath, "utf8"),
				pageCount: 1,
				pages: [{ pageNumber: 1, text: readFileSync(controlledPath, "utf8") }],
			}),
		})[0];
		await (retryTool.execute as (...args: any[]) => Promise<any>)(
			"call-second-revision",
			{ title: "Changed retry", filePath: "changed.pdf", sourceType: "pdf" },
			undefined,
			undefined,
			{ model: undefined, modelRegistry: undefined },
		);

		const entries = readManifest(root);
		expect(entries).toHaveLength(2);
		expect(entries[0]).toMatchObject({ id: failedEntry.id, status: "error" });
		expect(entries[1]).toMatchObject({
			status: "indexed",
			rawContentHash: createHash("sha256").update("%PDF-second-revision").digest("hex"),
		});
		expect(entries[1].id).not.toBe(failedEntry.id);
		expect(readFileSync(join(root, entries[1].rawPath), "utf8")).toBe("%PDF-second-revision");
	});

	it("does not merge different precise raw files that extract to the same text", async () => {
		const root = makeTempDir();
		const workspace = makeTempDir();
		writeFileSync(join(workspace, "first.pdf"), "%PDF-first-bytes", "utf8");
		writeFileSync(join(workspace, "second.pdf"), "%PDF-second-bytes", "utf8");
		const parser = async () => ({
			text: "The same extracted evidence",
			pageCount: 1,
			pages: [{ pageNumber: 1, text: "The same extracted evidence" }],
		});

		for (const [title, filePath] of [["First precise source", "first.pdf"], ["Second precise source", "second.pdf"]]) {
			const tool = createL2Tools(root, undefined, fakeMemory(root), () => workspace, { parseDocument: parser })[0];
			await (tool.execute as (...args: any[]) => Promise<any>)(
				`call-${filePath}`,
				{ title, filePath, sourceType: "pdf" },
				undefined,
				undefined,
				{ model: undefined, modelRegistry: undefined },
			);
		}

		const entries = readManifest(root);
		expect(entries).toHaveLength(2);
		expect(entries.map((entry) => entry.contentHash)).toEqual([entries[0].contentHash, entries[0].contentHash]);
		expect(new Set(entries.map((entry) => entry.rawContentHash)).size).toBe(2);
		expect(entries.every((entry) => readEvidenceIndex(root, entry.id, entry.rawContentHash!).status === "ready")).toBe(true);
	});

	it("deduplicates the same precise raw revision even when a legacy manifest lacks its hash", async () => {
		const root = makeTempDir();
		const workspace = makeTempDir();
		writeFileSync(join(workspace, "first.pdf"), "%PDF-identical-bytes", "utf8");
		writeFileSync(join(workspace, "second.pdf"), "%PDF-identical-bytes", "utf8");
		const parser = async () => ({
			text: "Identical extracted evidence",
			pageCount: 1,
			pages: [{ pageNumber: 1, text: "Identical extracted evidence" }],
		});
		const firstTool = createL2Tools(root, undefined, fakeMemory(root), () => workspace, { parseDocument: parser })[0];
		await (firstTool.execute as (...args: any[]) => Promise<any>)(
			"call-first-identical",
			{ title: "First identical source", filePath: "first.pdf", sourceType: "pdf" },
			undefined,
			undefined,
			{ model: undefined, modelRegistry: undefined },
		);
		const legacyEntry = { ...readManifest(root)[0] };
		delete legacyEntry.rawContentHash;
		upsertManifest(root, legacyEntry);

		const secondTool = createL2Tools(root, undefined, fakeMemory(root), () => workspace, { parseDocument: parser })[0];
		const duplicate = await (secondTool.execute as (...args: any[]) => Promise<any>)(
			"call-second-identical",
			{ title: "Second identical source", filePath: "second.pdf", sourceType: "pdf" },
			undefined,
			undefined,
			{ model: undefined, modelRegistry: undefined },
		);

		expect(readManifest(root)).toHaveLength(1);
		expect(duplicate.details).toMatchObject({ id: legacyEntry.id, duplicate: true });
	});

	it("creates a new source record when a failed content archive raw revision has changed", async () => {
		const root = makeTempDir();
		const content = "# Archived content\n\nStable user text.\n";
		const failingTool = createL2Tools(root, undefined, fakeMemory(root), undefined, {
			parseDocument: vi.fn(async () => {
				throw new DocumentParseError("first content parse failed", "PARSE_ERROR");
			}),
		})[0];
		await (failingTool.execute as (...args: any[]) => Promise<any>)(
			"call-first-content-revision",
			{ title: "Changed content retry", content, sourceType: "markdown" },
			undefined,
			undefined,
			{ model: undefined, modelRegistry: undefined },
		);
		const failedEntry = readManifest(root)[0];
		writeFileSync(join(root, failedEntry.rawPath), "tampered archived content", "utf8");

		const retryTool = createL2Tools(root, undefined, fakeMemory(root), undefined, {
			parseDocument: async () => ({
				text: content,
				pageCount: 1,
				pages: [{ pageNumber: 1, text: content }],
			}),
		})[0];
		await (retryTool.execute as (...args: any[]) => Promise<any>)(
			"call-second-content-revision",
			{ title: "Changed content retry", content, sourceType: "markdown" },
			undefined,
			undefined,
			{ model: undefined, modelRegistry: undefined },
		);

		const entries = readManifest(root);
		expect(entries).toHaveLength(2);
		expect(entries[0]).toMatchObject({ id: failedEntry.id, status: "error" });
		expect(entries[1]).toMatchObject({ status: "indexed", rawKind: "archived-text" });
		expect(entries[1].id).not.toBe(failedEntry.id);
	});

	it("keeps archived-text provenance when recovering a legacy content record", async () => {
		const root = makeTempDir();
		const content = "# Legacy archived content\n";
		const failingTool = createL2Tools(root, undefined, fakeMemory(root), undefined, {
			parseDocument: vi.fn(async () => {
				throw new DocumentParseError("legacy parse failed", "PARSE_ERROR");
			}),
		})[0];
		await (failingTool.execute as (...args: any[]) => Promise<any>)(
			"call-legacy-content-failure",
			{ title: "Legacy content", content, sourceType: "markdown" },
			undefined,
			undefined,
			{ model: undefined, modelRegistry: undefined },
		);
		const legacyEntry = { ...readManifest(root)[0] };
		delete legacyEntry.rawKind;
		upsertManifest(root, legacyEntry);

		const retryTool = createL2Tools(root, undefined, fakeMemory(root), undefined, {
			parseDocument: async () => ({
				text: content,
				pageCount: 1,
				pages: [{ pageNumber: 1, text: content }],
			}),
		})[0];
		await (retryTool.execute as (...args: any[]) => Promise<any>)(
			"call-legacy-content-retry",
			{ title: "Legacy content", content, sourceType: "markdown" },
			undefined,
			undefined,
			{ model: undefined, modelRegistry: undefined },
		);

		expect(readManifest(root)).toHaveLength(1);
		expect(readManifest(root)[0]).toMatchObject({ id: legacyEntry.id, status: "indexed", rawKind: "archived-text" });
	});

	it.each(["pdf", "word"] as const)("requires filePath for %s archives", async (sourceType) => {
		const root = makeTempDir();
		const parser = vi.fn();
		const selectorFactory = vi.fn();
		const tool = createL2Tools(root, undefined, fakeMemory(root), undefined, {
			parseDocument: parser,
			selectorFactory,
		})[0];

		const result = await (tool.execute as (...args: any[]) => Promise<any>)(
			`call-${sourceType}-content`,
			{ title: `${sourceType} content`, content: "not a file", sourceType },
			undefined,
			undefined,
			{ model: undefined, modelRegistry: undefined },
		);

		expect(result.details).toEqual({ error: "file_path_required" });
		expect(readManifest(root)).toEqual([]);
		expect(parser).not.toHaveBeenCalled();
		expect(selectorFactory).not.toHaveBeenCalled();
	});
});
