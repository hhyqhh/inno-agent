import { describe, expect, it } from "vitest";
import type { DocxEditorRef } from "@betteroffice/docx-react";
import type { YrsLoc, YrsSession } from "@betteroffice/docx/yrs";
import { resolveSelectionFont } from "./selection-font.js";

type Segment =
	| { kind: "text"; text: string; attributes: { fontFamily?: Record<string, string | null> } }
	| { kind: "pilcrow"; paraId: string; attributes: Record<string, never>; properties: Record<string, unknown> };

const TNR = { ascii: "Times New Roman", hAnsi: "Times New Roman", eastAsia: "宋体" };
const SONG = { ascii: "宋体", hAnsi: "宋体", eastAsia: "宋体" };
const LATIN_ONLY = { ascii: "Times New Roman", hAnsi: "Times New Roman", eastAsia: null };

function text(text: string, fontFamily?: Record<string, string | null>): Segment {
	return { kind: "text", text, attributes: fontFamily ? { fontFamily } : {} };
}
function pilcrow(paraId: string): Segment {
	return { kind: "pilcrow", paraId, attributes: {}, properties: {} };
}
interface SelectionTextInfo { paraId: string; selectedText: string; paragraphText: string; before: string; after: string }

interface Harness {
	editor: DocxEditorRef;
	session: {
		selection: (next?: { anchor: YrsLoc; head: YrsLoc }) => unknown;
		traversals: () => number;
	};
}

function harness(segments: Segment[], selection: { anchor: YrsLoc; head: YrsLoc } | null, texts: Record<string, SelectionTextInfo>): Harness {
	const storyText: string[] = [];
	for (const segment of segments) {
		if (segment.kind === "text") storyText.push(segment.text);
		else storyText.push("\n");
	}
	let current = selection;
	let traversals = 0;
	const session = {
		storiesChangedSince: () => ({ revision: 1, stories: [] as string[] }),
		storySegments: () => { traversals += 1; return segments; },
		selection: () => current,
		selectionText: () => {
			const key = `${current!.anchor.paraId}:${current!.anchor.offset}-${current!.head.paraId}:${current!.head.offset}`;
			return texts[key] ?? { paraId: current!.anchor.paraId, selectedText: "", paragraphText: storyText.join(""), before: "", after: "" };
		},
	};
	const editor = {
		getEditorRef: () => ({ getYrsSession: () => session }),
	} as unknown as DocxEditorRef;
	return {
		editor,
		session: {
			selection: (next?: { anchor: YrsLoc; head: YrsLoc }) => { if (next) current = next; return current; },
			traversals: () => traversals,
		},
	};
}
const loc = (paraId: string, offset: number): YrsLoc => ({ story: "body", paraId, offset });

