import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeSync,
	type BigIntStats,
} from "node:fs";
import { extname, join, resolve } from "node:path";

import { parseDocumentBytes, type ParsedDocumentResult } from "./document-parser.js";
import { readManifest } from "./manifest-store.js";
import { resolveRawSourcePath } from "./source-path.js";
import { readSourceBytes } from "./source-revision.js";
import { validateSourceBytes } from "./source-format.js";

export interface EvidenceBlock {
	id: string;
	kind: "pdf" | "markdown" | "docx";
	text: string;
	page?: number;
	heading?: string;
	paragraph?: number;
}

export interface SourceEvidenceIndex {
	version: 1;
	source_id: string;
	raw_content_hash: string;
	extracted_content_hash: string;
	blocks: EvidenceBlock[];
}

export interface EvidenceIndexInput {
	sourceId: string;
	sourceType: "pdf" | "word" | "markdown";
	rawContentHash: string;
	parsed: ParsedDocumentResult;
	/** Exact archived-content payload. Omit for Markdown returned by the file parser. */
	markdownContent?: string;
}

export type EvidenceIndexReadResult =
	| { status: "ready"; index: SourceEvidenceIndex }
	| { status: "missing-index" | "corrupt-index" | "stale-source" | "index-version-mismatch" };

const INDEX_VERSION = 1 as const;
const HASH_PREFIX_LENGTH = 12;
const EVIDENCE_INDEX_DIR = ["extracted", "evidence", "by-id"] as const;
const FULL_LOWERCASE_SHA256 = /^[0-9a-f]{64}$/;

function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

function normalizeStoredText(text: string): string {
	return text.replace(/\r\n?/g, "\n").normalize("NFC");
}

/** Normalize the comparison-only view used to locate a quote within a stored block. */
export function normalizeEvidenceTextForQuoteMatching(text: string): string {
	return normalizeStoredText(text).replace(/\s+/gu, " ").trim();
}

function canonicalBlockText(text: string): string | null {
	const lines = normalizeStoredText(text).split("\n");
	let first = 0;
	let last = lines.length;
	while (first < last && lines[first].trim().length === 0) first += 1;
	while (last > first && lines[last - 1].trim().length === 0) last -= 1;
	if (first === last) return null;
	return lines.slice(first, last).join("\n");
}

function contentHash(blocks: readonly EvidenceBlock[]): string {
	return sha256(blocks.map((block) => block.text).join("\n\n"));
}

function hashPrefix(text: string): string {
	return sha256(text).slice(0, HASH_PREFIX_LENGTH);
}

function buildPdfBlocks(parsed: ParsedDocumentResult): EvidenceBlock[] {
	const blocks: EvidenceBlock[] = [];
	for (const page of parsed.pages) {
		let withinPageOrdinal = 0;
		const normalizedPage = normalizeStoredText(page.text);
		const pageParts = normalizedPage.split(/\n[^\S\n]*\n(?:[^\S\n]*\n)*/gu);
		for (const part of pageParts) {
			const text = canonicalBlockText(part);
			if (text === null) continue;
			withinPageOrdinal += 1;
			blocks.push({
				id: pdfBlockId(page.pageNumber, withinPageOrdinal, text),
				kind: "pdf",
				text,
				page: page.pageNumber,
			});
		}
	}
	return blocks;
}

function pdfBlockId(page: number, withinPageOrdinal: number, text: string): string {
	return `pdf:p${String(page).padStart(3, "0")}:b${String(withinPageOrdinal).padStart(3, "0")}:${hashPrefix(text)}`;
}

interface MarkdownHeading {
	title: string;
	lineCount: 1 | 2;
}

interface FenceMarker {
	character: "`" | "~";
	length: number;
}

