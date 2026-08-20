import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, win32 } from "node:path";
import { parse as parseYaml } from "yaml";

import {
	normalizeEvidenceTextForQuoteMatching,
	readEvidenceIndex,
	type EvidenceBlock,
	type EvidenceIndexReadResult,
} from "./evidence-index.js";
import {
	decodeEvidenceRefs,
	type EvidenceLocator,
	type EvidenceRef,
	type EvidenceReferenceIssue,
} from "./evidence-types.js";
import { readManifest } from "./manifest-store.js";
import { resolveRawSourcePath } from "./source-path.js";
import { readSourceRevision } from "./source-revision.js";
import type { ManifestEntry, RawSourceType } from "./types.js";
import { bodyRevision, fileRevision } from "./wiki-maintainer.js";

export type PositionReasonCode =
	| "missing-source"
	| "missing-file"
	| "stale-source"
	| "missing-index"
	| "corrupt-index"
	| "index-version-mismatch"
	| "stale-page"
	| "locator-invalid"
	| "quote-mismatch"
	| "drifted";

export interface ResolvedEvidenceReference {
	quote: string;
	locator: EvidenceLocator;
	selectedBy: "model" | "user";
	positionStatus: "verified" | PositionReasonCode;
	reasonCodes: PositionReasonCode[];
	/** Inline citation number matching a `[n]` marker in the page body, if any. */
	marker?: number;
}

interface SourceMetadata {
	sourceId: string;
	title: string;
	sourceType: RawSourceType;
	origin: ManifestEntry["source"]["origin"];
	rawKind?: ManifestEntry["rawKind"];
	references: ResolvedEvidenceReference[];
}

export type SourceProvenanceGroup =
	| (SourceMetadata & {
		availability: "ready";
		rawRelativePath: string;
		sourceRevision: string;
	})
	| (SourceMetadata & {
		availability: "missing-file";
		rawRelativePath?: string;
		lastKnownSourceRevision?: string;
	})
	| {
		availability: "missing-source";
		sourceId: string;
		references: ResolvedEvidenceReference[];
	};

export interface ProvenancePayload {
	sourceGroups: SourceProvenanceGroup[];
	legacyPaths: string[];
	referenceIssues: EvidenceReferenceIssue[];
}

export interface WikiPageDetail {
	path: string;
	content: string;
	pageRevision: string;
	fileRevision: string;
	provenance: ProvenancePayload;
}

interface ParsedWikiContent {
	body: string;
	sourceIds: string[];
	legacyPaths: string[];
	rawEvidenceRefs: unknown;
}

interface OrderedEvidenceRef {
	ordinal: number;
	ref: EvidenceRef;
}

interface SourceState {
	group: SourceProvenanceGroup;
	sourceRevision?: string;
	indexResult?: EvidenceIndexReadResult;
}

const WIKI_PATH = /^wiki\/(?:sources|entities|concepts|analysis)\/[^/]+\.md$/u;
const DRIVE_PREFIX = /^[A-Za-z]:/u;
const FULL_LOWERCASE_SHA256 = /^[0-9a-f]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeWikiPath(wikiPath: string): string {
	if (
		wikiPath.length === 0
		|| wikiPath.includes("\0")
		|| isAbsolute(wikiPath)
		|| win32.isAbsolute(wikiPath)
		|| DRIVE_PREFIX.test(wikiPath)
	) {
		throw new Error("Unsafe Wiki page path.");
	}
	const normalized = wikiPath.replace(/\\/gu, "/");
	const segments = normalized.split("/");
	if (
		segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
		|| !WIKI_PATH.test(normalized)
	) {
		throw new Error("Unsafe Wiki page path.");
	}
	return normalized;
}

function equalFilesystemPath(left: string, right: string): boolean {
	return process.platform === "win32"
		? left.toLowerCase() === right.toLowerCase()
		: left === right;
}