describe("selection font resolution", () => {
	it("shows the east-Asian font while the caret sits on CJK text of a mixed run", () => {
		const h = harness(
			[text("中文English混排", TNR), pilcrow("body:p0")],
			{ anchor: loc("body:p0", 2), head: loc("body:p0", 2) },
			{ "body:p0:2-body:p0:2": { paraId: "body:p0", selectedText: "", paragraphText: "中文English混排", before: "中文", after: "English混排" } },
		);
		expect(resolveSelectionFont(h.editor)).toBe("宋体");
	});
	it("shows the Latin font while the caret sits on Latin text of a mixed run", () => {
		const h = harness(
			[text("中文English混排", TNR), pilcrow("body:p0")],
			{ anchor: loc("body:p0", 4), head: loc("body:p0", 4) },
			{ "body:p0:4-body:p0:4": { paraId: "body:p0", selectedText: "", paragraphText: "中文English混排", before: "中文En", after: "glish混排" } },
		);
		expect(resolveSelectionFont(h.editor)).toBe("Times New Roman");
	});
	it("follows the first character when the caret sits at the paragraph start", () => {
		const h = harness(
			[text("中文English", TNR), pilcrow("body:p0")],
			{ anchor: loc("body:p0", 0), head: loc("body:p0", 0) },
			{ "body:p0:0-body:p0:0": { paraId: "body:p0", selectedText: "", paragraphText: "中文English", before: "", after: "中文English" } },
		);
		expect(resolveSelectionFont(h.editor)).toBe("宋体");
	});
	it("keeps the Latin slot for runs without an east-Asian font", () => {
		const h = harness(
			[text("Hello", LATIN_ONLY), pilcrow("body:p0")],
			{ anchor: loc("body:p0", 3), head: loc("body:p0", 3) },
			{ "body:p0:3-body:p0:3": { paraId: "body:p0", selectedText: "", paragraphText: "Hello", before: "Hel", after: "lo" } },
		);
		expect(resolveSelectionFont(h.editor)).toBe("Times New Roman");
	});
	it("reports a uniform east-Asian selection as that font", () => {
		const h = harness(
			[text("中文宋体", SONG), text(" Mix", TNR), pilcrow("body:p0")],
			{ anchor: loc("body:p0", 0), head: loc("body:p0", 4) },
			{ "body:p0:0-body:p0:4": { paraId: "body:p0", selectedText: "中文宋体", paragraphText: "中文宋体 Mix", before: "", after: " Mix" } },
		);
		expect(resolveSelectionFont(h.editor)).toBe("宋体");
	});
	it("returns null when a selection mixes fonts, like Word's empty box", () => {
		const h = harness(
			[text("Hello World ", LATIN_ONLY), text("中文宋体", SONG), pilcrow("body:p0")],
			{ anchor: loc("body:p0", 0), head: loc("body:p0", 18) },
			{ "body:p0:0-body:p0:18": { paraId: "body:p0", selectedText: "Hello World 中文宋体", paragraphText: "Hello World 中文宋体", before: "", after: "" } },
		);
		expect(resolveSelectionFont(h.editor)).toBe(null);
	});
	it("spans paragraphs and reports mixed fonts across them", () => {
		const h = harness(
			[text("First", { ascii: "Arial", hAnsi: "Arial", eastAsia: null }), pilcrow("body:p0"), text("中文", SONG), pilcrow("body:p1")],
			{ anchor: loc("body:p0", 1), head: loc("body:p1", 2) },
			{ "body:p0:1-body:p1:2": { paraId: "body:p1", selectedText: "irst\n中文", paragraphText: "中文", before: "", after: "" } },
		);
		expect(resolveSelectionFont(h.editor)).toBe(null);
	});
	it("returns null without a session or selection", () => {
		expect(resolveSelectionFont(null)).toBe(null);
		const noSession = { getEditorRef: () => ({ getYrsSession: () => null }) } as unknown as DocxEditorRef;
		expect(resolveSelectionFont(noSession)).toBe(null);
		const noSelection = harness([text("中文", SONG), pilcrow("body:p0")], null, {});
		expect(resolveSelectionFont(noSelection.editor)).toBe(null);
	});
	it("reuses the segment traversal across caret moves on the same revision", () => {
		const h = harness(
			[text("中文English", TNR), pilcrow("body:p0")],
			{ anchor: loc("body:p0", 2), head: loc("body:p0", 2) },
			{
				"body:p0:2-body:p0:2": { paraId: "body:p0", selectedText: "", paragraphText: "中文English", before: "中文", after: "English" },
				"body:p0:4-body:p0:4": { paraId: "body:p0", selectedText: "", paragraphText: "中文English", before: "中文En", after: "glish" },
			},
		);
		expect(resolveSelectionFont(h.editor)).toBe("宋体");
		const afterFirst = h.session.traversals();
		h.session.selection({ anchor: loc("body:p0", 4), head: loc("body:p0", 4) });
		expect(resolveSelectionFont(h.editor)).toBe("Times New Roman");
		expect(h.session.traversals()).toBe(afterFirst);
	});
});
