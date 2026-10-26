import type { DocxEditorRef } from "@betteroffice/docx-react";
import type { YrsLoc, YrsSession, YrsStoryRange } from "@betteroffice/docx/yrs";

/**
 * Word's font box shows the east-Asian font while the caret sits on a CJK
 * character and the Latin font on a Latin character. BetterOffice's command
 * state reports only one flattened slot (`ascii ?? hAnsi`; the React layer
 * never sees `eastAsia`), so a run with `w:rFonts ascii="Times New Roman"
 * eastAsia="宋体"` — the standard Chinese body layout — always displays as
 * Times New Roman even though the file keeps both fonts. This module derives
 * the display font from the live Yrs session, whose segment view keeps every
 * rFonts slot, and returns `null` whenever it cannot (caller falls back to the
 * engine's flattened value).
 */

type FontSlots = { ascii?: string | null; hAnsi?: string | null; eastAsia?: string | null };

// CJK ideographs and extensions, kana, hangul, CJK punctuation and fullwidth forms.
const CJK_PATTERN = /[\u1100-\u11FF\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]/;

function isCjkChar(text: string, index: number): boolean {
	return CJK_PATTERN.test(text[index]);
}

function fontForScript(slots: FontSlots, cjk: boolean): string | null {
	if (cjk) return slots.eastAsia ?? slots.ascii ?? slots.hAnsi ?? null;
	return slots.ascii ?? slots.hAnsi ?? slots.eastAsia ?? null;
}

interface RunSegment {
	text: string;
	font: FontSlots;
}

// storySegments is a full Rust story traversal; cache it per session revision
// so plain caret moves do not re-walk the document.
const segmentCache = new WeakMap<YrsSession, { revision: number; paragraphs: Map<string, RunSegment[]> }>();

function segmentFont(attributes: Record<string, unknown>): FontSlots | null {
	const font = attributes.fontFamily;
	if (!font || typeof font !== "object") return null;
	const slots = font as FontSlots;
	return slots.ascii || slots.hAnsi || slots.eastAsia ? slots : null;
}

function paragraphRunMap(session: YrsSession, story: string): Map<string, RunSegment[]> | null {
	let revision: number;
	try {
		revision = session.storiesChangedSince(0).revision;
	} catch {
		return null;
	}
	const cached = segmentCache.get(session);
	if (cached && cached.revision === revision) return cached.paragraphs;
	let segments: ReturnType<YrsSession["storySegments"]>;
	try {
		segments = session.storySegments(story);
	} catch {
		return null;
	}
	// The pilcrow segment closes its paragraph: text segments preceding a
	// pilcrow belong to that pilcrow's paraId, not to the following one.
	const paragraphs = new Map<string, RunSegment[]>();
	let pending: RunSegment[] = [];
	for (const segment of segments) {
		if (segment.kind === "pilcrow") {
			paragraphs.set(segment.paraId, pending);
			pending = [];
		} else if (segment.kind === "text" && segment.text) {
			const font = segmentFont(segment.attributes);
			if (font) pending.push({ text: segment.text, font });
		}
	}
	segmentCache.set(session, { revision, paragraphs });
	return paragraphs;
}

/** Segment font covering the paragraph-local character `index`, or null. */
function fontAt(paragraph: RunSegment[] | undefined, index: number): FontSlots | null {
	if (!paragraph) return null;
	let start = 0;
	for (const run of paragraph) {
		const end = start + run.text.length;
		if (index >= start && index < end) return run.font;
		start = end;
	}
	return null;
}

function orderedParagraphIds(paragraphs: Map<string, RunSegment[]>): string[] {
	return [...paragraphs.keys()];
}

/** Effective display fonts over one clipped character range, `null` when mixed. */
function uniformFont(paragraph: RunSegment[] | undefined, from: number, to: number): string | null | undefined {
	if (!paragraph) return undefined;
	let start = 0;
	let uniform: string | null | undefined;
	for (const run of paragraph) {
		const end = start + run.text.length;
		const runFrom = Math.max(from, start);
		const runTo = Math.min(to, end);
		for (let index = runFrom; index < runTo; index += 1) {
			if (/\s/.test(run.text[index])) continue; // whitespace carries either slot; neutral
			const value = fontForScript(run.font, isCjkChar(run.text, index));
			if (value === null || value === undefined) continue;
			if (uniform === undefined || uniform === null) uniform = value;
			else if (uniform.toLocaleLowerCase() !== value.toLocaleLowerCase()) return null;
		}
		start = end;
		if (start >= to) break;
	}
	return uniform;
}

function orderedRange(a: YrsLoc, b: YrsLoc): { start: YrsLoc; end: YrsLoc; caret: boolean } {
	if (a.paraId === b.paraId) {
		return a.offset <= b.offset ? { start: a, end: b, caret: a.offset === b.offset } : { start: b, end: a, caret: false };
	}
	// Distinct paragraphs: the anchor is where the selection started.
	return { start: a, end: b, caret: false };
}

/**
 * The script-aware font name for the current selection, or `null` when the
 * session is unavailable or the selection mixes fonts (Word shows an empty box).
 */
export function resolveSelectionFont(editor: DocxEditorRef | null | undefined): string | null {
	const session = editor?.getEditorRef?.()?.getYrsSession() ?? null;
	if (!session) return null;
	const selection = session.selection();
	if (!selection) return null;
	const anchor = selection.anchor;
	const head = selection.head;
	if (anchor.story !== head.story) return null;
	const story = anchor.story;
	const paragraphs = paragraphRunMap(session, story);
	if (!paragraphs) return null;
	const { start, end, caret } = orderedRange(anchor, head);
	const range: YrsStoryRange = { story, start, end };
	let text: ReturnType<YrsSession["selectionText"]>;
	try {
		text = session.selectionText(range);
	} catch {
		return null;
	}
	if (caret) {
		// Word's box follows the character before the caret; at paragraph start
		// it follows the first character instead.
		const paragraphText = text.paragraphText;
		if (!paragraphText) return null;
		let index = start.offset - 1;
		if (index < 0) index = 0;
		if (index >= paragraphText.length) index = paragraphText.length - 1;
		const font = fontAt(paragraphs.get(start.paraId), index);
		if (!font) return null;
		return fontForScript(font, isCjkChar(paragraphText, index));
	}
	const ids = orderedParagraphIds(paragraphs);
	const startIndex = ids.indexOf(start.paraId);
	const endIndex = ids.indexOf(end.paraId);
	if (startIndex < 0 || endIndex < 0 || endIndex < startIndex) return null;
	let uniform: string | null | undefined;
	for (let i = startIndex; i <= endIndex && uniform !== null; i += 1) {
		const id = ids[i];
		const from = i === startIndex ? start.offset : 0;
		const to = i === endIndex ? end.offset : Number.MAX_SAFE_INTEGER;
		const value = uniformFont(paragraphs.get(id), from, to);
		if (value === null) return null; // mixed fonts
		if (value === undefined) continue; // paragraph unreadable; skip
		if (uniform === undefined || uniform === null) uniform = value;
		else if (uniform.toLocaleLowerCase() !== value.toLocaleLowerCase()) return null;
	}
	return uniform ?? null;
}
