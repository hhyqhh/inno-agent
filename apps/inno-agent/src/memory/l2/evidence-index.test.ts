import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fsTrace = vi.hoisted(() => ({
	failFsync: false,
	beforeFsync: undefined as (() => void) | undefined,
	descriptorPaths: new Map<number, string>(),
	collideOnExclusiveOpen: false,
	collisionPath: undefined as string | undefined,
	pathUseTarget: undefined as string | undefined,
	beforePathUse: undefined as (() => void) | undefined,
	targetPayloadReads: 0,
	temporaryPath: undefined as string | undefined,
	afterTemporaryClose: undefined as ((path: string) => void) | undefined,
	failFsyncWithPath: false,
}));

const parseTrace = vi.hoisted(() => ({
	beforeParse: undefined as ((filePath: string) => void) | undefined,
	afterParse: undefined as ((filePath: string) => void) | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		openSync(path: string, flags: string | number, mode?: number) {
			if (
				fsTrace.beforePathUse
				&& (fsTrace.pathUseTarget === path || fsTrace.pathUseTarget === undefined)
			) {
				const beforePathUse = fsTrace.beforePathUse;
				fsTrace.beforePathUse = undefined;
				beforePathUse();
			}
			if (flags === "wx" && fsTrace.collideOnExclusiveOpen) {
				actual.writeFileSync(path, "owned by another writer", "utf8");
				fsTrace.collisionPath = path;
				throw Object.assign(new Error("injected exclusive-open collision"), { code: "EEXIST" });
			}
			const descriptor = actual.openSync(path, flags, mode);
			fsTrace.descriptorPaths.set(descriptor, path);
			if (flags === "wx") fsTrace.temporaryPath = path;
			return descriptor;
		},
		readFileSync(...args: unknown[]) {
			const input = args[0];
			const path = typeof input === "number" ? fsTrace.descriptorPaths.get(input) : input;
			if (fsTrace.pathUseTarget === path && fsTrace.beforePathUse) {
				const beforePathUse = fsTrace.beforePathUse;
				fsTrace.beforePathUse = undefined;
				beforePathUse();
			}
			if (fsTrace.pathUseTarget === path) fsTrace.targetPayloadReads += 1;
			return (actual.readFileSync as (...inner: unknown[]) => unknown)(...args);
		},
		fsyncSync(descriptor: number) {
			fsTrace.beforeFsync?.();
			if (fsTrace.failFsync) throw new Error("injected fsync failure");
			if (fsTrace.failFsyncWithPath) {
				throw new Error(`injected fsync failure at ${fsTrace.descriptorPaths.get(descriptor)}`);
			}
			actual.fsyncSync(descriptor);
		},
		closeSync(descriptor: number) {
			const path = fsTrace.descriptorPaths.get(descriptor);
			try {
				actual.closeSync(descriptor);
			} finally {
				fsTrace.descriptorPaths.delete(descriptor);
			}
			if (path !== undefined && path === fsTrace.temporaryPath && fsTrace.afterTemporaryClose) {
				const afterTemporaryClose = fsTrace.afterTemporaryClose;
				fsTrace.afterTemporaryClose = undefined;
				afterTemporaryClose(path);
			}
		},
	};
});

vi.mock("./document-parser.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./document-parser.js")>();
	return {
		...actual,
		async parseDocument(filePath: string) {
			parseTrace.beforeParse?.(filePath);
			try {
				return await actual.parseDocument(filePath);
			} finally {
				parseTrace.afterParse?.(filePath);
			}
		},
		async parseDocumentBytes(displayFilePath: string, bytes: Buffer) {
			parseTrace.beforeParse?.(displayFilePath);
			try {
				return await actual.parseDocumentBytes(displayFilePath, bytes);
			} finally {
				parseTrace.afterParse?.(displayFilePath);
			}
		},
	};
});

import type { ParsedDocumentResult } from "./document-parser.js";
import {
	buildEvidenceIndex,
	normalizeEvidenceTextForQuoteMatching,
	readEvidenceIndex,
	rebuildEvidenceIndex,
	writeEvidenceIndexAtomic,
} from "./evidence-index.js";
import type { SourceEvidenceIndex } from "./evidence-index.js";
import { upsertManifest } from "./manifest-store.js";
import { archiveRawContent } from "./raw-store.js";
import { ensureL2Directories } from "./wiki-maintainer.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "inno-evidence-index-"));
	tempDirs.push(dir);
	return dir;
}

function parsed(text: string, pages: ParsedDocumentResult["pages"] = [{ pageNumber: 1, text }]): ParsedDocumentResult {
	return { text, pageCount: pages.length, pages };
}

