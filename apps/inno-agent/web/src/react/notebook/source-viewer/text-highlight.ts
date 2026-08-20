export type UniqueTextOffsetsResult =
	| { status: "none" }
	| { status: "ambiguous"; count: number }
	| { status: "unique"; start: number; end: number };

export type UniqueTextRangeResult =
	| { status: "none" }
	| { status: "ambiguous"; count: number }
	| { status: "unique"; range: Range };

export function preferredScrollBehavior(): ScrollBehavior {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "smooth";
	return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

interface NormalizedText {
	text: string;
	starts: number[];
	ends: number[];
}

interface TextNodeSpan {
	node: Text;
	start: number;
	end: number;
}

interface DomPoint {
	node: Text;
	offset: number;
}

interface VirtualSpan {
	start: number;
	end: number;
	before: DomPoint;
	after: DomPoint;
}

const IGNORED_TEXT_ANCESTORS = "script, style, noscript, template, [hidden], [aria-hidden='true'], [data-evidence-ignore]";

function documentFor(node: Node): Document {
	if (node.nodeType === 9) return node as Document;
	if (node.ownerDocument !== null) return node.ownerDocument;
	throw new TypeError("Evidence text must belong to a document.");
}

function normalizeWithOffsets(value: string): NormalizedText {
	const text: string[] = [];
	const starts: number[] = [];
	const ends: number[] = [];
	const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

	for (const part of segmenter.segment(value)) {
		const segmentStart = part.index;
		const segmentEnd = segmentStart + part.segment.length;
		if (/^\s+$/u.test(part.segment)) {
			if (text.at(-1) === " ") {
				ends[ends.length - 1] = segmentEnd;
			} else {
				text.push(" ");
				starts.push(segmentStart);
				ends.push(segmentEnd);
			}
			continue;
		}

		const normalized = part.segment.normalize("NFC");
		for (let offset = 0; offset < normalized.length; offset += 1) {
			text.push(normalized[offset]);
			starts.push(segmentStart);
			ends.push(segmentEnd);
		}
	}

	return { text: text.join(""), starts, ends };
}

function normalizedNeedle(value: string): string {
	return normalizeWithOffsets(value).text.trim();
}

function matchText(normalized: NormalizedText, quote: string, occurrence?: number): UniqueTextOffsetsResult {
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
	const matchStart = matches[(occurrence ?? 1) - 1];
	const matchEnd = matchStart + needle.length - 1;
	return {
		status: "unique",
		start: normalized.starts[matchStart],
		end: normalized.ends[matchEnd],
	};
}

export function findUniqueTextOffsets(text: string, quote: string): UniqueTextOffsetsResult {
	return matchText(normalizeWithOffsets(text), quote);
}

/** Return the requested 1-based occurrence, even when the quote repeats. */
export function findTextOffsetsAtOccurrence(text: string, quote: string, occurrence: number): UniqueTextOffsetsResult {
	return matchText(normalizeWithOffsets(text), quote, occurrence);
}

function ignoredTextNode(node: Text, root: Node): boolean {
	const parent = node.parentElement;
	if (parent === null) return false;
	const ignored = parent.closest(IGNORED_TEXT_ANCESTORS);
	return ignored !== null && ignored !== root && root.contains(ignored);
}

const BLOCK_TAGS = new Set([
	"ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DIV", "DL", "FIELDSET", "FIGCAPTION", "FIGURE",
	"FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN",
	"NAV", "OL", "P", "PRE", "SECTION", "TABLE", "TD", "TH", "TR", "UL",
]);

function nearestBlock(node: Text, root: Node): Element | Node {
	let current: Node | null = node.parentElement;
	while (current !== null && current !== root) {
		if (current.nodeType === 1 && BLOCK_TAGS.has((current as Element).tagName)) return current;
		current = current.parentNode;
	}
	return root;
}

function hasBreakBetween(previous: Text, next: Text, root: Node, document: Document): boolean {
	if (nearestBlock(previous, root) !== nearestBlock(next, root)) return true;
	const range = document.createRange();
	try {
		range.setStart(previous, previous.length);
		range.setEnd(next, 0);
		if (!("querySelectorAll" in root)) return false;
		return Array.from((root as ParentNode).querySelectorAll("br"))
			.some((breakNode) => range.intersectsNode(breakNode));
	} catch {
		return false;
	}
}

function collectText(root: Node): { normalized: NormalizedText; spans: TextNodeSpan[]; virtualSpans: VirtualSpan[] } {
	const document = documentFor(root);
	const spans: TextNodeSpan[] = [];
	const virtualSpans: VirtualSpan[] = [];
	let raw = "";
	if (root.nodeType === 3) {
		const node = root as Text;
		raw = node.data;
		spans.push({ node, start: 0, end: raw.length });
	} else {
		const walker = document.createTreeWalker(root, 4, {
			acceptNode(candidate) {
				return ignoredTextNode(candidate as Text, root) ? 2 : 1;
			},
		});
		let previous: Text | undefined;
		let candidate = walker.nextNode();
		while (candidate !== null) {
			const node = candidate as Text;
			if (node.data.length === 0) {
				candidate = walker.nextNode();
				continue;
			}
			if (previous && hasBreakBetween(previous, node, root, document)) {
				const separatorStart = raw.length;
				raw += "\n";
				virtualSpans.push({
					start: separatorStart,
					end: raw.length,
					before: { node: previous, offset: previous.length },
					after: { node, offset: 0 },
				});
			}
			const start = raw.length;
			raw += node.data;
			spans.push({ node, start, end: raw.length });
			previous = node;
			candidate = walker.nextNode();
		}
	}
	return { normalized: normalizeWithOffsets(raw), spans, virtualSpans };
}

function startPoint(
	spans: readonly TextNodeSpan[],
	virtualSpans: readonly VirtualSpan[],
	offset: number,
): { node: Text; offset: number } | undefined {
	for (const span of virtualSpans) {
		if (offset >= span.start && offset < span.end) return span.after;
	}
	for (const span of spans) {
		if (offset >= span.start && offset < span.end) {
			return { node: span.node, offset: offset - span.start };
		}
	}
	const last = spans.at(-1);
	if (last && offset === last.end) return { node: last.node, offset: last.node.length };
	return undefined;
}

function endPoint(
	spans: readonly TextNodeSpan[],
	virtualSpans: readonly VirtualSpan[],
	offset: number,
): { node: Text; offset: number } | undefined {
	for (const span of virtualSpans) {
		if (offset > span.start && offset <= span.end) return span.before;
	}
	for (const span of spans) {
		if (offset > span.start && offset <= span.end) {
			return { node: span.node, offset: offset - span.start };
		}
	}
	const first = spans[0];
	if (first && offset === 0) return { node: first.node, offset: 0 };
	return undefined;
}

export function findUniqueTextRange(root: Node, quote: string): UniqueTextRangeResult {
	const collected = collectText(root);
	const match = matchText(collected.normalized, quote);
	return rangeFromMatch(root, collected, match);
}

/** Map a requested 1-based occurrence to a DOM range. */
export function findTextRangeAtOccurrence(root: Node, quote: string, occurrence: number): UniqueTextRangeResult {
	const collected = collectText(root);
	return rangeFromMatch(root, collected, matchText(collected.normalized, quote, occurrence));
}

function rangeFromMatch(root: Node, collected: ReturnType<typeof collectText>, match: UniqueTextOffsetsResult): UniqueTextRangeResult {
	if (match.status !== "unique") return match;
	const start = startPoint(collected.spans, collected.virtualSpans, match.start);
	const end = endPoint(collected.spans, collected.virtualSpans, match.end);
	if (!start || !end) return { status: "none" };
	const range = documentFor(root).createRange();
	range.setStart(start.node, start.offset);
	range.setEnd(end.node, end.offset);
	return { status: "unique", range };
}

export function highlightTextRange(range: Range): HTMLElement[] {
	const root = range.commonAncestorContainer.nodeType === 3
		? range.commonAncestorContainer.parentNode
		: range.commonAncestorContainer;
	if (root === null) return [];
	const document = documentFor(range.startContainer);
	const walker = document.createTreeWalker(root, 4);
	const segments: Array<{ node: Text; start: number; end: number }> = [];
	let candidate = root.nodeType === 3 ? root : walker.nextNode();
	while (candidate !== null) {
		if (candidate.nodeType === 3 && range.intersectsNode(candidate)) {
			const node = candidate as Text;
			const start = node === range.startContainer ? range.startOffset : 0;
			const end = node === range.endContainer ? range.endOffset : node.length;
			if (start < end) segments.push({ node, start, end });
		}
		candidate = walker.nextNode();
	}

	const marks: HTMLElement[] = [];
	for (const segment of segments.reverse()) {
		let selected = segment.node;
		if (segment.start > 0) selected = selected.splitText(segment.start);
		const selectedLength = segment.end - segment.start;
		if (selectedLength < selected.length) selected.splitText(selectedLength);
		const mark = document.createElement("mark");
		mark.dataset.evidenceHighlight = "true";
		selected.parentNode?.replaceChild(mark, selected);
		mark.append(selected);
		marks.unshift(mark);
	}
	return marks;
}

export function clearTextHighlights(root: ParentNode): void {
	const parents = new Set<Node>();
	for (const mark of root.querySelectorAll("mark[data-evidence-highlight]")) {
		const parent = mark.parentNode;
		if (parent === null) continue;
		parents.add(parent);
		while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
		mark.remove();
	}
	for (const parent of parents) parent.normalize();
}