function atxHeading(line: string): MarkdownHeading | null {
	const match = line.match(/^ {0,3}#{1,6}(?:[ \t]+(.*?)[ \t]*|[ \t]*)$/u);
	if (!match) return null;
	const title = (match[1] ?? "").replace(/[ \t]+#+[ \t]*$/u, "").trim();
	return { title, lineCount: 1 };
}

function markdownHeading(lines: readonly string[], ordinal: number): MarkdownHeading | null {
	const atx = atxHeading(lines[ordinal]);
	if (atx) return atx;
	if (ordinal + 1 >= lines.length || lines[ordinal].trim().length === 0) return null;
	if (!/^ {0,3}(?:=+|-+)[ \t]*$/u.test(lines[ordinal + 1])) return null;
	return { title: lines[ordinal].trim(), lineCount: 2 };
}

function openingFence(line: string): FenceMarker | null {
	const match = line.match(/^ {0,3}(`{3,}|~{3,})/u);
	if (!match) return null;
	return { character: match[1][0] as "`" | "~", length: match[1].length };
}

function closesFence(line: string, marker: FenceMarker): boolean {
	const match = line.match(/^ {0,3}(`+|~+)[ \t]*$/u);
	return Boolean(match && match[1][0] === marker.character && match[1].length >= marker.length);
}

function isListItem(line: string): boolean {
	return /^ {0,3}(?:[-+*][ \t]+|\d+[.)][ \t]+)/u.test(line);
}

function isIndentedContinuation(line: string): boolean {
	return /^(?: {2,}|\t)\S/u.test(line);
}

function isTableDelimiter(line: string): boolean {
	const trimmed = line.trim();
	if (!trimmed.includes("|")) return false;
	const withoutEdges = trimmed.replace(/^\|/u, "").replace(/\|$/u, "");
	const cells = withoutEdges.split("|").map((cell) => cell.trim());
	return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/u.test(cell));
}

function isTableStart(lines: readonly string[], ordinal: number): boolean {
	return ordinal + 1 < lines.length
		&& lines[ordinal].trim().length > 0
		&& lines[ordinal].includes("|")
		&& isTableDelimiter(lines[ordinal + 1]);
}

function consumeFence(lines: readonly string[], start: number, marker: FenceMarker): number {
	let end = start + 1;
	while (end < lines.length) {
		const isClosingLine = closesFence(lines[end], marker);
		end += 1;
		if (isClosingLine) break;
	}
	return end;
}

function consumeList(lines: readonly string[], start: number): number {
	let end = start + 1;
	while (end < lines.length) {
		if (lines[end].trim().length === 0) {
			let next = end + 1;
			while (next < lines.length && lines[next].trim().length === 0) next += 1;
			if (next < lines.length && (isListItem(lines[next]) || isIndentedContinuation(lines[next]))) {
				end = next;
				continue;
			}
			break;
		}
		if (atxHeading(lines[end]) || openingFence(lines[end])) break;
		end += 1;
	}
	return end;
}

function consumeTable(lines: readonly string[], start: number): number {
	let end = start + 2;
	while (end < lines.length && lines[end].trim().length > 0 && lines[end].includes("|")) end += 1;
	return end;
}

function consumeParagraph(lines: readonly string[], start: number): number {
	let end = start + 1;
	while (end < lines.length) {
		if (lines[end].trim().length === 0) break;
		if (markdownHeading(lines, end) || openingFence(lines[end]) || isListItem(lines[end]) || isTableStart(lines, end)) {
			break;
		}
		end += 1;
	}
	return end;
}

function stripVerifiedRawStoreFrontmatter(content: string): string {
	const match = content.match(
		/^---\n(?:source_url: [^\n]*\n)?source_type: markdown\ningested: \d{4}-\d{2}-\d{2}\nsha256: ([0-9a-f]{64})\n---\n([\s\S]*)$/u,
	);
	if (!match) return content;
	if (sha256(match[2]) === match[1]) return match[2];
	if (match[2].startsWith("\n") && sha256(match[2].slice(1)) === match[1]) return match[2].slice(1);
	return content;
}

function buildMarkdownBlocks(markdown: string, stripAcquisitionFrontmatter: boolean): EvidenceBlock[] {
	const content = stripAcquisitionFrontmatter ? stripVerifiedRawStoreFrontmatter(markdown) : markdown;
	const lines = normalizeStoredText(content).split("\n");
	const blocks: EvidenceBlock[] = [];
	let currentHeading: string | undefined;
	let sectionOrdinal = 0;
	let lineOrdinal = 0;

	const addBlock = (start: number, end: number, heading?: MarkdownHeading): void => {
		if (heading) {
			currentHeading = heading.title.length > 0 ? heading.title : undefined;
			sectionOrdinal = 0;
		}
		const text = canonicalBlockText(lines.slice(start, end).join("\n"));
		if (text === null) return;
		sectionOrdinal += 1;
		const documentOrdinal = blocks.length + 1;
		blocks.push({
			id: `md:b${String(documentOrdinal).padStart(4, "0")}:${hashPrefix(text)}`,
			kind: "markdown",
			text,
			...(currentHeading === undefined ? {} : { heading: currentHeading }),
			paragraph: sectionOrdinal,
		});
	};

	while (lineOrdinal < lines.length) {
		if (lines[lineOrdinal].trim().length === 0) {
			lineOrdinal += 1;
			continue;
		}

		const heading = markdownHeading(lines, lineOrdinal);
		if (heading) {
			const end = lineOrdinal + heading.lineCount;
			addBlock(lineOrdinal, end, heading);
			lineOrdinal = end;
			continue;
		}

		const fence = openingFence(lines[lineOrdinal]);
		if (fence) {
			const end = consumeFence(lines, lineOrdinal, fence);
			addBlock(lineOrdinal, end);
			lineOrdinal = end;
			continue;
		}

		if (isListItem(lines[lineOrdinal])) {
			const end = consumeList(lines, lineOrdinal);
			addBlock(lineOrdinal, end);
			lineOrdinal = end;
			continue;
		}

		if (isTableStart(lines, lineOrdinal)) {
			const end = consumeTable(lines, lineOrdinal);
			addBlock(lineOrdinal, end);
			lineOrdinal = end;
			continue;
		}

		const end = consumeParagraph(lines, lineOrdinal);
		addBlock(lineOrdinal, end);
		lineOrdinal = end;
	}

	return blocks;
}

function buildDocxBlocks(parsed: ParsedDocumentResult): EvidenceBlock[] {
	const blocks: EvidenceBlock[] = [];
	for (const line of normalizeStoredText(parsed.text).split("\n")) {
		const text = canonicalBlockText(line);
		if (text === null) continue;
		const paragraph = blocks.length + 1;
		blocks.push({
			id: `docx:p${String(paragraph).padStart(4, "0")}:${hashPrefix(text)}`,
			kind: "docx",
			text,
			paragraph,
		});
	}
	return blocks;
}

export function buildEvidenceIndex(input: EvidenceIndexInput): SourceEvidenceIndex {
	if (!FULL_LOWERCASE_SHA256.test(input.rawContentHash)) {
		throw new TypeError("rawContentHash must be a full lowercase SHA-256 digest.");
	}
	const blocks = input.sourceType === "pdf"
		? buildPdfBlocks(input.parsed)
		: input.sourceType === "word"
			? buildDocxBlocks(input.parsed)
			: input.markdownContent === undefined
				? buildMarkdownBlocks(input.parsed.text, false)
				: buildMarkdownBlocks(input.markdownContent, true);

	return {
		version: INDEX_VERSION,
		source_id: input.sourceId,
		raw_content_hash: input.rawContentHash,
		extracted_content_hash: contentHash(blocks),
		blocks,
	};
}

function equalFilesystemPath(left: string, right: string): boolean {
	return process.platform === "win32"
		? left.toLowerCase() === right.toLowerCase()
		: left === right;
}

type EvidenceDirectoryResolution =
	| { status: "ready"; path: string }
	| { status: "missing" }
	| { status: "unsafe" };

interface FileSnapshot {
	dev: bigint;
	ino: bigint;
	size: bigint;
	mtimeNs: bigint;
	ctimeNs: bigint;
}

function fileSnapshot(stats: BigIntStats): FileSnapshot {
	return {
		dev: stats.dev,
		ino: stats.ino,
		size: stats.size,
		mtimeNs: stats.mtimeNs,
		ctimeNs: stats.ctimeNs,
	};
}

function sameFileSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
	return left.dev === right.dev
		&& left.ino === right.ino
		&& left.size === right.size
		&& left.mtimeNs === right.mtimeNs
		&& left.ctimeNs === right.ctimeNs;
}

function sameFileObject(left: BigIntStats, right: BigIntStats): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

export type EvidenceIndexFileListing =
	| { status: "ready"; fileNames: string[] }
	| { status: "missing" }
	| { status: "unsafe" };

function resolvePlainEvidenceIndexDirectory(
	l2DataDir: string,
	createMissing: boolean,
): EvidenceDirectoryResolution {
	let parent = resolve(l2DataDir);
	let rootStats;
	try {
		rootStats = lstatSync(parent);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT"
			? { status: "missing" }
			: { status: "unsafe" };
	}
	if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
		return { status: "unsafe" };
	}
	let canonicalRoot: string;
	try {
		canonicalRoot = realpathSync.native(parent);
	} catch {
		return { status: "unsafe" };
	}
	if (!equalFilesystemPath(parent, canonicalRoot)) return { status: "unsafe" };
	parent = canonicalRoot;

	for (const segment of EVIDENCE_INDEX_DIR) {
		const candidate = join(parent, segment);
		let stats;
		try {
			stats = lstatSync(candidate);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { status: "unsafe" };
			if (!createMissing) return { status: "missing" };
			try {
				mkdirSync(candidate);
				stats = lstatSync(candidate);
			} catch {
				return { status: "unsafe" };
			}
		}
		if (stats.isSymbolicLink() || !stats.isDirectory()) return { status: "unsafe" };
		let canonical: string;
		try {
			canonical = realpathSync.native(candidate);
		} catch {
			return { status: "unsafe" };
		}
		if (!equalFilesystemPath(candidate, canonical)) return { status: "unsafe" };
		parent = canonical;
	}

	return { status: "ready", path: parent };
}

class EvidenceIndexWriteError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EvidenceIndexWriteError";
	}
}

function ensurePlainEvidenceIndexDirectory(l2DataDir: string): string {
	const result = resolvePlainEvidenceIndexDirectory(l2DataDir, true);
	if (result.status !== "ready") throw new EvidenceIndexWriteError("L2 evidence directory is unsafe.");
	return result.path;
}

function resolveEvidenceIndexForRead(
	l2DataDir: string,
	sourceId: string,
): EvidenceDirectoryResolution {
	const directory = resolvePlainEvidenceIndexDirectory(l2DataDir, false);
	if (directory.status !== "ready") return directory;
	const candidate = join(directory.path, `${sha256(sourceId)}.json`);
	let stats;
	try {
		stats = lstatSync(candidate);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT"
			? { status: "missing" }
			: { status: "unsafe" };
	}
	if (stats.isSymbolicLink() || !stats.isFile()) return { status: "unsafe" };
	try {
		const canonical = realpathSync.native(candidate);
		return equalFilesystemPath(candidate, canonical)
			? { status: "ready", path: canonical }
			: { status: "unsafe" };
	} catch {
		return { status: "unsafe" };
	}
}

type EvidenceIndexByteRead =
	| { status: "ready"; raw: string }
	| { status: "missing" }
	| { status: "unsafe" };

function readEvidenceIndexFile(l2DataDir: string, sourceId: string): EvidenceIndexByteRead {
	const resolved = resolveEvidenceIndexForRead(l2DataDir, sourceId);
	if (resolved.status !== "ready") return resolved;

	let descriptor: number | undefined;
	try {
		descriptor = openSync(resolved.path, "r");
		const openedStats = fstatSync(descriptor, { bigint: true });
		const pathStats = lstatSync(resolved.path, { bigint: true });
		const rebound = resolveEvidenceIndexForRead(l2DataDir, sourceId);
		if (
			!openedStats.isFile()
			|| pathStats.isSymbolicLink()
			|| !pathStats.isFile()
			|| !sameFileSnapshot(fileSnapshot(openedStats), fileSnapshot(pathStats))
			|| rebound.status !== "ready"
			|| !equalFilesystemPath(resolved.path, rebound.path)
		) {
			return { status: "unsafe" };
		}

		const raw = readFileSync(descriptor, "utf8");
		const afterStats = fstatSync(descriptor, { bigint: true });
		const finalPathStats = lstatSync(resolved.path, { bigint: true });
		const finalResolution = resolveEvidenceIndexForRead(l2DataDir, sourceId);
		if (
			!afterStats.isFile()
			|| finalPathStats.isSymbolicLink()
			|| !finalPathStats.isFile()
			|| !sameFileSnapshot(fileSnapshot(openedStats), fileSnapshot(afterStats))
			|| !sameFileSnapshot(fileSnapshot(afterStats), fileSnapshot(finalPathStats))
			|| finalResolution.status !== "ready"
			|| !equalFilesystemPath(resolved.path, finalResolution.path)
		) {
			return { status: "unsafe" };
		}
		return { status: "ready", raw };
	} catch (error) {
		if (descriptor === undefined && (error as NodeJS.ErrnoException).code === "ENOENT") {
			const rebound = resolveEvidenceIndexForRead(l2DataDir, sourceId);
			return rebound.status === "missing" ? { status: "missing" } : { status: "unsafe" };
		}
		return { status: "unsafe" };
	} finally {
		closeQuietly(descriptor);
	}
}

/** List only plain evidence-index files without following reparse points. */
export function listEvidenceIndexFileNames(l2DataDir: string): EvidenceIndexFileListing {
	const directory = resolvePlainEvidenceIndexDirectory(l2DataDir, false);
	if (directory.status === "missing") return { status: "missing" };
	if (directory.status === "unsafe") return { status: "unsafe" };

	try {
		const fileNames: string[] = [];
		for (const entry of readdirSync(directory.path, { withFileTypes: true })) {
			if (!entry.name.endsWith(".json")) continue;
			if (entry.isSymbolicLink() || !entry.isFile()) return { status: "unsafe" };
			const candidate = join(directory.path, entry.name);
			const stats = lstatSync(candidate);
			if (stats.isSymbolicLink() || !stats.isFile()) return { status: "unsafe" };
			const canonical = realpathSync.native(candidate);
			if (!equalFilesystemPath(candidate, canonical)) return { status: "unsafe" };
			fileNames.push(entry.name);
		}
		const verifiedDirectory = resolvePlainEvidenceIndexDirectory(l2DataDir, false);
		if (
			verifiedDirectory.status !== "ready"
			|| !equalFilesystemPath(directory.path, verifiedDirectory.path)
		) {
			return { status: "unsafe" };
		}
		return { status: "ready", fileNames: fileNames.sort() };
	} catch {
		return { status: "unsafe" };
	}
}

function closeQuietly(descriptor: number | undefined): void {
	if (descriptor === undefined) return;
	try {
		closeSync(descriptor);
	} catch {
		// The original write error is more useful than a cleanup failure.
	}
}

function unlinkOwnedTemporary(path: string, expectedFile: BigIntStats | undefined): void {
	if (expectedFile === undefined) return;
	try {
		const current = lstatSync(path, { bigint: true });
		if (current.isSymbolicLink() || !current.isFile() || !sameFileObject(current, expectedFile)) return;
		unlinkSync(path);
	} catch {
		// A failed temporary-file cleanup must not mask the write error.
	}
}

function verifyEvidenceIndexWriteTarget(
	l2DataDir: string,
	expectedDirectory: string,
	temporaryPath: string,
	descriptor?: number,
	expectedFile?: BigIntStats,
): void {
	const directory = resolvePlainEvidenceIndexDirectory(l2DataDir, false);
	if (directory.status !== "ready" || !equalFilesystemPath(directory.path, expectedDirectory)) {
		throw new EvidenceIndexWriteError("L2 evidence directory is unsafe.");
	}
	try {
		const pathStats = lstatSync(temporaryPath, { bigint: true });
		if (pathStats.isSymbolicLink() || !pathStats.isFile()) throw new Error();
		if (!equalFilesystemPath(realpathSync.native(temporaryPath), temporaryPath)) throw new Error();
		if (expectedFile !== undefined && !sameFileObject(expectedFile, pathStats)) throw new Error();
		if (descriptor !== undefined) {
			const descriptorStats = fstatSync(descriptor, { bigint: true });
			if (!descriptorStats.isFile() || !sameFileObject(descriptorStats, pathStats)) {
				throw new Error();
			}
		}
	} catch {
		throw new EvidenceIndexWriteError("L2 evidence temporary file is unsafe.");
	}
}

function writeEvidenceIndexAtomicInternal(l2DataDir: string, index: SourceEvidenceIndex): void {
	const directory = ensurePlainEvidenceIndexDirectory(l2DataDir);
	const finalPath = join(directory, `${sha256(index.source_id)}.json`);
	const temporaryPath = `${finalPath}.${process.pid}.${randomUUID()}.tmp`;
	const bytes = Buffer.from(`${JSON.stringify(index, null, 2)}\n`, "utf8");
	let descriptor: number | undefined;
	let ownsTemporaryFile = false;
	let ownedTemporaryStats: BigIntStats | undefined;
	let published = false;

	try {
		descriptor = openSync(temporaryPath, "wx", 0o600);
		ownsTemporaryFile = true;
		ownedTemporaryStats = fstatSync(descriptor, { bigint: true });
		verifyEvidenceIndexWriteTarget(l2DataDir, directory, temporaryPath, descriptor, ownedTemporaryStats);
		let offset = 0;
		while (offset < bytes.length) {
			const written = writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
			if (written <= 0) throw new EvidenceIndexWriteError("Failed to write evidence index bytes.");
			offset += written;
		}
		fsyncSync(descriptor);
		verifyEvidenceIndexWriteTarget(l2DataDir, directory, temporaryPath, descriptor, ownedTemporaryStats);
		closeSync(descriptor);
		descriptor = undefined;
		verifyEvidenceIndexWriteTarget(l2DataDir, directory, temporaryPath, undefined, ownedTemporaryStats);
		// Cross-platform Node exposes only a path-based rename. A hostile host process
		// swapping the parent after this check is outside the local single-user boundary.
		renameSync(temporaryPath, finalPath);
		published = true;
	} finally {
		closeQuietly(descriptor);
		if (ownsTemporaryFile && !published) unlinkOwnedTemporary(temporaryPath, ownedTemporaryStats);
	}
}

export function writeEvidenceIndexAtomic(l2DataDir: string, index: SourceEvidenceIndex): void {
	try {
		writeEvidenceIndexAtomicInternal(l2DataDir, index);
	} catch (error) {
		if (error instanceof EvidenceIndexWriteError) throw error;
		throw new EvidenceIndexWriteError("Evidence index write failed.");
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isCanonicalBlockText(text: string): boolean {
	return canonicalBlockText(text) === text;
}

function validatePdfBlocks(blocks: readonly EvidenceBlock[]): boolean {
	let currentPage: number | undefined;
	let withinPageOrdinal = 0;
	const completedPages = new Set<number>();
	for (const block of blocks) {
		if (block.kind !== "pdf" || !isPositiveInteger(block.page)) return false;
		if (block.heading !== undefined || block.paragraph !== undefined) return false;
		if (block.page !== currentPage) {
			if (currentPage !== undefined) completedPages.add(currentPage);
			if (completedPages.has(block.page)) return false;
			currentPage = block.page;
			withinPageOrdinal = 0;
		}
		withinPageOrdinal += 1;
		if (block.id !== pdfBlockId(block.page, withinPageOrdinal, block.text)) return false;
	}
	return true;
}

function headingFromBlockText(text: string): MarkdownHeading | null {
	return markdownHeading(text.split("\n"), 0);
}

function validateMarkdownBlocks(blocks: readonly EvidenceBlock[]): boolean {
	let currentHeading: string | undefined;
	let sectionOrdinal = 0;
	for (const [ordinal, block] of blocks.entries()) {
		if (block.kind !== "markdown" || block.page !== undefined || !isPositiveInteger(block.paragraph)) return false;
		if (block.heading !== undefined && typeof block.heading !== "string") return false;
		const heading = headingFromBlockText(block.text);
		if (heading && heading.lineCount === block.text.split("\n").length) {
			currentHeading = heading.title.length > 0 ? heading.title : undefined;
			sectionOrdinal = 0;
		}
		sectionOrdinal += 1;
		if (block.heading !== currentHeading || block.paragraph !== sectionOrdinal) return false;
		const expectedId = `md:b${String(ordinal + 1).padStart(4, "0")}:${hashPrefix(block.text)}`;
		if (block.id !== expectedId) return false;
	}
	return true;
}

function validateDocxBlocks(blocks: readonly EvidenceBlock[]): boolean {
	for (const [ordinal, block] of blocks.entries()) {
		if (block.kind !== "docx" || block.page !== undefined || block.heading !== undefined) return false;
		if (block.paragraph !== ordinal + 1) return false;
		const expectedId = `docx:p${String(ordinal + 1).padStart(4, "0")}:${hashPrefix(block.text)}`;
		if (block.id !== expectedId) return false;
	}
	return true;
}

function decodeBlocks(value: unknown): EvidenceBlock[] | null {
	if (!Array.isArray(value)) return null;
	const blocks: EvidenceBlock[] = [];
	const ids = new Set<string>();
	for (const candidate of value) {
		if (!isRecord(candidate)) return null;
		if (typeof candidate.id !== "string" || candidate.id.length === 0 || ids.has(candidate.id)) return null;
		if (typeof candidate.text !== "string" || !isCanonicalBlockText(candidate.text)) return null;
		if (candidate.kind !== "pdf" && candidate.kind !== "markdown" && candidate.kind !== "docx") return null;
		if (candidate.page !== undefined && typeof candidate.page !== "number") return null;
		if (candidate.heading !== undefined && typeof candidate.heading !== "string") return null;
		if (candidate.paragraph !== undefined && typeof candidate.paragraph !== "number") return null;
		ids.add(candidate.id);
		blocks.push({
			id: candidate.id,
			kind: candidate.kind,
			text: candidate.text,
			...(candidate.page === undefined ? {} : { page: candidate.page }),
			...(candidate.heading === undefined ? {} : { heading: candidate.heading }),
			...(candidate.paragraph === undefined ? {} : { paragraph: candidate.paragraph }),
		});
	}
	if (blocks.length === 0) return blocks;
	const kind = blocks[0].kind;
	if (blocks.some((block) => block.kind !== kind)) return null;
	const valid = kind === "pdf"
		? validatePdfBlocks(blocks)
		: kind === "markdown"
			? validateMarkdownBlocks(blocks)
			: validateDocxBlocks(blocks);
	return valid ? blocks : null;
}

/** Decode bytes captured from a verified evidence-index handle. */
export function decodeEvidenceIndexBytes(
	rawInput: string | Uint8Array,
	sourceId: string,
	expectedRawContentHash?: string,
): EvidenceIndexReadResult {
	let raw: string;
	if (typeof rawInput === "string") {
		raw = rawInput;
	} else {
		try {
			raw = new TextDecoder("utf-8", { fatal: true }).decode(rawInput);
		} catch {
			return { status: "corrupt-index" };
		}
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return { status: "corrupt-index" };
	}
	if (!isRecord(value)) return { status: "corrupt-index" };
	if (!isPositiveInteger(value.version)) return { status: "corrupt-index" };
	if (typeof value.source_id !== "string" || value.source_id !== sourceId) return { status: "corrupt-index" };
	if (typeof value.raw_content_hash !== "string" || !FULL_LOWERCASE_SHA256.test(value.raw_content_hash)) {
		return { status: "corrupt-index" };
	}
	if (expectedRawContentHash !== undefined && value.raw_content_hash !== expectedRawContentHash) {
		return { status: "stale-source" };
	}
	if (value.version !== INDEX_VERSION) return { status: "index-version-mismatch" };
	if (typeof value.extracted_content_hash !== "string") return { status: "corrupt-index" };
	const blocks = decodeBlocks(value.blocks);
	if (blocks === null || value.extracted_content_hash !== contentHash(blocks)) return { status: "corrupt-index" };

	return {
		status: "ready",
		index: {
			version: INDEX_VERSION,
			source_id: value.source_id,
			raw_content_hash: value.raw_content_hash,
			extracted_content_hash: value.extracted_content_hash,
			blocks,
		},
	};
}

function readEvidenceIndexWithOptionalRevision(
	l2DataDir: string,
	sourceId: string,
	expectedRawContentHash?: string,
): EvidenceIndexReadResult {
	const read = readEvidenceIndexFile(l2DataDir, sourceId);
	if (read.status === "missing") return { status: "missing-index" };
	if (read.status === "unsafe") return { status: "corrupt-index" };
	return decodeEvidenceIndexBytes(read.raw, sourceId, expectedRawContentHash);
}

export function readEvidenceIndex(
	l2DataDir: string,
	sourceId: string,
	expectedRawContentHash: string,
): EvidenceIndexReadResult {
	return readEvidenceIndexWithOptionalRevision(l2DataDir, sourceId, expectedRawContentHash);
}

/** Inspect a safely contained index when no trusted raw revision is available. */
export function inspectEvidenceIndex(l2DataDir: string, sourceId: string): EvidenceIndexReadResult {
	return readEvidenceIndexWithOptionalRevision(l2DataDir, sourceId);
}

export async function rebuildEvidenceIndex(l2DataDir: string, sourceId: string): Promise<SourceEvidenceIndex> {
	const entry = readManifest(l2DataDir).find((candidate) => candidate.id === sourceId);
	if (!entry) throw new Error("Evidence index source is not present in the manifest.");
	if (entry.sourceType !== "pdf" && entry.sourceType !== "word" && entry.sourceType !== "markdown") {
		throw new Error("This source type does not support a precise evidence index.");
	}
	if (entry.rawContentHash !== undefined && !FULL_LOWERCASE_SHA256.test(entry.rawContentHash)) {
		throw new Error("Manifest raw revision is not a full lowercase SHA-256 digest.");
	}

	const rawPaths = resolveRawSourcePath(l2DataDir, entry);
	if (rawPaths.status !== "ready") {
		throw new Error("Manifest raw source is missing or is not an immutable raw file.");
	}
	const rawSnapshot = readSourceBytes(rawPaths);
	if (rawSnapshot.status !== "ready") {
		throw new Error("Manifest raw source is missing or is not an immutable raw file.");
	}
	const rawAbsolutePath = rawPaths.rawAbsolutePath;
	const { rawBytes, rawContentHash } = rawSnapshot;
	if (entry.rawContentHash !== undefined && entry.rawContentHash !== rawContentHash) {
		throw new Error("Manifest raw revision has changed; create a new source record before rebuilding.");
	}
	if (entry.rawContentHash === undefined) {
		const previousIndex = readEvidenceIndex(l2DataDir, entry.id, rawContentHash);
		if (previousIndex.status === "stale-source") {
			throw new Error("Manifest raw revision has changed; create a new source record before rebuilding.");
		}
	}
	validateSourceBytes(extname(rawAbsolutePath), rawBytes, entry.sourceType);

	const parsed = await parseDocumentBytes(rawAbsolutePath, rawBytes);
	const verifiedSnapshot = readSourceBytes(rawPaths);
	if (verifiedSnapshot.status !== "ready" || verifiedSnapshot.rawContentHash !== rawContentHash) {
		throw new Error("Manifest raw revision changed while rebuilding; no index was written.");
	}
	const verifiedPaths = resolveRawSourcePath(l2DataDir, entry);
	if (
		verifiedPaths.status !== "ready"
		|| !equalFilesystemPath(verifiedPaths.rawAbsolutePath, rawAbsolutePath)
	) {
		throw new Error("Manifest raw revision changed while rebuilding; no index was written.");
	}
	const index = buildEvidenceIndex({
		sourceId: entry.id,
		sourceType: entry.sourceType,
		rawContentHash,
		parsed,
		...(entry.sourceType === "markdown" && entry.rawKind !== "uploaded-original"
			? { markdownContent: rawBytes.toString("utf8") }
			: {}),
	});
	writeEvidenceIndexAtomic(l2DataDir, index);
	return index;
}
