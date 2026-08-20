import { existsSync } from "node:fs";
import { isMap, parseDocument } from "yaml";

import {
	readEvidenceIndex,
	normalizeEvidenceTextForQuoteMatching,
	type SourceEvidenceIndex,
} from "./evidence-index.js";
import {
	resolveEvidenceCandidates,
	type EvidenceCandidate,
} from "./evidence-resolver.js";
import type { EvidenceCandidateSelector } from "./evidence-selector.js";
import { decodeEvidenceRefs, type EvidenceRef } from "./evidence-types.js";
import { readManifest } from "./manifest-store.js";
import {
	resolveWikiPageDetail,
	type WikiPageDetail,
} from "./provenance-resolver.js";
import type { ManifestEntry } from "./types.js";
import {
	getWikiPageWriteQueue,
	type WikiPageWriteQueue,
} from "./wiki-page-write-queue.js";
import {
	resolveAllowedWikiPage,
	type AllowedWikiPagePath,
} from "../../server/wiki-page-path.js";

export interface EvidenceMutationRequest {
	path: string;
	expectedPageRevision: string;
	expectedFileRevision: string;
}

export type EvidenceRefreshErrorCode =
	| "invalid_request"
	| "wiki_page_not_found"
	| "model_unavailable"
	| "no_valid_candidates"
	| "page_changed"
	| "wiki_page_write_failed";

export class EvidenceRefreshError extends Error {
	readonly code: EvidenceRefreshErrorCode;
	readonly status: number;

	constructor(code: EvidenceRefreshErrorCode, message: string, status = statusFor(code)) {
		super(message);
		this.name = "EvidenceRefreshError";
		this.code = code;
		this.status = status;
	}
}

export interface EvidenceRefreshServiceOptions {
	l2DataDir: string;
	selector?: EvidenceCandidateSelector | null;
	getSelector?: () => EvidenceCandidateSelector | null;
	queue?: WikiPageWriteQueue;
	/** Atomic, boundary-checked Wiki writer supplied by the route layer. */
	writePage: (
		resolved: AllowedWikiPagePath,
		content: string,
		expectedFileRevision: string,
	) => void;
	indexPage?: (path: string) => Promise<void>;
}

const REVISION = /^sha256:[0-9a-f]{64}$/u;
const RAW_REVISION = /^sha256:([0-9a-f]{64})$/u;