function readWikiPageBytes(l2DataDir: string, wikiPath: string): Buffer {
	const segments = wikiPath.split("/");
	const rootStats = lstatSync(l2DataDir);
	if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) throw new Error("Unsafe Wiki page path.");
	let canonicalParent = realpathSync.native(l2DataDir);

	for (const [ordinal, segment] of segments.entries()) {
		const candidate = join(canonicalParent, segment);
		const stats = lstatSync(candidate);
		if (stats.isSymbolicLink()) throw new Error("Unsafe Wiki page path.");
		const target = ordinal === segments.length - 1;
		if ((target && !stats.isFile()) || (!target && !stats.isDirectory())) {
			throw new Error("Unsafe Wiki page path.");
		}
		const canonical = realpathSync.native(candidate);
		if (!equalFilesystemPath(candidate, canonical)) throw new Error("Unsafe Wiki page path.");
		canonicalParent = canonical;
	}
	return readFileSync(canonicalParent);
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
		: [];
}

function parseWikiContent(content: string): ParsedWikiContent {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?([\s\S]*)$/u);
	if (!match) return { body: content, sourceIds: [], legacyPaths: [], rawEvidenceRefs: undefined };

	let raw: Record<string, unknown> = {};
	try {
		const parsed = parseYaml(match[1]) as unknown;
		if (isRecord(parsed)) raw = parsed;
	} catch {
		// Malformed frontmatter is treated as having no trusted provenance fields.
	}
	return {
		body: match[2],
		sourceIds: stringArray(raw.source_ids),
		legacyPaths: stringArray(raw.sources),
		rawEvidenceRefs: raw.evidence_refs,
	};
}

function decodeOrderedEvidenceRefs(
	raw: unknown,
	declaredSourceIds: readonly string[],
): { refs: OrderedEvidenceRef[]; issues: EvidenceReferenceIssue[] } {
	if (raw === undefined) return { refs: [], issues: [] };
	if (!Array.isArray(raw)) return { refs: [], issues: [{ ordinal: 0, code: "not-object" }] };

	const refs: OrderedEvidenceRef[] = [];
	const issues: EvidenceReferenceIssue[] = [];
	const seenMarkers = new Set<number>();
	for (const [ordinal, candidate] of raw.entries()) {
		const decoded = decodeEvidenceRefs([candidate], declaredSourceIds);
		for (const ref of decoded.valid) {
			if (ref.marker !== undefined && seenMarkers.has(ref.marker)) {
				issues.push({
					ordinal,
					sourceId: ref.source_id,
					code: "invalid-marker",
				});
				continue;
			}
			if (ref.marker !== undefined) seenMarkers.add(ref.marker);
			refs.push({ ordinal, ref });
		}
		for (const item of decoded.issues) issues.push({ ...item, ordinal });
	}
	return { refs, issues };
}

