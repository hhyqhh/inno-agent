import { highlightTextRange, preferredScrollBehavior } from "./source-viewer/text-highlight.js";

export type SummaryCitationSentenceResult =
	| {
		status: "located";
		anchor: HTMLAnchorElement;
		block: HTMLElement;
		range: Range;
	}
	| { status: "not-found" | "ambiguous" };

const SEMANTIC_BLOCK_SELECTOR = "p, li, td, th";
const SENTENCE_BOUNDARY = /[\u3002\uff01\uff1f\uff1b.!?;]/u;
const IGNORED_TEXT_SELECTOR = "script, style, noscript, template, [hidden], [aria-hidden='true']";

interface TextSpan {
	node: Text;
	start: number;
	end: number;
}

interface DomPoint {
	node: Text;
	offset: number;
}

function markerHref(marker: number): string {
	return `#evidence-${marker}`;
}

function isValidMarker(marker: number): boolean {
	return Number.isSafeInteger(marker) && marker > 0;
}

function markerAnchors(root: ParentNode, marker: number): HTMLAnchorElement[] {
	if (!isValidMarker(marker)) return [];
	const href = markerHref(marker);
	return Array.from(root.querySelectorAll<HTMLAnchorElement>("a")).filter((anchor) => (
		anchor.getAttribute("href") === href
	));
}

function semanticBlock(anchor: HTMLAnchorElement, root: ParentNode): HTMLElement | undefined {
	const candidate = anchor.closest<HTMLElement>(SEMANTIC_BLOCK_SELECTOR);
	if (candidate && (root === candidate || root.contains(candidate))) return candidate;
	if (root instanceof HTMLElement && root.matches(SEMANTIC_BLOCK_SELECTOR) && root.contains(anchor)) return root;
	return undefined;
}

function textSpans(block: HTMLElement): { text: string; spans: TextSpan[] } {
	const spans: TextSpan[] = [];
	let text = "";
	const walker = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
		acceptNode(node) {
			const parent = (node as Text).parentElement;
			if (parent?.closest(IGNORED_TEXT_SELECTOR)) return NodeFilter.FILTER_REJECT;
			return NodeFilter.FILTER_ACCEPT;
		},
	});
	let current = walker.nextNode();
	while (current) {
		const node = current as Text;
		if (node.data.length > 0) {
			const start = text.length;
			text += node.data;
			spans.push({ node, start, end: text.length });
		}
		current = walker.nextNode();
	}
	return { text, spans };
}

function pointAt(spans: readonly TextSpan[], offset: number, endPoint: boolean): DomPoint | undefined {
	if (spans.length === 0) return undefined;
	for (const span of spans) {
		if (offset < span.end || (endPoint && offset === span.end)) {
			return { node: span.node, offset: Math.max(0, Math.min(span.node.length, offset - span.start)) };
		}
		if (!endPoint && offset === span.end) continue;
	}
	const last = spans[spans.length - 1];
	if (offset === last.end) return { node: last.node, offset: last.node.length };
	return undefined;
}

function rangeOffsets(block: HTMLElement, anchor: HTMLAnchorElement, spans: readonly TextSpan[]): { start: number; end: number } | undefined {
	const document = block.ownerDocument;
	const prefix = document.createRange();
	try {
		prefix.setStart(block, 0);
		prefix.setEndBefore(anchor);
		const start = prefix.toString().length;
		return { start, end: start + anchor.textContent.length };
	} catch {
		const anchorText = anchor.textContent;
		if (!anchorText) return undefined;
		const span = spans.find(({ node }) => anchor.contains(node));
		if (!span) return undefined;
		return { start: span.start, end: span.start + anchorText.length };
	}
}

function sentenceBounds(text: string, anchorStart: number, anchorEnd: number): { start: number; end: number } {
	let precedingContent = anchorStart - 1;
	while (precedingContent >= 0 && /\s/u.test(text[precedingContent] ?? "")) precedingContent -= 1;
	const followsSentenceBoundary = precedingContent >= 0 && SENTENCE_BOUNDARY.test(text[precedingContent]);

	let start = 0;
	const backwardFrom = followsSentenceBoundary ? precedingContent - 1 : anchorStart - 1;
	for (let index = Math.max(0, backwardFrom); index >= 0; index -= 1) {
		if (SENTENCE_BOUNDARY.test(text[index])) {
			start = index + 1;
			break;
		}
	}
	while (start < anchorStart && /\s/u.test(text[start] ?? "")) start += 1;

	if (followsSentenceBoundary) {
		let end = anchorEnd;
		while (end < text.length && SENTENCE_BOUNDARY.test(text[end])) end += 1;
		return { start, end };
	}

	let end = text.length;
	for (let index = anchorEnd; index < text.length; index += 1) {
		if (SENTENCE_BOUNDARY.test(text[index])) {
			end = index + 1;
			break;
		}
	}
	if (end === text.length) {
		while (end > anchorEnd && /\s/u.test(text[end - 1] ?? "")) end -= 1;
	}
	return { start, end };
}

function rangeForOffsets(block: HTMLElement, spans: readonly TextSpan[], start: number, end: number): Range | undefined {
	const startPoint = pointAt(spans, start, false);
	const endPoint = pointAt(spans, end, true);
	if (!startPoint || !endPoint) return undefined;
	const range = block.ownerDocument.createRange();
	range.setStart(startPoint.node, startPoint.offset);
	range.setEnd(endPoint.node, endPoint.offset);
	return range;
}

export function findCitationSentence(root: ParentNode, marker: number): SummaryCitationSentenceResult {
	const anchors = markerAnchors(root, marker);
	if (anchors.length === 0) return { status: "not-found" };
	if (anchors.length !== 1) return { status: "ambiguous" };

	const [anchor] = anchors;
	const block = semanticBlock(anchor, root);
	if (!block) return { status: "not-found" };
	const collected = textSpans(block);
	const offsets = rangeOffsets(block, anchor, collected.spans);
	if (!offsets) return { status: "not-found" };
	const bounds = sentenceBounds(collected.text, offsets.start, offsets.end);
	const range = rangeForOffsets(block, collected.spans, bounds.start, bounds.end);
	if (!range || range.collapsed) return { status: "not-found" };
	return { status: "located", anchor, block, range };
}

function clearMarksIn(root: ParentNode): void {
	const parents = new Set<Node>();
	for (const mark of root.querySelectorAll<HTMLElement>("mark[data-summary-citation-highlight]")) {
		const parent = mark.parentNode;
		if (!parent) continue;
		parents.add(parent);
		while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
		mark.remove();
	}
	for (const parent of parents) parent.normalize();
}

export function clearSummaryCitationHighlight(root: ParentNode): void {
	clearMarksIn(root);
}

export function highlightCitationSentence(result: Extract<SummaryCitationSentenceResult, { status: "located" }>): HTMLElement[] {
	clearMarksIn(result.block);
	const marks = highlightTextRange(result.range);
	for (const mark of marks) {
		delete mark.dataset.evidenceHighlight;
		mark.dataset.summaryCitationHighlight = "true";
	}
	const target = marks[0] ?? result.block;
	target.scrollIntoView?.({ block: "center", behavior: preferredScrollBehavior() });
	result.anchor.focus({ preventScroll: true });
	return marks;
}
