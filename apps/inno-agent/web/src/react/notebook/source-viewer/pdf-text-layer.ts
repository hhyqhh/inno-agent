import {
	clearTextHighlights,
	findTextRangeAtOccurrence,
	findUniqueTextRange,
	highlightTextRange,
	findUniqueTextOffsets,
	type UniqueTextOffsetsResult,
} from "./text-highlight.js";

export type PdfTextItemMatch =
	| { status: "none" }
	| { status: "ambiguous"; count: number }
	| {
		status: "unique";
		startItem: number;
		startOffset: number;
		endItem: number;
		endOffset: number;
	};

export type PdfDomTextMatch =
	| { status: "none" }
	| { status: "ambiguous"; count: number }
	| { status: "unique"; range: Range };

interface MappedCharacter {
	value: string;
	item: number;
	startOffset: number;
	endOffset: number;
}

interface NormalizedItems {
	text: string;
	characters: MappedCharacter[];
}

function normalizeItems(items: readonly string[]): NormalizedItems {
	const characters: MappedCharacter[] = [];
	const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
	let previousWhitespace: MappedCharacter | undefined;

	for (const [itemIndex, item] of items.entries()) {
		for (const part of segmenter.segment(item)) {
			const startOffset = part.index;
			const endOffset = startOffset + part.segment.length;
			if (/^\s+$/u.test(part.segment)) {
				if (previousWhitespace) {
					previousWhitespace.endOffset = endOffset;
					previousWhitespace.item = itemIndex;
					previousWhitespace.startOffset = startOffset;
				} else {
					previousWhitespace = {
						value: " ",
						item: itemIndex,
						startOffset,
						endOffset,
					};
					characters.push(previousWhitespace);
				}
				continue;
			}

			previousWhitespace = undefined;
			const normalized = part.segment.normalize("NFC");
			for (let offset = 0; offset < normalized.length; offset += 1) {
				characters.push({ value: normalized[offset], item: itemIndex, startOffset, endOffset });
			}
		}
	}

	return { text: characters.map((character) => character.value).join(""), characters };
}

function normalizedNeedle(value: string): string {
	return normalizeItems([value]).text.trim();
}

/** Normalize PDF text items in the same view used by quote matching. */
export function normalizePdfText(items: readonly string[]): string {
	return normalizeItems(items).text;
}

/**
 * Find a quote only when it occurs once in the ordered PDF text items.
 * Returning item offsets lets callers map the result back to text-layer spans
 * without guessing when a quote crosses PDF text runs.
 */
export function findUniquePdfTextItemMatch(items: readonly string[], quote: string, occurrence?: number): PdfTextItemMatch {
	const normalized = normalizeItems(items);
	const needle = normalizedNeedle(quote);
	if (needle.length === 0) return { status: "none" };

	const matches: number[] = [];
	let from = 0;
	while (from <= normalized.text.length - needle.length) {
		const index = normalized.text.indexOf(needle, from);
		if (index < 0) break;
		matches.push(index);
		from = index + 1;
	}
	if (matches.length === 0) return { status: "none" };
	if (occurrence === undefined && matches.length > 1) return { status: "ambiguous", count: matches.length };
	if (occurrence !== undefined && (!Number.isSafeInteger(occurrence) || occurrence < 1 || occurrence > matches.length)) {
		return { status: "none" };
	}

	const matchIndex = matches[(occurrence ?? 1) - 1];
	const start = normalized.characters[matchIndex];
	const end = normalized.characters[matchIndex + needle.length - 1];
	if (!start || !end) return { status: "none" };
	return {
		status: "unique",
		startItem: start.item,
		startOffset: start.startOffset,
		endItem: end.item,
		endOffset: end.endOffset,
	};
}

/** Find a unique quote in the actual DOM text layer. */
export function findUniquePdfTextRange(root: Node, quote: string, occurrence?: number): PdfDomTextMatch {
	const match = occurrence === undefined
		? findUniqueTextRange(root, quote)
		: findTextRangeAtOccurrence(root, quote, occurrence);
	if (match.status === "unique") return match;
	return match;
}

/** Alias retained for callers that use "match" rather than "range" terminology. */
export const findUniquePdfTextMatch = findUniquePdfTextRange;

/**
 * Wrap the unique DOM match in marks. Ambiguous and missing quotes are left
 * untouched so the viewer can show an explicit extracted-text fallback.
 */
export function highlightPdfText(root: Node, quote: string, occurrence?: number): PdfDomTextMatch & { marks?: HTMLElement[] } {
	const match = findUniquePdfTextRange(root, quote, occurrence);
	if (match.status !== "unique") return match;
	const marks = highlightTextRange(match.range);
	for (const mark of marks) {
		mark.dataset.pdfEvidenceHighlight = "true";
		mark.classList.add("pdf-evidence-highlight");
	}
	return { ...match, marks };
}

export function clearPdfTextHighlights(root: ParentNode): void {
	clearTextHighlights(root);
	for (const mark of root.querySelectorAll("mark[data-pdf-evidence-highlight]")) {
		const parent = mark.parentNode;
		if (!parent) continue;
		while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
		mark.remove();
		parent.normalize();
	}
}

// Keep this import in the public module for consumers that only need the
// string-level result and should not depend on DOM types at runtime.
export type { UniqueTextOffsetsResult };
export { findUniqueTextOffsets };