function hash(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function evidencePath(root: string, sourceId: string): string {
	return join(root, "extracted", "evidence", "by-id", `${hash(sourceId)}.json`);
}

function writePersistedIndex(root: string, sourceId: string, value: unknown): void {
	const path = evidencePath(root, sourceId);
	ensureL2Directories(root);
	writeFileSync(path, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function pdfIndex(sourceId = "l2src_pdf", rawContentHash = "a".repeat(64)): SourceEvidenceIndex {
	return buildEvidenceIndex({
		sourceId,
		sourceType: "pdf",
		rawContentHash,
		parsed: parsed("Evidence", [{ pageNumber: 1, text: "Evidence" }]),
	});
}

function directoryLink(target: string, link: string): void {
	symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

function upsertMarkdownSource(
	root: string,
	sourceId: string,
	rawPath: string,
	absoluteRawPath: string,
	rawContentHash?: string,
): void {
	const rawStat = statSync(absoluteRawPath);
	upsertManifest(root, {
		id: sourceId,
		title: "Rebuild source",
		sourceType: "markdown",
		rawPath,
		wikiPages: [],
		tags: [],
		contentHash: "legacy-content-hash",
		...(rawContentHash === undefined ? {} : { rawContentHash }),
		rawSize: rawStat.size,
		rawMtimeMs: rawStat.mtimeMs,
		rawKind: "uploaded-original",
		status: "indexed",
		source: { origin: "user_upload" },
		createdAt: "2026-08-15T00:00:00.000Z",
		updatedAt: "2026-08-15T00:00:00.000Z",
	});
}

afterEach(() => {
	fsTrace.failFsync = false;
	fsTrace.beforeFsync = undefined;
	fsTrace.descriptorPaths.clear();
	fsTrace.collideOnExclusiveOpen = false;
	fsTrace.collisionPath = undefined;
	fsTrace.pathUseTarget = undefined;
	fsTrace.beforePathUse = undefined;
	fsTrace.targetPayloadReads = 0;
	fsTrace.temporaryPath = undefined;
	fsTrace.afterTemporaryClose = undefined;
	fsTrace.failFsyncWithPath = false;
	parseTrace.beforeParse = undefined;
	parseTrace.afterParse = undefined;
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("buildEvidenceIndex", () => {
	it("normalizes only NFC and line endings in stored PDF blocks and collapses whitespace in the quote view", () => {
		const decomposed = "  Cafe\u0301\r\nkeeps  spacing  \r\n \r\nSecond\rline";
		const index = buildEvidenceIndex({
			sourceId: "l2src_pdf",
			sourceType: "pdf",
			rawContentHash: "a".repeat(64),
			parsed: parsed(decomposed, [{ pageNumber: 7, text: decomposed }]),
		});

		expect(index.blocks).toEqual([
			{
				id: `pdf:p007:b001:${hash("  Caf\u00e9\nkeeps  spacing  ").slice(0, 12)}`,
				kind: "pdf",
				text: "  Caf\u00e9\nkeeps  spacing  ",
				page: 7,
			},
			{
				id: `pdf:p007:b002:${hash("Second\nline").slice(0, 12)}`,
				kind: "pdf",
				text: "Second\nline",
				page: 7,
			},
		]);
		expect(normalizeEvidenceTextForQuoteMatching(" \tCafe\u0301\r\nkeeps  spacing \n")).toBe("Caf\u00e9 keeps spacing");
		expect(normalizeEvidenceTextForQuoteMatching(index.blocks[0].text)).toBe("Caf\u00e9 keeps spacing");
	});

	it("keeps PDF block IDs stable for equivalent NFC and LF text but not collapsed stored whitespace", () => {
		const base = buildEvidenceIndex({
			sourceId: "l2src_pdf",
			sourceType: "pdf",
			rawContentHash: "a".repeat(64),
			parsed: parsed("Cafe\u0301\r\nwide  gap", [{ pageNumber: 2, text: "Cafe\u0301\r\nwide  gap" }]),
		});
		const canonical = buildEvidenceIndex({
			sourceId: "l2src_pdf",
			sourceType: "pdf",
			rawContentHash: "a".repeat(64),
			parsed: parsed("Caf\u00e9\nwide  gap", [{ pageNumber: 2, text: "Caf\u00e9\nwide  gap" }]),
		});
		const collapsed = buildEvidenceIndex({
			sourceId: "l2src_pdf",
			sourceType: "pdf",
			rawContentHash: "a".repeat(64),
			parsed: parsed("Caf\u00e9\nwide gap", [{ pageNumber: 2, text: "Caf\u00e9\nwide gap" }]),
		});

		expect(base.blocks[0].id).toBe(canonical.blocks[0].id);
		expect(base.extracted_content_hash).toBe(canonical.extracted_content_hash);
		expect(collapsed.blocks[0].id).not.toBe(base.blocks[0].id);
		expect(normalizeEvidenceTextForQuoteMatching(collapsed.blocks[0].text)).toBe(
			normalizeEvidenceTextForQuoteMatching(base.blocks[0].text),
		);
	});

	it("groups Markdown headings, paragraphs, lists, tables, and fenced code into stable document blocks", () => {
		const markdown = [
			"# Repeat",
			"",
			"Intro  keeps spaces.",
			"",
			"- one",
			"",
			"- two",
			"",
			"| A | B |",
			"| --- | --- |",
			"| 1 | 2 |",
			"",
			"```ts",
			"const x = 1;",
			"",
			"# not a heading",
			"```",
			"",
			"# Repeat",
			"",
			"Outro",
		].join("\n");
		const index = buildEvidenceIndex({
			sourceId: "l2src_markdown",
			sourceType: "markdown",
			rawContentHash: "b".repeat(64),
			parsed: parsed("parser output must not win"),
			markdownContent: markdown,
		});
		const texts = [
			"# Repeat",
			"Intro  keeps spaces.",
			"- one\n\n- two",
			"| A | B |\n| --- | --- |\n| 1 | 2 |",
			"```ts\nconst x = 1;\n\n# not a heading\n```",
			"# Repeat",
			"Outro",
		];

		expect(index.blocks.map((block) => block.text)).toEqual(texts);
		expect(index.blocks.map((block, ordinal) => block.id)).toEqual(
			texts.map((text, ordinal) => `md:b${String(ordinal + 1).padStart(4, "0")}:${hash(text).slice(0, 12)}`),
		);
		expect(index.blocks.map(({ heading, paragraph }) => ({ heading, paragraph }))).toEqual([
			{ heading: "Repeat", paragraph: 1 },
			{ heading: "Repeat", paragraph: 2 },
			{ heading: "Repeat", paragraph: 3 },
			{ heading: "Repeat", paragraph: 4 },
			{ heading: "Repeat", paragraph: 5 },
			{ heading: "Repeat", paragraph: 1 },
			{ heading: "Repeat", paragraph: 2 },
		]);
		expect(index.blocks[0].id).not.toBe(index.blocks[5].id);
	});

	it("uses exact supplied Markdown and removes only verified raw-store acquisition frontmatter", () => {
		const userContent = "# Cafe\u0301\r\n\r\nBody  exact\r\n";
		const archived = [
			"---",
			"source_type: markdown",
			"ingested: 2026-08-15",
			`sha256: ${hash(userContent)}`,
			"---",
			"",
			userContent,
		].join("\n");
		const index = buildEvidenceIndex({
			sourceId: "l2src_content_markdown",
			sourceType: "markdown",
			rawContentHash: "c".repeat(64),
			parsed: parsed("# Wrong\n\nParser output"),
			markdownContent: archived,
		});

		expect(index.blocks.map((block) => block.text)).toEqual(["# Caf\u00e9", "Body  exact"]);
		expect(index.blocks.every((block) => !block.text.includes("source_type:"))).toBe(true);
	});

	it("preserves a leading newline in verified archived Markdown payloads", () => {
		const userContent = "\n# Starts with a newline\n\nEvidence body.\n";
		const archived = [
			"---",
			"source_type: markdown",
			"ingested: 2026-08-15",
			`sha256: ${hash(userContent)}`,
			"---",
			userContent,
		].join("\n");

		const index = buildEvidenceIndex({
			sourceId: "l2src_leading_newline",
			sourceType: "markdown",
			rawContentHash: "c".repeat(64),
			parsed: parsed("# Wrong parser result"),
			markdownContent: archived,
		});

		expect(index.blocks[0]?.text).toBe("# Starts with a newline");
		expect(index.blocks.every((block) => !block.text.includes("source_type:"))).toBe(true);
	});

	it("preserves wrapper-shaped Markdown returned by the file parser", () => {
		const userContent = "# Uploaded original\n";
		const uploadedOriginal = [
			"---",
			"source_type: markdown",
			"ingested: 2026-08-15",
			`sha256: ${hash(userContent)}`,
			"---",
			"",
			userContent,
		].join("\n");
		const index = buildEvidenceIndex({
			sourceId: "l2src_uploaded_markdown",
			sourceType: "markdown",
			rawContentHash: "e".repeat(64),
			parsed: parsed(uploadedOriginal),
		});

		expect(index.blocks[0].text).toContain("source_type: markdown");
		expect(index.blocks.map((block) => block.text)).toContain("# Uploaded original");
	});

	it.each([
		"short",
		"A".repeat(64),
		"g".repeat(64),
	])("rejects a non-canonical raw content hash: %s", (rawContentHash) => {
		expect(() => buildEvidenceIndex({
			sourceId: "l2src_bad_revision",
			sourceType: "pdf",
			rawContentHash,
			parsed: parsed("Evidence"),
		})).toThrow(/full lowercase SHA-256/i);
	});

	it("uses non-empty DOCX parser paragraphs in document order", () => {
		const text = " First  paragraph \r\n\r\nCafe\u0301\rThird";
		const index = buildEvidenceIndex({
			sourceId: "l2src_docx",
			sourceType: "word",
			rawContentHash: "d".repeat(64),
			parsed: parsed(text),
		});
		const texts = [" First  paragraph ", "Caf\u00e9", "Third"];

		expect(index.blocks).toEqual(texts.map((paragraphText, ordinal) => ({
			id: `docx:p${String(ordinal + 1).padStart(4, "0")}:${hash(paragraphText).slice(0, 12)}`,
			kind: "docx",
			text: paragraphText,
			paragraph: ordinal + 1,
		})));
	});
});

describe("evidence index persistence", () => {
	it("maps source IDs only through their full lowercase SHA-256 filename", () => {
		const root = makeTempDir();
		const sourceId = "../../Visible-Source-ID/\u79d8\u5bc6";
		const index = pdfIndex(sourceId);

		writeEvidenceIndexAtomic(root, index);

		const expectedName = `${hash(sourceId)}.json`;
		const files = readdirSync(join(root, "extracted", "evidence", "by-id"));
		expect(files).toEqual([expectedName]);
		expect(expectedName).toMatch(/^[0-9a-f]{64}\.json$/);
		expect(expectedName).not.toContain("Visible-Source-ID");
		expect(JSON.parse(readFileSync(evidencePath(root, sourceId), "utf8"))).toEqual(index);
	});

	it("creates the evidence directory during standard L2 initialization", () => {
		const root = makeTempDir();
		ensureL2Directories(root);

		expect(statSync(join(root, "extracted", "evidence", "by-id")).isDirectory()).toBe(true);
	});

	it("keeps the prior complete JSON visible when a replacement fails before rename", () => {
		const root = makeTempDir();
		const sourceId = "l2src_atomic";
		const original = pdfIndex(sourceId);
		const replacement = buildEvidenceIndex({
			sourceId,
			sourceType: "pdf",
			rawContentHash: original.raw_content_hash,
			parsed: parsed("Replacement", [{ pageNumber: 1, text: "Replacement" }]),
		});
		writeEvidenceIndexAtomic(root, original);
		let observedDuringFlush: ReturnType<typeof readEvidenceIndex> | undefined;
		fsTrace.beforeFsync = () => {
			observedDuringFlush = readEvidenceIndex(root, sourceId, original.raw_content_hash);
		};
		fsTrace.failFsync = true;

		expect(() => writeEvidenceIndexAtomic(root, replacement)).toThrow("Evidence index write failed.");
		expect(observedDuringFlush).toEqual({ status: "ready", index: original });
		expect(JSON.parse(readFileSync(evidencePath(root, sourceId), "utf8"))).toEqual(original);
		expect(readdirSync(dirname(evidencePath(root, sourceId)))).toEqual([`${hash(sourceId)}.json`]);
	});

	it("does not delete a pre-existing temporary file after an exclusive-open collision", () => {
		const root = makeTempDir();
		fsTrace.collideOnExclusiveOpen = true;

		expect(() => writeEvidenceIndexAtomic(root, pdfIndex("l2src_collision"))).toThrow(
			"Evidence index write failed.",
		);
		expect(fsTrace.collisionPath).toBeDefined();
		expect(readFileSync(fsTrace.collisionPath!, "utf8")).toBe("owned by another writer");
		expect(existsSync(evidencePath(root, "l2src_collision"))).toBe(false);
	});

	it("does not publish a temporary file replaced after its handle closes", () => {
		const root = makeTempDir();
		const sourceId = "l2src_replaced_temporary";
		let preservedTemporaryPath: string | undefined;
		fsTrace.afterTemporaryClose = (temporaryPath) => {
			preservedTemporaryPath = `${temporaryPath}.preserved`;
			renameSync(temporaryPath, preservedTemporaryPath);
			writeFileSync(temporaryPath, "replacement bytes", "utf8");
		};

		expect(() => writeEvidenceIndexAtomic(root, pdfIndex(sourceId))).toThrow(/unsafe/i);
		expect(existsSync(evidencePath(root, sourceId))).toBe(false);
		expect(preservedTemporaryPath).toBeDefined();
		expect(existsSync(preservedTemporaryPath!)).toBe(true);
		expect(readFileSync(fsTrace.temporaryPath!, "utf8")).toBe("replacement bytes");
	});

	it("redacts a native write error that contains the temporary absolute path", () => {
		const root = makeTempDir();
		fsTrace.failFsyncWithPath = true;

		let thrown: unknown;
		try {
			writeEvidenceIndexAtomic(root, pdfIndex("l2src_redacted_writer_error"));
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toBe("Evidence index write failed.");
		expect((thrown as Error).message).not.toContain(root);
		expect((thrown as Error).message).not.toContain(fsTrace.temporaryPath!);
	});

	it("rejects an evidence directory reparse point without publishing outside L2", () => {
		const root = makeTempDir();
		const outside = makeTempDir();
		ensureL2Directories(root);
		writeFileSync(join(outside, "sentinel.txt"), "outside", "utf8");
		const byId = join(root, "extracted", "evidence", "by-id");
		rmSync(byId, { recursive: true });
		directoryLink(outside, byId);

		expect(() => writeEvidenceIndexAtomic(root, pdfIndex("l2src_linked_writer"))).toThrow(/unsafe/i);
		expect(readdirSync(outside)).toEqual(["sentinel.txt"]);
		expect(readFileSync(join(outside, "sentinel.txt"), "utf8")).toBe("outside");
	});

	it("does not publish an index outside L2 when by-id is replaced before temporary-file open", () => {
		const root = makeTempDir();
		const outside = makeTempDir();
		ensureL2Directories(root);
		writeFileSync(join(outside, "sentinel.txt"), "outside", "utf8");
		const byId = join(root, "extracted", "evidence", "by-id");
		const preservedById = join(root, "extracted", "evidence", "preserved-by-id");
		fsTrace.beforePathUse = () => {
			renameSync(byId, preservedById);
			directoryLink(outside, byId);
		};

		expect(() => writeEvidenceIndexAtomic(root, pdfIndex("l2src_writer_parent_replaced"))).toThrow(/unsafe/i);

		expect(readdirSync(outside)).toEqual(["sentinel.txt"]);
		expect(readFileSync(join(outside, "sentinel.txt"), "utf8")).toBe("outside");
	});
});

describe("readEvidenceIndex", () => {
	it("rejects an evidence directory reparse point without reading an external index", () => {
		const root = makeTempDir();
		const outside = makeTempDir();
		const index = pdfIndex("l2src_linked_reader");
		ensureL2Directories(root);
		writeFileSync(join(outside, `${hash(index.source_id)}.json`), `${JSON.stringify(index)}\n`, "utf8");
		const byId = join(root, "extracted", "evidence", "by-id");
		rmSync(byId, { recursive: true });
		directoryLink(outside, byId);

		expect(readEvidenceIndex(root, index.source_id, index.raw_content_hash)).toEqual({ status: "corrupt-index" });
		expect(readdirSync(outside)).toEqual([`${hash(index.source_id)}.json`]);
	});

	it("does not read an external index when by-id is replaced after validation", () => {
		const root = makeTempDir();
		const outside = makeTempDir();
		const sourceId = "l2src_index_parent_replaced_before_open";
		const local = pdfIndex(sourceId);
		const external = buildEvidenceIndex({
			sourceId,
			sourceType: "pdf",
			rawContentHash: local.raw_content_hash,
			parsed: parsed("External private evidence", [{ pageNumber: 1, text: "External private evidence" }]),
		});
		writeEvidenceIndexAtomic(root, local);
		writeFileSync(join(outside, `${hash(sourceId)}.json`), `${JSON.stringify(external)}\n`, "utf8");
		const byId = join(root, "extracted", "evidence", "by-id");
		const preservedById = join(root, "extracted", "evidence", "preserved-by-id");
		fsTrace.pathUseTarget = realpathSync.native(evidencePath(root, sourceId));
		fsTrace.beforePathUse = () => {
			renameSync(byId, preservedById);
			directoryLink(outside, byId);
		};

		expect(readEvidenceIndex(root, sourceId, local.raw_content_hash)).toEqual({ status: "corrupt-index" });
		expect(fsTrace.targetPayloadReads).toBe(0);
	});

	it("reports a corrupt index when a validated target is replaced by a missing junction", () => {
		const root = makeTempDir();
		const outside = makeTempDir();
		const sourceId = "l2src_index_missing_target";
		const index = pdfIndex(sourceId);
		writeEvidenceIndexAtomic(root, index);
		const byId = join(root, "extracted", "evidence", "by-id");
		const preservedById = join(root, "extracted", "evidence", "preserved-by-id");
		fsTrace.pathUseTarget = realpathSync.native(evidencePath(root, sourceId));
		fsTrace.beforePathUse = () => {
			renameSync(byId, preservedById);
			directoryLink(outside, byId);
		};

		expect(readEvidenceIndex(root, sourceId, index.raw_content_hash)).toEqual({ status: "corrupt-index" });
	});

	it("returns missing-index without creating derived data", () => {
		const root = makeTempDir();
		const sourceId = "l2src_missing";

		expect(readEvidenceIndex(root, sourceId, "a".repeat(64))).toEqual({ status: "missing-index" });
		expect(existsSync(evidencePath(root, sourceId))).toBe(false);
	});

	it("returns the validated index when its source revision matches", () => {
		const root = makeTempDir();
		const index = pdfIndex();
		writeEvidenceIndexAtomic(root, index);

		expect(readEvidenceIndex(root, index.source_id, index.raw_content_hash)).toEqual({ status: "ready", index });
	});

	it("returns stale-source for a valid index with a different raw hash", () => {
		const root = makeTempDir();
		const index = pdfIndex();
		writeEvidenceIndexAtomic(root, index);

		expect(readEvidenceIndex(root, index.source_id, "b".repeat(64))).toEqual({ status: "stale-source" });
	});

	it.each([
		"short",
		"A".repeat(64),
		"g".repeat(64),
	])("returns corrupt-index for a non-canonical persisted raw hash: %s", (rawContentHash) => {
		const root = makeTempDir();
		const index = pdfIndex();
		writePersistedIndex(root, index.source_id, { ...index, raw_content_hash: rawContentHash });

		expect(readEvidenceIndex(root, index.source_id, rawContentHash)).toEqual({ status: "corrupt-index" });
	});

	it("returns index-version-mismatch for a structurally readable future index", () => {
		const root = makeTempDir();
		const index = pdfIndex();
		writePersistedIndex(root, index.source_id, { ...index, version: 2 });

		expect(readEvidenceIndex(root, index.source_id, index.raw_content_hash)).toEqual({
			status: "index-version-mismatch",
		});
	});

	it("returns stale-source before a version mismatch when a future index proves a different raw revision", () => {
		const root = makeTempDir();
		const index = pdfIndex();
		writePersistedIndex(root, index.source_id, { ...index, version: 2 });

		expect(readEvidenceIndex(root, index.source_id, "b".repeat(64))).toEqual({ status: "stale-source" });
	});

	it.each([null, "2", {}, []])("returns corrupt-index for a malformed version value: %j", (version) => {
		const root = makeTempDir();
		const index = pdfIndex();
		writePersistedIndex(root, index.source_id, { ...index, version });

		expect(readEvidenceIndex(root, index.source_id, index.raw_content_hash)).toEqual({ status: "corrupt-index" });
	});

	it.each([
		["malformed JSON", (_index: SourceEvidenceIndex): unknown => "{not-json"],
		["wrong source ID", (index: SourceEvidenceIndex): unknown => ({ ...index, source_id: "l2src_other" })],
		["block hash mismatch", (index: SourceEvidenceIndex): unknown => ({
			...index,
			blocks: [{ ...index.blocks[0], id: `${index.blocks[0].id}-tampered` }],
		})],
		["extracted content hash mismatch", (index: SourceEvidenceIndex): unknown => ({
			...index,
			extracted_content_hash: "0".repeat(64),
		})],
	] as const)("returns corrupt-index for %s", (_label, corrupt) => {
		const root = makeTempDir();
		const index = pdfIndex();
		writePersistedIndex(root, index.source_id, corrupt(index));

		expect(readEvidenceIndex(root, index.source_id, index.raw_content_hash)).toEqual({ status: "corrupt-index" });
	});
});

describe("rebuildEvidenceIndex", () => {
	it("rejects a reparse point used as the raw root", async () => {
		const root = makeTempDir();
		const outsideRaw = makeTempDir();
		const sourceId = "l2src_linked_raw_root";
		const rawPath = "raw/uploads/source.md";
		mkdirSync(join(outsideRaw, "uploads"), { recursive: true });
		const outsideSource = join(outsideRaw, "uploads", "source.md");
		writeFileSync(outsideSource, "# Outside raw\n", "utf8");
		directoryLink(outsideRaw, join(root, "raw"));
		upsertMarkdownSource(root, sourceId, rawPath, outsideSource, hash("# Outside raw\n"));
		const outsideBefore = readFileSync(outsideSource);

		await expect(rebuildEvidenceIndex(root, sourceId)).rejects.toThrow(/immutable raw/i);

		expect(readFileSync(outsideSource)).toEqual(outsideBefore);
		expect(existsSync(evidencePath(root, sourceId))).toBe(false);
	});

	it("does not read raw payload after its validated parent is replaced by a junction", async () => {
		const root = makeTempDir();
		const outside = makeTempDir();
		const sourceId = "l2src_raw_parent_replaced_before_open";
		const rawPath = "raw/uploads/source.md";
		const original = "# Original raw\n";
		ensureL2Directories(root);
		const rawAbsolutePath = join(root, rawPath);
		writeFileSync(rawAbsolutePath, original, "utf8");
		upsertMarkdownSource(root, sourceId, rawPath, rawAbsolutePath, hash(original));
		writeFileSync(join(outside, "source.md"), "# External private raw\n", "utf8");
		const uploads = join(root, "raw", "uploads");
		const preservedUploads = join(root, "raw", "preserved-uploads");
		fsTrace.pathUseTarget = realpathSync.native(rawAbsolutePath);
		fsTrace.beforePathUse = () => {
			renameSync(uploads, preservedUploads);
			directoryLink(outside, uploads);
		};

		await expect(rebuildEvidenceIndex(root, sourceId)).rejects.toThrow(/immutable raw|revision (?:has )?changed/i);

		expect(fsTrace.targetPayloadReads).toBe(0);
		expect(existsSync(evidencePath(root, sourceId))).toBe(false);
	});

	it("rejects an evidence directory reparse point without writing outside L2", async () => {
		const root = makeTempDir();
		const outsideEvidence = makeTempDir();
		const sourceId = "l2src_linked_evidence_root";
		const rawPath = "raw/uploads/source.md";
		const raw = "# Local raw\n";
		ensureL2Directories(root);
		const rawAbsolutePath = join(root, rawPath);
		writeFileSync(rawAbsolutePath, raw, "utf8");
		upsertMarkdownSource(root, sourceId, rawPath, rawAbsolutePath, hash(raw));
		writeFileSync(join(outsideEvidence, "sentinel.txt"), "outside", "utf8");
		const byId = join(root, "extracted", "evidence", "by-id");
		rmSync(byId, { recursive: true });
		directoryLink(outsideEvidence, byId);

		await expect(rebuildEvidenceIndex(root, sourceId)).rejects.toThrow(/unsafe/i);

		expect(readdirSync(outsideEvidence).sort()).toEqual(["sentinel.txt"]);
		expect(readFileSync(join(outsideEvidence, "sentinel.txt"), "utf8")).toBe("outside");
	});

	it("rejects a case-variant staging raw path", async () => {
		const root = makeTempDir();
		const sourceId = "l2src_case_staging";
		const rawPath = "raw/.STAGING/source.md";
		ensureL2Directories(root);
		mkdirSync(join(root, "raw", ".STAGING"), { recursive: true });
		const rawAbsolutePath = join(root, rawPath);
		writeFileSync(rawAbsolutePath, "# Staging raw\n", "utf8");
		upsertMarkdownSource(root, sourceId, rawPath, rawAbsolutePath, hash("# Staging raw\n"));

		await expect(rebuildEvidenceIndex(root, sourceId)).rejects.toThrow(/immutable raw/i);
		expect(existsSync(evidencePath(root, sourceId))).toBe(false);
	});

	it("rebuilds only from the immutable raw named by the manifest when its revision matches", async () => {
		const root = makeTempDir();
		const sourceId = "l2src_rebuild_markdown";
		const rawPath = "raw/uploads/rebuild.md";
		const raw = "# Immutable source\n\nEvidence from the manifest raw.\n";
		ensureL2Directories(root);
		writeFileSync(join(root, rawPath), raw, "utf8");
		writeFileSync(join(root, "unreferenced-workspace.md"), "# Wrong source\n", "utf8");
		const rawContentHash = hash(raw);
		const rawStat = statSync(join(root, rawPath));
		upsertManifest(root, {
			id: sourceId,
			title: "Rebuild Markdown",
			sourceType: "markdown",
			rawPath,
			extractedPath: "extracted/rebuild.md",
			wikiPages: [],
			tags: [],
			contentHash: "legacy-content-hash",
			rawContentHash,
			rawSize: rawStat.size,
			rawMtimeMs: rawStat.mtimeMs,
			rawKind: "uploaded-original",
			status: "indexed",
			source: { origin: "user_upload" },
			createdAt: "2026-08-15T00:00:00.000Z",
			updatedAt: "2026-08-15T00:00:00.000Z",
		});
		const manifestBefore = readFileSync(join(root, "manifest.jsonl"), "utf8");

		const rebuilt = await rebuildEvidenceIndex(root, sourceId);

		expect(rebuilt.raw_content_hash).toBe(rawContentHash);
		expect(rebuilt.blocks.some((block) => block.text.includes("Evidence from the manifest raw."))).toBe(true);
		expect(rebuilt.blocks.every((block) => !block.text.includes("Wrong source"))).toBe(true);
		expect(readEvidenceIndex(root, sourceId, rawContentHash)).toEqual({ status: "ready", index: rebuilt });
		expect(readFileSync(join(root, "manifest.jsonl"), "utf8")).toBe(manifestBefore);
	});

	it("parses the initially verified raw snapshot when the manifest path is replaced and restored", async () => {
		const root = makeTempDir();
		const sourceId = "l2src_replaced_during_parse";
		const rawPath = "raw/uploads/replaced-during-parse.md";
		const original = "# Original snapshot\n\nEvidence from revision A.\n";
		const replacement = "# Replacement snapshot\n\nEvidence from revision B.\n";
		ensureL2Directories(root);
		const rawAbsolutePath = join(root, rawPath);
		writeFileSync(rawAbsolutePath, original, "utf8");
		upsertMarkdownSource(root, sourceId, rawPath, rawAbsolutePath, hash(original));
		parseTrace.beforeParse = () => writeFileSync(rawAbsolutePath, replacement, "utf8");
		parseTrace.afterParse = () => writeFileSync(rawAbsolutePath, original, "utf8");

		const rebuilt = await rebuildEvidenceIndex(root, sourceId);

		expect(rebuilt.raw_content_hash).toBe(hash(original));
		expect(rebuilt.blocks.some((block) => block.text.includes("Evidence from revision A."))).toBe(true);
		expect(rebuilt.blocks.every((block) => !block.text.includes("Evidence from revision B."))).toBe(true);
		expect(readFileSync(rawAbsolutePath, "utf8")).toBe(original);
	});

	it("rejects a changed raw revision without creating or replacing an index", async () => {
		const root = makeTempDir();
		const sourceId = "l2src_changed_raw";
		const rawPath = "raw/uploads/changed.md";
		const original = "# Original revision\n";
		ensureL2Directories(root);
		writeFileSync(join(root, rawPath), original, "utf8");
		upsertManifest(root, {
			id: sourceId,
			title: "Changed raw",
			sourceType: "markdown",
			rawPath,
			wikiPages: [],
			tags: [],
			contentHash: "legacy-content-hash",
			rawContentHash: hash(original),
			rawSize: Buffer.byteLength(original),
			rawMtimeMs: statSync(join(root, rawPath)).mtimeMs,
			rawKind: "uploaded-original",
			status: "indexed",
			source: { origin: "user_upload" },
			createdAt: "2026-08-15T00:00:00.000Z",
			updatedAt: "2026-08-15T00:00:00.000Z",
		});
		const previousIndex = buildEvidenceIndex({
			sourceId,
			sourceType: "markdown",
			rawContentHash: hash(original),
			parsed: parsed(original),
		});
		writeEvidenceIndexAtomic(root, previousIndex);
		const previousIndexBytes = readFileSync(evidencePath(root, sourceId));
		writeFileSync(join(root, rawPath), "# Changed revision\n", "utf8");
		const manifestBefore = readFileSync(join(root, "manifest.jsonl"), "utf8");

		await expect(rebuildEvidenceIndex(root, sourceId)).rejects.toThrow(/raw revision.*changed/i);

		expect(readFileSync(evidencePath(root, sourceId))).toEqual(previousIndexBytes);
		expect(readEvidenceIndex(root, sourceId, hash(original))).toEqual({ status: "ready", index: previousIndex });
		expect(readFileSync(join(root, "manifest.jsonl"), "utf8")).toBe(manifestBefore);
	});

	it("preserves a legacy source index when its raw revision has changed", async () => {
		const root = makeTempDir();
		const sourceId = "l2src_legacy_changed_raw";
		const rawPath = "raw/uploads/legacy-changed.md";
		const original = "# Legacy original\n";
		ensureL2Directories(root);
		const rawAbsolutePath = join(root, rawPath);
		writeFileSync(rawAbsolutePath, original, "utf8");
		upsertMarkdownSource(root, sourceId, rawPath, rawAbsolutePath);
		const previousIndex = buildEvidenceIndex({
			sourceId,
			sourceType: "markdown",
			rawContentHash: hash(original),
			parsed: parsed(original),
		});
		writeEvidenceIndexAtomic(root, previousIndex);
		const previousIndexBytes = readFileSync(evidencePath(root, sourceId));
		writeFileSync(rawAbsolutePath, "# Legacy changed\n", "utf8");

		await expect(rebuildEvidenceIndex(root, sourceId)).rejects.toThrow(/raw revision.*changed/i);

		expect(readFileSync(evidencePath(root, sourceId))).toEqual(previousIndexBytes);
		expect(readEvidenceIndex(root, sourceId, hash(original))).toEqual({ status: "ready", index: previousIndex });
	});

	it.each([
		["malformed", (_index: SourceEvidenceIndex): unknown => "{not-json"],
		["future-version", (index: SourceEvidenceIndex): unknown => ({ ...index, version: 2 })],
	] as const)("repairs a %s derived index for a legacy source whose raw revision is unchanged", async (_label, persisted) => {
		const root = makeTempDir();
		const sourceId = "l2src_legacy_repair";
		const rawPath = "raw/uploads/legacy-repair.md";
		const raw = "# Legacy source\n\nStable evidence.\n";
		ensureL2Directories(root);
		const rawAbsolutePath = join(root, rawPath);
		writeFileSync(rawAbsolutePath, raw, "utf8");
		upsertMarkdownSource(root, sourceId, rawPath, rawAbsolutePath);
		const previousIndex = buildEvidenceIndex({
			sourceId,
			sourceType: "markdown",
			rawContentHash: hash(raw),
			parsed: parsed(raw),
		});
		writePersistedIndex(root, sourceId, persisted(previousIndex));
		const manifestBefore = readFileSync(join(root, "manifest.jsonl"));
		const rawBefore = readFileSync(rawAbsolutePath);

		const rebuilt = await rebuildEvidenceIndex(root, sourceId);

		expect(readEvidenceIndex(root, sourceId, hash(raw))).toEqual({ status: "ready", index: rebuilt });
		expect(readFileSync(join(root, "manifest.jsonl"))).toEqual(manifestBefore);
		expect(readFileSync(rawAbsolutePath)).toEqual(rawBefore);
	});

	it("rebuilds archived-text Markdown without indexing acquisition frontmatter", async () => {
		const root = makeTempDir();
		const sourceId = "l2src_archived_text_rebuild";
		const userContent = "# User content\n\nOnly this text is evidence.\n";
		const archived = archiveRawContent(root, "Archived text", userContent, "markdown");
		upsertManifest(root, {
			id: sourceId,
			title: "Archived text",
			sourceType: "markdown",
			rawPath: archived.rawPath,
			wikiPages: [],
			tags: [],
			contentHash: "legacy-content-hash",
			rawContentHash: archived.rawContentHash,
			rawSize: archived.rawSize,
			rawMtimeMs: archived.rawMtimeMs,
			rawKind: "archived-text",
			status: "indexed",
			source: { origin: "user_upload" },
			createdAt: "2026-08-15T00:00:00.000Z",
			updatedAt: "2026-08-15T00:00:00.000Z",
		});

		const rebuilt = await rebuildEvidenceIndex(root, sourceId);

		expect(rebuilt.blocks.some((block) => block.text.includes("Only this text is evidence."))).toBe(true);
		expect(rebuilt.blocks.every((block) => !block.text.includes("source_type:"))).toBe(true);
		expect(rebuilt.blocks.every((block) => !block.text.includes("ingested:"))).toBe(true);
	});

	it("strips verified acquisition frontmatter when rebuilding legacy archived Markdown", async () => {
		const root = makeTempDir();
		const sourceId = "l2src_legacy_archived_text_rebuild";
		const userContent = "# Legacy user content\n\nOnly the archived payload is evidence.\n";
		const archived = archiveRawContent(root, "Legacy archived text", userContent, "markdown");
		upsertManifest(root, {
			id: sourceId,
			title: "Legacy archived text",
			sourceType: "markdown",
			rawPath: archived.rawPath,
			wikiPages: [],
			tags: [],
			contentHash: "legacy-content-hash",
			rawContentHash: archived.rawContentHash,
			rawSize: archived.rawSize,
			rawMtimeMs: archived.rawMtimeMs,
			status: "indexed",
			source: { origin: "user_upload" },
			createdAt: "2026-08-15T00:00:00.000Z",
			updatedAt: "2026-08-15T00:00:00.000Z",
		});

		const rebuilt = await rebuildEvidenceIndex(root, sourceId);

		expect(rebuilt.blocks.some((block) => block.text.includes("Only the archived payload is evidence."))).toBe(true);
		expect(rebuilt.blocks.every((block) => !block.text.includes("source_type:"))).toBe(true);
		expect(rebuilt.blocks.every((block) => !block.text.includes("ingested:"))).toBe(true);
	});
});
