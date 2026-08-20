import type { EvidenceRef, EvidenceLocator } from "./evidence-types.js";
import {
	normalizeEvidenceTextForQuoteMatching,
	type EvidenceBlock,
	type SourceEvidenceIndex,
} from "./evidence-index.js";
import type { EvidenceCandidate } from "./evidence-selector.js";
import { MAX_EVIDENCE_MARKER } from "./evidence-markers.js";

export type { EvidenceCandidate } from "./evidence-selector.js";

export interface EvidenceResolutionContext {
	sourceId: string;
	sourceRevision: string;
	pageRevision: string;
	index: SourceEvidenceIndex;
	/** When present, only these canonical identities may be published. */
	canonicalReferences?: readonly EvidenceRef[];
}

export interface EvidenceRejection {
	candidateIndex: number;
	sourceId?: string;
	blockId?: string;
	code:
		| "invalid-shape"
		| "unknown-source"
		| "missing-block"
		| "invalid-quote"
		| "quote-not-found"
		| "quote-not-unique"
		| "revision-mismatch"
		| "locator-mismatch"
		| "identity-mismatch";
}

const SHA256_REVISION = /^sha256:[0-9a-f]{64}$/;
const RAW_SHA256 = /^[0-9a-f]{64}$/;
const MAX_QUOTE_CODE_POINTS = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactCandidateKeys(value: Record<string, unknown>): boolean {
	const keys = Object.keys(value).sort();
	const expected = ["block_id", "quote", "source_id"];
	return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function isRuntimeCandidate(value: unknown): value is EvidenceCandidate {
	return isRecord(value)
		&& hasExactCandidateKeys(value)
		&& typeof value.source_id === "string"
		&& value.source_id.length > 0
		&& typeof value.block_id === "string"
		&& value.block_id.length > 0
		&& typeof value.quote === "string";
}

function diagnosticValue(value: unknown): string | undefined {
	return typeof value === "string"
		&& value.length > 0
		&& value.length <= 160
		&& !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
		? value
		: undefined;
}

function reject(
	candidateIndex: number,
	code: EvidenceRejection["code"],
	candidate: unknown,
): EvidenceRejection {
	const sourceId = isRecord(candidate) ? diagnosticValue(candidate.source_id) : undefined;
	const blockId = isRecord(candidate) ? diagnosticValue(candidate.block_id) : undefined;
	return {
		candidateIndex,
		...(sourceId === undefined ? {} : { sourceId }),
		...(blockId === undefined ? {} : { blockId }),
		code,
	};
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function locatorFromBlock(block: EvidenceBlock): EvidenceLocator | null {
	if (block.kind === "pdf") {
		if (!isPositiveInteger(block.page) || block.heading !== undefined || block.paragraph !== undefined) return null;
		return { kind: "pdf-page", page: block.page, block_id: block.id };
	}
	if (block.kind === "markdown") {
		if (block.page !== undefined || !isPositiveInteger(block.paragraph)) return null;
		if (block.heading !== undefined && typeof block.heading !== "string") return null;
		return {
			kind: "markdown-block",
			block_id: block.id,
			...(block.heading === undefined ? {} : { heading: block.heading }),
			paragraph: block.paragraph,
		};
	}
	if (block.kind === "docx") {
		if (block.page !== undefined || !isPositiveInteger(block.paragraph)) return null;
		if (block.heading !== undefined && typeof block.heading !== "string") return null;
		return {
			kind: "docx-paragraph",
			block_id: block.id,
			...(block.heading === undefined ? {} : { heading: block.heading }),
			paragraph: block.paragraph,
		};
	}
	return null;
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

function isValidQuote(quote: string): boolean {
	if (normalizeEvidenceTextForQuoteMatching(quote).length === 0) return false;
	let codePoints = 0;
	for (const _codePoint of quote) {
		codePoints += 1;
		if (codePoints > MAX_QUOTE_CODE_POINTS) return false;
	}
	return true;
}

function normalizedMatchCount(blockText: string, quote: string): number {
	const haystack = normalizeEvidenceTextForQuoteMatching(blockText);
	const needle = normalizeEvidenceTextForQuoteMatching(quote);
	let count = 0;
	let offset = 0;
	while (offset <= haystack.length - needle.length) {
		const match = haystack.indexOf(needle, offset);
		if (match < 0) break;
		count += 1;
		if (count > 1) return count;
		offset = match + 1;
	}
	return count;
}

function contextFailure(context: EvidenceResolutionContext): EvidenceRejection["code"] | null {
	if (context.index.source_id !== context.sourceId) return "unknown-source";
	if (
		context.index.version !== 1
		|| !RAW_SHA256.test(context.index.raw_content_hash)
		|| !SHA256_REVISION.test(context.sourceRevision)
		|| context.sourceRevision !== `sha256:${context.index.raw_content_hash}`
		|| !SHA256_REVISION.test(context.pageRevision)
	) {
		return "revision-mismatch";
	}
	return null;
}

export function resolveEvidenceCandidates(
	candidates: readonly EvidenceCandidate[],
	context: EvidenceResolutionContext,
): { accepted: EvidenceRef[]; rejected: EvidenceRejection[] } {
	const accepted: EvidenceRef[] = [];
	const rejected: EvidenceRejection[] = [];
	const failure = contextFailure(context);
	if (failure) {
		for (const [candidateIndex, candidate] of candidates.entries()) {
			rejected.push(reject(candidateIndex, failure, candidate));
		}
		return { accepted, rejected };
	}

	const blocks = new Map(context.index.blocks.map((block) => [block.id, block]));
	for (const [candidateIndex, rawCandidate] of candidates.entries()) {
		if (!isRuntimeCandidate(rawCandidate)) {
			rejected.push(reject(candidateIndex, "invalid-shape", rawCandidate));
			continue;
		}
		if (rawCandidate.source_id !== context.sourceId) {
			rejected.push(reject(candidateIndex, "unknown-source", rawCandidate));
			continue;
		}
		const block = blocks.get(rawCandidate.block_id);
		if (!block) {
			rejected.push(reject(candidateIndex, "missing-block", rawCandidate));
			continue;
		}
		const locator = locatorFromBlock(block);
		if (!locator) {
			rejected.push(reject(candidateIndex, "locator-mismatch", rawCandidate));
			continue;
		}
		if (!isValidQuote(rawCandidate.quote)) {
			rejected.push(reject(candidateIndex, "invalid-quote", rawCandidate));
			continue;
		}
		const matchCount = normalizedMatchCount(block.text, rawCandidate.quote);
		if (matchCount === 0) {
			rejected.push(reject(candidateIndex, "quote-not-found", rawCandidate));
			continue;
		}
		if (matchCount > 1) {
			rejected.push(reject(candidateIndex, "quote-not-unique", rawCandidate));
			continue;
		}
		const canonical = context.canonicalReferences?.find((reference) => (
			reference.source_id === context.sourceId
			&& reference.quote === rawCandidate.quote
			&& sameLocator(reference.locator, locator)
		));
		if (context.canonicalReferences !== undefined && !canonical) {
			rejected.push(reject(candidateIndex, "identity-mismatch", rawCandidate));
			continue;
		}

		accepted.push({
			source_id: context.sourceId,
			quote: canonical?.quote ?? rawCandidate.quote,
			source_revision: context.sourceRevision,
			page_revision: context.pageRevision,
			index_version: 1,
			selected_by: "model",
			locator: canonical?.locator ?? locator,
		});
	}
	return { accepted, rejected };
}

/** A grounded citation produced by the summarizer: a marker plus a verbatim quote. */
export interface GroundedCitationInput {
	marker: number;
	quote: string;
}

function isRuntimeGroundedCitation(value: unknown): value is GroundedCitationInput {
	return isRecord(value) && typeof value.marker === "number" && typeof value.quote === "string";
}

/**
 * Bind grounded citations (marker + verbatim quote, no block id) to a unique
 * evidence block, producing locator-bearing refs that carry the inline marker.
 *
 * A citation is accepted only when its quote occurs exactly once across the
 * whole source index (and exactly once within that block), so the inline
 * `[n]` marker can always jump to a single, unambiguous location.
 */
export function resolveGroundedCitations(
	citations: readonly GroundedCitationInput[],
	context: EvidenceResolutionContext,
): { accepted: EvidenceRef[]; rejected: EvidenceRejection[] } {
	const accepted: EvidenceRef[] = [];
	const rejected: EvidenceRejection[] = [];
	const seenMarkers = new Set<number>();
	const seenQuotes = new Set<string>();
	const failure = contextFailure(context);
	if (failure) {
		for (let candidateIndex = 0; candidateIndex < citations.length; candidateIndex += 1) {
			rejected.push({ candidateIndex, code: failure });
		}
		return { accepted, rejected };
	}

	for (const [candidateIndex, citation] of citations.entries()) {
		if (
			!isRuntimeGroundedCitation(citation)
			|| !isPositiveInteger(citation.marker)
			|| citation.marker > MAX_EVIDENCE_MARKER
			|| !isValidQuote(citation.quote)
			|| seenMarkers.has(citation.marker)
			|| seenQuotes.has(normalizeEvidenceTextForQuoteMatching(citation.quote))
		) {
			rejected.push({ candidateIndex, code: "invalid-quote" });
			continue;
		}
		seenMarkers.add(citation.marker);
		seenQuotes.add(normalizeEvidenceTextForQuoteMatching(citation.quote));

		let uniqueBlock: EvidenceBlock | undefined;
		let multiple = false;
		for (const block of context.index.blocks) {
			const count = normalizedMatchCount(block.text, citation.quote);
			if (count === 0) continue;
			if (count > 1 || uniqueBlock !== undefined) {
				multiple = true;
				break;
			}
			uniqueBlock = block;
		}
		if (uniqueBlock === undefined) {
			rejected.push({ candidateIndex, code: "quote-not-found" });
			continue;
		}
		if (multiple) {
			rejected.push({ candidateIndex, code: "quote-not-unique" });
			continue;
		}
		const locator = locatorFromBlock(uniqueBlock);
		if (!locator) {
			rejected.push({ candidateIndex, code: "locator-mismatch" });
			continue;
		}

		accepted.push({
			source_id: context.sourceId,
			quote: citation.quote,
			source_revision: context.sourceRevision,
			page_revision: context.pageRevision,
			index_version: 1,
			selected_by: "model",
			locator,
			marker: citation.marker,
		});
	}
	return { accepted, rejected };
}
