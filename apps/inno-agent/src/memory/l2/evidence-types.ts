import { MAX_EVIDENCE_MARKER } from "./evidence-markers.js";

export type EvidenceLocator =
	| { kind: "pdf-page"; page: number; block_id: string }
	| { kind: "markdown-block"; block_id: string; heading?: string; paragraph: number }
	| { kind: "docx-paragraph"; block_id: string; heading?: string; paragraph: number };

export interface EvidenceRef {
	source_id: string;
	quote: string;
	source_revision: string;
	page_revision: string;
	index_version: 1;
	selected_by: "model" | "user";
	locator: EvidenceLocator;
	/**
	 * Inline citation number matching a `[n]` marker in the page body. Present
	 * only for grounded summaries; absent for card-only model/user selections.
	 */
	marker?: number;
}

export interface EvidenceReferenceIssue {
	/** Zero-based index in the original evidence_refs array. */
	ordinal: number;
	sourceId?: string;
	code:
		| "not-object"
		| "invalid-source-id"
		| "source-id-not-declared"
		| "invalid-quote"
		| "invalid-revision"
		| "invalid-selected-by"
		| "invalid-locator"
		| "invalid-marker";
}

const SHA256_REVISION = /^sha256:[0-9a-f]{64}$/;
const DISPLAYABLE_SOURCE_ID = /^l2src_[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isValidQuote(value: unknown): value is string {
	if (typeof value !== "string") return false;
	let codePoints = 0;
	for (const _codePoint of value) {
		codePoints += 1;
		if (codePoints > 500) return false;
	}
	return value.trim().length > 0;
}

function decodeLocator(value: unknown): EvidenceLocator | null {
	if (!isRecord(value) || typeof value.block_id !== "string" || value.block_id.trim().length === 0) {
		return null;
	}

	if (value.kind === "pdf-page" && isPositiveInteger(value.page)) {
		return { kind: "pdf-page", page: value.page, block_id: value.block_id };
	}

	if (value.kind === "markdown-block" || value.kind === "docx-paragraph") {
		if (!isPositiveInteger(value.paragraph)) return null;
		if (value.heading !== undefined && typeof value.heading !== "string") return null;
		return {
			kind: value.kind,
			block_id: value.block_id,
			...(value.heading === undefined ? {} : { heading: value.heading }),
			paragraph: value.paragraph,
		};
	}

	return null;
}

function issue(
	ordinal: number,
	code: EvidenceReferenceIssue["code"],
	sourceId?: string,
): EvidenceReferenceIssue {
	return sourceId !== undefined && DISPLAYABLE_SOURCE_ID.test(sourceId)
		? { ordinal, sourceId, code }
		: { ordinal, code };
}

export function decodeEvidenceRefs(
	value: unknown,
	declaredSourceIds: Iterable<string>,
): { valid: EvidenceRef[]; issues: EvidenceReferenceIssue[] } {
	if (value === undefined) return { valid: [], issues: [] };

	const entries = Array.isArray(value) ? value : [value];
	const declared = new Set(declaredSourceIds);
	const valid: EvidenceRef[] = [];
	const issues: EvidenceReferenceIssue[] = [];
	const seenMarkers = new Set<number>();

	for (const [ordinal, entry] of entries.entries()) {
		if (!isRecord(entry)) {
			issues.push(issue(ordinal, "not-object"));
			continue;
		}

		if (typeof entry.source_id !== "string" || entry.source_id.trim().length === 0) {
			issues.push(issue(ordinal, "invalid-source-id"));
			continue;
		}
		const sourceId = entry.source_id;

		if (!declared.has(sourceId)) {
			issues.push(issue(ordinal, "source-id-not-declared", sourceId));
			continue;
		}

		if (!isValidQuote(entry.quote)) {
			issues.push(issue(ordinal, "invalid-quote", sourceId));
			continue;
		}

		if (
			typeof entry.source_revision !== "string"
			|| !SHA256_REVISION.test(entry.source_revision)
			|| typeof entry.page_revision !== "string"
			|| !SHA256_REVISION.test(entry.page_revision)
			|| entry.index_version !== 1
		) {
			issues.push(issue(ordinal, "invalid-revision", sourceId));
			continue;
		}

		if (entry.selected_by !== "model" && entry.selected_by !== "user") {
			issues.push(issue(ordinal, "invalid-selected-by", sourceId));
			continue;
		}

		const locator = decodeLocator(entry.locator);
		if (!locator) {
			issues.push(issue(ordinal, "invalid-locator", sourceId));
			continue;
		}

		const rawMarker = entry.marker;
		if (
			rawMarker !== undefined
			&& (
				typeof rawMarker !== "number"
				|| !Number.isSafeInteger(rawMarker)
				|| rawMarker < 1
				|| rawMarker > MAX_EVIDENCE_MARKER
			)
		) {
			issues.push(issue(ordinal, "invalid-marker", sourceId));
			continue;
		}

		if (typeof rawMarker === "number") {
			if (seenMarkers.has(rawMarker)) {
				issues.push(issue(ordinal, "invalid-marker", sourceId));
				continue;
			}
			seenMarkers.add(rawMarker);
		}

		valid.push({
			source_id: sourceId,
			quote: entry.quote,
			source_revision: entry.source_revision,
			page_revision: entry.page_revision,
			index_version: 1,
			selected_by: entry.selected_by,
			locator,
			...(typeof rawMarker === "number" ? { marker: rawMarker } : {}),
		});
	}

	return { valid, issues };
}