function uniqueInOrder(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function conservativeRawKind(entry: ManifestEntry): ManifestEntry["rawKind"] | undefined {
	if (entry.rawKind !== undefined) return entry.rawKind;
	return entry.sourceType === "text" || entry.sourceType === "conversation"
		? "archived-text"
		: undefined;
}

function lastKnownRevision(entry: ManifestEntry): string | undefined {
	return entry.rawContentHash !== undefined && FULL_LOWERCASE_SHA256.test(entry.rawContentHash)
		? `sha256:${entry.rawContentHash}`
		: undefined;
}

function metadata(entry: ManifestEntry): Omit<SourceMetadata, "references"> {
	const rawKind = conservativeRawKind(entry);
	return {
		sourceId: entry.id,
		title: entry.title,
		sourceType: entry.sourceType,
		origin: entry.source.origin,
		...(rawKind === undefined ? {} : { rawKind }),
	};
}

function buildSourceState(l2DataDir: string, sourceId: string, entry: ManifestEntry | undefined): SourceState {
	if (entry === undefined) {
		return { group: { availability: "missing-source", sourceId, references: [] } };
	}

	const paths = resolveRawSourcePath(l2DataDir, entry);
	if (paths.status !== "ready") {
		const known = lastKnownRevision(entry);
		return {
			group: {
				availability: "missing-file",
				...metadata(entry),
				...(paths.status === "missing-file" ? { rawRelativePath: paths.rawRelativePath } : {}),
				...(known === undefined ? {} : { lastKnownSourceRevision: known }),
				references: [],
			},
		};
	}

	const revision = readSourceRevision(paths);
	if (revision.status !== "ready") {
		const known = lastKnownRevision(entry);
		return {
			group: {
				availability: "missing-file",
				...metadata(entry),
				...(revision.status === "unsafe-path" ? {} : { rawRelativePath: paths.rawRelativePath }),
				...(known === undefined ? {} : { lastKnownSourceRevision: known }),
				references: [],
			},
		};
	}

	return {
		group: {
			availability: "ready",
			...metadata(entry),
			rawRelativePath: paths.rawRelativePath,
			sourceRevision: revision.sourceRevision,
			references: [],
		},
		sourceRevision: revision.sourceRevision,
		indexResult: readEvidenceIndex(l2DataDir, sourceId, revision.rawContentHash),
	};
}

function locatorForBlock(block: EvidenceBlock): EvidenceLocator {
	if (block.kind === "pdf") {
		return { kind: "pdf-page", page: block.page!, block_id: block.id };
	}
	if (block.kind === "markdown") {
		return {
			kind: "markdown-block",
			block_id: block.id,
			...(block.heading === undefined ? {} : { heading: block.heading }),
			paragraph: block.paragraph!,
		};
	}
	return {
		kind: "docx-paragraph",
		block_id: block.id,
		...(block.heading === undefined ? {} : { heading: block.heading }),
		paragraph: block.paragraph!,
	};
}

function sameLocator(left: EvidenceLocator, right: EvidenceLocator): boolean {
	if (left.kind !== right.kind || left.block_id !== right.block_id) return false;
	if (left.kind === "pdf-page" && right.kind === "pdf-page") return left.page === right.page;
	if (left.kind === "markdown-block" && right.kind === "markdown-block") {
		return left.paragraph === right.paragraph && left.heading === right.heading;
	}
	if (left.kind === "docx-paragraph" && right.kind === "docx-paragraph") {
		return left.paragraph === right.paragraph && left.heading === right.heading;
	}
	return false;
}

function countOccurrences(text: string, quote: string): number {
	let count = 0;
	let offset = 0;
	while (offset <= text.length - quote.length) {
		const match = text.indexOf(quote, offset);
		if (match < 0) break;
		count += 1;
		if (count > 1) return count;
		offset = match + 1;
	}
	return count;
}

function addReason(reasons: PositionReasonCode[], reason: PositionReasonCode): void {
	if (!reasons.includes(reason)) reasons.push(reason);
}

function indexReason(indexResult: EvidenceIndexReadResult | undefined): PositionReasonCode | undefined {
	if (indexResult === undefined || indexResult.status === "ready") return undefined;
	return indexResult.status;
}

function resolveReference(
	ref: EvidenceRef,
	state: SourceState,
	currentPageRevision: string,
): ResolvedEvidenceReference {
	const reasons: PositionReasonCode[] = [];
	let locator = ref.locator;

	if (state.group.availability === "missing-source") {
		addReason(reasons, "missing-source");
	} else if (state.group.availability === "missing-file") {
		addReason(reasons, "missing-file");
	} else {
		if (ref.source_revision !== state.sourceRevision) addReason(reasons, "stale-source");
		const unavailableIndexReason = indexReason(state.indexResult);
		if (unavailableIndexReason !== undefined) addReason(reasons, unavailableIndexReason);
	}

	if (ref.page_revision !== currentPageRevision) addReason(reasons, "stale-page");

	const sourceIsCurrent = state.group.availability === "ready"
		&& ref.source_revision === state.sourceRevision;
	if (sourceIsCurrent && state.indexResult?.status === "ready") {
		const blocks = state.indexResult.index.blocks;
		const target = blocks.find((block) => block.id === ref.locator.block_id);
		const authoritativeTargetLocator = target === undefined ? undefined : locatorForBlock(target);
		if (authoritativeTargetLocator === undefined || !sameLocator(ref.locator, authoritativeTargetLocator)) {
			addReason(reasons, "locator-invalid");
			if (authoritativeTargetLocator !== undefined) locator = authoritativeTargetLocator;
		}

		const normalizedQuote = normalizeEvidenceTextForQuoteMatching(ref.quote);
		const targetMatches = target !== undefined
			&& countOccurrences(normalizeEvidenceTextForQuoteMatching(target.text), normalizedQuote) === 1;
		if (!targetMatches) {
			addReason(reasons, "quote-mismatch");
			let matchCount = 0;
			let uniqueMatch: EvidenceBlock | undefined;
			for (const block of blocks) {
				const normalizedBlock = normalizeEvidenceTextForQuoteMatching(block.text);
				const occurrences = countOccurrences(normalizedBlock, normalizedQuote);
				if (occurrences === 1 && matchCount === 0) uniqueMatch = block;
				matchCount += occurrences;
				if (matchCount > 1) {
					uniqueMatch = undefined;
					break;
				}
			}
			if (matchCount === 1 && uniqueMatch !== undefined && uniqueMatch.id !== target?.id) {
				locator = locatorForBlock(uniqueMatch);
				addReason(reasons, "drifted");
			}
		}
	}

	return {
		quote: ref.quote,
		locator,
		selectedBy: ref.selected_by,
		positionStatus: reasons[0] ?? "verified",
		reasonCodes: reasons,
		...(ref.marker === undefined ? {} : { marker: ref.marker }),
	};
}

function resolveFromBytes(l2DataDir: string, path: string, bytes: Buffer): WikiPageDetail {
	const content = bytes.toString("utf8");
	const parsed = parseWikiContent(content);
	const currentPageRevision = bodyRevision(parsed.body);
	const decoded = decodeOrderedEvidenceRefs(parsed.rawEvidenceRefs, parsed.sourceIds);
	const entriesById = new Map<string, ManifestEntry>();
	for (const entry of readManifest(l2DataDir)) {
		if (!entriesById.has(entry.id)) entriesById.set(entry.id, entry);
	}

	const states = new Map<string, SourceState>();
	for (const sourceId of uniqueInOrder(parsed.sourceIds)) {
		states.set(sourceId, buildSourceState(l2DataDir, sourceId, entriesById.get(sourceId)));
	}
	for (const { ref } of decoded.refs) {
		const state = states.get(ref.source_id);
		if (state === undefined) continue;
		state.group.references.push(resolveReference(ref, state, currentPageRevision));
	}

	return {
		path,
		content,
		pageRevision: currentPageRevision,
		fileRevision: fileRevision(bytes),
		provenance: {
			sourceGroups: [...states.values()].map((state) => state.group),
			legacyPaths: parsed.legacyPaths,
			referenceIssues: decoded.issues,
		},
	};
}

export function resolveWikiPageDetail(l2DataDir: string, wikiPath: string): WikiPageDetail {
	const path = normalizeWikiPath(wikiPath);
	return resolveFromBytes(l2DataDir, path, readWikiPageBytes(l2DataDir, path));
}

export function resolveWikiPageDetailFromContent(
	l2DataDir: string,
	wikiPath: string,
	content: string | Uint8Array,
): WikiPageDetail {
	const path = normalizeWikiPath(wikiPath);
	const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
	return resolveFromBytes(l2DataDir, path, bytes);
}