function statusFor(code: EvidenceRefreshErrorCode): number {
	switch (code) {
		case "invalid_request": return 400;
		case "wiki_page_not_found": return 404;
		case "model_unavailable":
		case "no_valid_candidates": return 409;
		case "page_changed": return 409;
		case "wiki_page_write_failed": return 500;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function entryById(l2DataDir: string): Map<string, ManifestEntry> {
	return new Map(readManifest(l2DataDir).map((entry) => [entry.id, entry]));
}

function sourceIndex(
	l2DataDir: string,
	entry: ManifestEntry,
	sourceRevision: string,
): SourceEvidenceIndex | null {
	const match = RAW_REVISION.exec(sourceRevision);
	if (!match) return null;
	const result = readEvidenceIndex(l2DataDir, entry.id, match[1]);
	return result.status === "ready" ? result.index : null;
}

interface ParsedWikiDocument {
	body: string;
	rawFrontmatter: Record<string, unknown>;
	withEvidenceRefs(refs: readonly unknown[]): string;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string" && item.length > 0)
		: [];
}

function parseWikiDocument(content: string): ParsedWikiDocument | null {
	const match = content.match(/^---(\r?\n)([\s\S]*?)\r?\n---(?:\r?\n)?([\s\S]*)$/u);
	if (!match) return null;
	const lineBreak = match[1];
	const document = parseDocument(match[2], { prettyErrors: false });
	if (document.errors.length > 0 || !isMap(document.contents)) return null;
	const raw = document.toJS() as unknown;
	if (!isRecord(raw)) return null;
	return {
		body: match[3],
		rawFrontmatter: raw,
		withEvidenceRefs(refs: readonly unknown[]): string {
			if (refs.length === 0) document.delete("evidence_refs");
			else document.set("evidence_refs", [...refs]);
			const yaml = document.toString({ lineWidth: 0 }).trimEnd().replace(/\n/gu, lineBreak);
			return `---${lineBreak}${yaml}${lineBreak}---${lineBreak}${match[3]}`;
		},
	};
}

function evidenceIdentity(ref: { locator: { block_id: string }; quote: string }): string {
	return `${ref.locator.block_id}\u0000${normalizeEvidenceTextForQuoteMatching(ref.quote)}`;
}

function quotesOverlap(left: string, right: string): boolean {
	const normalizedLeft = normalizeEvidenceTextForQuoteMatching(left);
	const normalizedRight = normalizeEvidenceTextForQuoteMatching(right);
	return normalizedLeft.length > 0
		&& normalizedRight.length > 0
		&& (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft));
}

function candidateShape(value: unknown): value is EvidenceCandidate {
	return isRecord(value)
		&& typeof value.source_id === "string"
		&& typeof value.block_id === "string"
		&& typeof value.quote === "string";
}

function modelRefBelongsToSource(value: unknown, sourceId: string): boolean {
	return isRecord(value) && value.source_id === sourceId && value.selected_by === "model";
}

function filterVerifiedRawRefs(
	values: readonly unknown[],
	declaredSourceIds: readonly string[],
	detail: WikiPageDetail,
): unknown[] {
	const cursors = new Map(detail.provenance.sourceGroups.map((group) => [
		group.sourceId,
		{ references: group.references, ordinal: 0 },
	]));
	const kept: unknown[] = [];
	for (const value of values) {
		const decoded = decodeEvidenceRefs([value], declaredSourceIds);
		if (decoded.valid.length !== 1) continue;
		const cursor = cursors.get(decoded.valid[0].source_id);
		if (!cursor) continue;
		const resolved = cursor.references[cursor.ordinal];
		cursor.ordinal += 1;
		if (resolved?.positionStatus === "verified") kept.push(value);
	}
	return kept;
}

function revalidateAcceptedSources(
	l2DataDir: string,
	current: WikiPageDetail,
	entries: ReadonlyMap<string, ManifestEntry>,
	acceptedBySource: ReadonlyMap<string, readonly EvidenceRef[]>,
): Map<string, EvidenceRef[]> {
	const revalidated = new Map<string, EvidenceRef[]>();
	for (const group of current.provenance.sourceGroups) {
		if (group.availability !== "ready") continue;
		const accepted = acceptedBySource.get(group.sourceId);
		const entry = entries.get(group.sourceId);
		if (
			!accepted
			|| !entry
			|| accepted.some((ref) => ref.source_revision !== group.sourceRevision)
		) continue;
		const index = sourceIndex(l2DataDir, entry, group.sourceRevision);
		if (!index) continue;
		const result = resolveEvidenceCandidates(
			accepted.map((ref) => ({
				source_id: ref.source_id,
				block_id: ref.locator.block_id,
				quote: ref.quote,
			})),
			{
				sourceId: group.sourceId,
				sourceRevision: group.sourceRevision,
				pageRevision: current.pageRevision,
				index,
			},
		);
		if (result.accepted.length > 0) {
			// Re-attach inline citation markers by quote so a manual refresh does
			// not silently strip the `[n]` markers already present in the body.
			const ambiguousIdentities = new Set<string>();
			const markerByIdentity = new Map<string, number>();
			for (const ref of group.references) {
				if (ref.marker === undefined) continue;
				const identity = evidenceIdentity(ref);
				if (ambiguousIdentities.has(identity)) continue;
				if (markerByIdentity.has(identity)) {
					markerByIdentity.delete(identity);
					ambiguousIdentities.add(identity);
					continue;
				}
				markerByIdentity.set(identity, ref.marker);
			}
			const usedMarkers = new Set<number>();
			const withMarkers = result.accepted.map((ref) => {
				const identity = evidenceIdentity(ref);
				let marker = ambiguousIdentities.has(identity) ? undefined : markerByIdentity.get(identity);
				if (marker !== undefined && usedMarkers.has(marker)) marker = undefined;
				if (marker === undefined) {
					const related = group.references.filter((existing) =>
						existing.marker !== undefined
						&& !usedMarkers.has(existing.marker)
						&& existing.locator.block_id === ref.locator.block_id
						&& quotesOverlap(existing.quote, ref.quote));
					if (related.length === 1) marker = related[0].marker;
				}
				if (marker !== undefined) usedMarkers.add(marker);
				return marker === undefined ? ref : { ...ref, marker };
			});
			revalidated.set(group.sourceId, withMarkers);
		}
	}
	return revalidated;
}

function validateRequest(request: EvidenceMutationRequest): void {
	if (
		typeof request.path !== "string"
		|| request.path.length === 0
		|| !REVISION.test(request.expectedPageRevision)
		|| !REVISION.test(request.expectedFileRevision)
	) {
		throw new EvidenceRefreshError("invalid_request", "Invalid evidence mutation request.");
	}
}

export class EvidenceRefreshService {
	private readonly queue: WikiPageWriteQueue;

	constructor(private readonly options: EvidenceRefreshServiceOptions) {
		this.queue = options.queue ?? getWikiPageWriteQueue(options.l2DataDir);
	}

	async refresh(request: EvidenceMutationRequest): Promise<WikiPageDetail> {
		validateRequest(request);
		const resolved = this.resolvePage(request.path, "read");
		const initial = this.readExpectedPage(resolved, request);
		const selector = this.options.getSelector
			? this.options.getSelector()
			: (this.options.selector ?? null);
		if (!selector) throw new EvidenceRefreshError("model_unavailable", "No model is available for evidence refresh.");

		const entries = entryById(this.options.l2DataDir);
		const acceptedBySource = new Map<string, EvidenceRef[]>();
		for (const group of initial.provenance.sourceGroups) {
			if (group.availability !== "ready") continue;
			const entry = entries.get(group.sourceId);
			if (!entry) continue;
			const index = sourceIndex(this.options.l2DataDir, entry, group.sourceRevision);
			if (!index) continue;
			let candidates: readonly EvidenceCandidate[] = [];
			try {
				const selected = await selector.select({
					pagePath: initial.path,
					pageBody: bodyFromContent(initial.content),
					sourceId: group.sourceId,
					blocks: index.blocks,
				});
				candidates = selected.filter(candidateShape);
			} catch {
				candidates = [];
			}
			const resolvedCandidates = resolveEvidenceCandidates(candidates, {
				sourceId: group.sourceId,
				sourceRevision: group.sourceRevision,
				pageRevision: initial.pageRevision,
				index,
			});
			if (resolvedCandidates.accepted.length > 0) {
				acceptedBySource.set(group.sourceId, resolvedCandidates.accepted);
			}
		}

		if (acceptedBySource.size === 0) {
			throw new EvidenceRefreshError("no_valid_candidates", "No valid evidence candidates were found.");
		}

		return this.queue.run(initial.path, async () => {
			const current = this.readExpectedPage(resolved, request, true);
			const finalAccepted = revalidateAcceptedSources(
				this.options.l2DataDir,
				current,
				entries,
				acceptedBySource,
			);
			if (finalAccepted.size === 0) {
				throw new EvidenceRefreshError("no_valid_candidates", "No valid evidence candidates were found.");
			}
			const parsed = parseWikiDocument(current.content);
			if (!parsed) throw new EvidenceRefreshError("wiki_page_write_failed", "Wiki page frontmatter is unavailable.");
			const rawRefs = Array.isArray(parsed.rawFrontmatter.evidence_refs)
				? parsed.rawFrontmatter.evidence_refs
				: [];
			const replacedMarkersBySource = new Map<string, Set<number>>();
			for (const [sourceId, accepted] of finalAccepted) {
				replacedMarkersBySource.set(sourceId, new Set(
					accepted.flatMap((ref) => ref.marker === undefined ? [] : [ref.marker]),
				));
			}
			const nextRefs: unknown[] = [];
			for (const rawRef of rawRefs) {
				if (isRecord(rawRef) && typeof rawRef.source_id === "string" && finalAccepted.has(rawRef.source_id)) {
					if (modelRefBelongsToSource(rawRef, rawRef.source_id)) {
						const marker = typeof rawRef.marker === "number" ? rawRef.marker : undefined;
						// A refresh may select a different supporting quote. Keep the old
						// marker-bearing ref unless a freshly revalidated ref explicitly
						// replaces that marker, so the existing `[n]` never becomes inert.
						if (marker !== undefined && !replacedMarkersBySource.get(rawRef.source_id)?.has(marker)) {
							nextRefs.push(rawRef);
						}
						continue;
					}
				}
				nextRefs.push(rawRef);
			}
			for (const accepted of finalAccepted.values()) nextRefs.push(...accepted);
			const nextContent = parsed.withEvidenceRefs(nextRefs);
			await this.writeAndIndex(resolved, nextContent, request.expectedFileRevision);
			return resolveWikiPageDetail(this.options.l2DataDir, resolved.relativePath);
		});
	}

	async removeStale(request: EvidenceMutationRequest): Promise<WikiPageDetail> {
		validateRequest(request);
		const resolved = this.resolvePage(request.path, "read");
		return this.queue.run(resolved.relativePath, async () => {
			const current = this.readExpectedPage(resolved, request);
			const parsed = parseWikiDocument(current.content);
			if (!parsed) throw new EvidenceRefreshError("wiki_page_write_failed", "Wiki page frontmatter is unavailable.");
			const rawRefs = parsed.rawFrontmatter.evidence_refs;
			if (rawRefs === undefined) return current;
			const nextRefs = Array.isArray(rawRefs)
				? filterVerifiedRawRefs(rawRefs, stringArray(parsed.rawFrontmatter.source_ids), current)
				: [];
			if (Array.isArray(rawRefs) && nextRefs.length === rawRefs.length) return current;
			const nextContent = parsed.withEvidenceRefs(nextRefs);
			await this.writeAndIndex(resolved, nextContent, request.expectedFileRevision);
			return resolveWikiPageDetail(this.options.l2DataDir, resolved.relativePath);
		});
	}

	private resolvePage(path: string, intent: "read" | "write"): AllowedWikiPagePath {
		const resolved = resolveAllowedWikiPage(this.options.l2DataDir, path, intent);
		if (!resolved) throw new EvidenceRefreshError("invalid_request", "Invalid Wiki page path.");
		return resolved;
	}

	private readExpectedPage(
		resolved: AllowedWikiPagePath,
		request: EvidenceMutationRequest,
		missingMeansChanged = false,
	): WikiPageDetail {
		let detail: WikiPageDetail;
		try {
			if (!existsSync(resolved.absolutePath)) throw new Error();
			detail = resolveWikiPageDetail(this.options.l2DataDir, resolved.relativePath);
		} catch {
			if (missingMeansChanged) {
				throw new EvidenceRefreshError("page_changed", "Wiki page changed while the evidence action was running.");
			}
			throw new EvidenceRefreshError("wiki_page_not_found", "Wiki page not found.");
		}
		if (
			detail.pageRevision !== request.expectedPageRevision
			|| detail.fileRevision !== request.expectedFileRevision
		) {
			throw new EvidenceRefreshError("page_changed", "Wiki page changed while the evidence action was running.");
		}
		return detail;
	}

	private async writeAndIndex(
		resolved: AllowedWikiPagePath,
		content: string,
		expectedFileRevision: string,
	): Promise<void> {
		try {
			this.options.writePage(resolved, content, expectedFileRevision);
			if (this.options.indexPage) await this.options.indexPage(resolved.relativePath);
		} catch (error) {
			if (error instanceof EvidenceRefreshError) throw error;
			throw new EvidenceRefreshError("wiki_page_write_failed", "Failed to save Wiki page.");
		}
	}
}

function bodyFromContent(content: string): string {
	return parseWikiDocument(content)?.body ?? content;
}
