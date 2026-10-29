/**
 * DOCX ↔ Univer document snapshot conversion for the word editor.
 *
 * Univer's docx import/export is a Pro feature; this converter covers the
 * open-source subset we need, following the same pattern as univer-xlsx.ts.
 *
 * Two structural decisions drive the design (both verified against the live
 * engine in-browser):
 *
 * 1. Content reaches Univer through the engine's own facade commands
 *    (appendParagraph / setStyle / setTextRange), never through a prebuilt
 *    createUnit body — the full rendering pipeline rebuilds the body on load
 *    and drops imported text runs.
 * 2. Saving is a ZIP-level splice on the ORIGINAL docx, not a rebuild from
 *    scratch: only word/document.xml's body is regenerated; every other part
 *    (styles, numbering, headers/footers, footnotes, media, rels) stays
 *    byte-identical. Structures Univer cannot model — tables, images,
 *    equations, footnote references, headers/footers — are therefore
 *    PRESERVED across an edit round-trip: they are shown in the editor as
 *    read-only anchor paragraphs ("〔#kN〕…", flattened text) and their
 *    original XML is spliced back at those anchors on save. Deleting an
 *    anchor paragraph deletes the structure (user intent).
 *
 * Editable and round-tripped: paragraph text, line/soft breaks, tabs,
 * headings 1-5, alignment, paragraph spacing/indentation, numbered-list
 * membership (numPr survives via a custom paragraph-style field — the engine
 * spreads unknown style fields through its mutation pipeline, verified in
 * its createParagraphStyleTextX), and run styles (bold, italic, underline,
 * strikethrough, font family/size, color, super/subscript). NOT editable:
 * table cells, images, equations, headers/footers, footnotes (preserved
 * verbatim instead).
 */
import JSZip from "jszip";
import {
	AlignmentType,
	Document,
	LevelFormat,
	Packer,
	Paragraph as DocxParagraph,
	TextRun,
} from "docx";

const NS_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

/** Univer enum literals (kept local so the editor bundle needs no core import). */
const HAL_LEFT = 1;
const HAL_CENTER = 2;
const HAL_RIGHT = 3;
const HAL_JUSTIFIED = 4;
const NAMED_TITLE = 2;
const NAMED_HEADING_BASE = 4; // HEADING_1..HEADING_5 = 4..8

/** Anchor prefix marking a preserved (read-only) block in the editor text. */
const ANCHOR_RE = /^〔#(k\d+)〕/;

/** Paragraph-local names that Univer cannot model; a paragraph containing any
 * of them becomes a preserved anchor. Block-level w:tbl gets its own anchor. */
const UNMODELLED_RUN_CHILDREN = new Set(["drawing", "object", "pict", "oMath", "footnoteReference", "endnoteReference", "fldSimple", "sdt"]);

export interface UniverTextStyle {
	ff?: string | null;
	fs?: number;
	it?: number;
	bl?: number;
	ul?: { s: number };
	st?: { s: number };
	cl?: { rgb?: string | null };
	va?: "superscript" | "subscript";
}

export interface UniverParagraphStyle {
	horizontalAlign?: number;
	namedStyleType?: number;
	headingId?: string;
	lineSpacing?: number;
	spaceAbove?: { v: number; u?: number };
	spaceBelow?: { v: number; u?: number };
	indentStart?: { v: number; u?: number };
	indentEnd?: { v: number; u?: number };
	indentFirstLine?: { v: number; u?: number };
	hanging?: { v: number; u?: number };
	/** "numId:ilvl" — OOXML numbering membership, carried through the engine's
	 * transparent custom style fields and written back as w:numPr on save. */
	xNum?: string;
}

export interface UniverTextRun {
	st: number;
	ed: number;
	ts?: UniverTextStyle;
	/** Reference into the snapshot's styles registry; resolved on save. */
	sId?: string;
}

export interface UniverParagraph {
	startIndex: number;
	paragraphId: string;
	paragraphStyle?: UniverParagraphStyle;
	bullet?: { listType: string; listId?: string; nestingLevel?: number } | null;
}

export interface UniverDocSnapshot {
	id: string;
	title?: string;
	rev?: number;
	documentStyle?: Record<string, unknown>;
	body?: {
		dataStream: string;
		textRuns?: UniverTextRun[];
		paragraphs?: UniverParagraph[];
		sectionBreaks?: Array<{ sectionId: string; startIndex: number }>;
		customBlocks?: unknown[];
		tables?: Array<{ startIndex: number; endIndex: number; tableId: string }>;
	};
	tableSource?: Record<string, UniverTableSource>;
	styles?: Record<string, { name?: string; type?: number; textStyle?: UniverTextStyle; paragraphStyle?: UniverParagraphStyle }>;
}

/** twips (1/20 pt) → points. */
const twipsToPt = (twips: number) => twips / 20;
const ptToTwips = (pt: number) => Math.round(pt * 20);

function el(node: Element | null, localName: string): Element | null {
	return node?.getElementsByTagNameNS(NS_W, localName)[0] ?? null;
}

function attrNum(node: Element | null, name: string): number | null {
	const value = node?.getAttributeNS(NS_W, name) ?? node?.getAttribute(`w:${name}`);
	if (value == null || value.trim() === "") return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function attrText(node: Element | null, name: string): string | null {
	return node?.getAttributeNS(NS_W, name) ?? node?.getAttribute(`w:${name}`) ?? null;
}

function runStyleFromRPr(rPr: Element | null): UniverTextStyle {
	const ts: UniverTextStyle = {};
	if (!rPr) return ts;
	if (el(rPr, "b")) ts.bl = 1;
	if (el(rPr, "i")) ts.it = 1;
	if (el(rPr, "u")) ts.ul = { s: 1 };
	if (el(rPr, "strike")) ts.st = { s: 1 };
	const sz = attrNum(el(rPr, "sz"), "val");
	if (sz != null) ts.fs = sz / 2; // half-points → pt
	const color = attrText(el(rPr, "color"), "val");
	if (color && /^[0-9A-Fa-f]{6}$/.test(color)) ts.cl = { rgb: `#${color.toUpperCase()}` };
	const fonts = el(rPr, "rFonts");
	const family = fonts ? (attrText(fonts, "eastAsia") ?? attrText(fonts, "ascii") ?? attrText(fonts, "hAnsi")) : null;
	if (family) ts.ff = family;
	const vertAlign = attrText(el(rPr, "vertAlign"), "val");
	if (vertAlign === "superscript") ts.va = "superscript";
	else if (vertAlign === "subscript") ts.va = "subscript";
	return ts;
}

function paragraphStyleFromPPr(pPr: Element | null): UniverParagraphStyle {
	const style: UniverParagraphStyle = {};
	if (!pPr) return style;
	const jc = attrText(el(pPr, "jc"), "val");
	if (jc === "left" || jc === "start") style.horizontalAlign = HAL_LEFT;
	else if (jc === "center") style.horizontalAlign = HAL_CENTER;
	else if (jc === "right" || jc === "end") style.horizontalAlign = HAL_RIGHT;
	else if (jc === "both" || jc === "distribute") style.horizontalAlign = HAL_JUSTIFIED;
	const spacing = el(pPr, "spacing");
	if (spacing) {
		const before = attrNum(spacing, "before");
		if (before != null) style.spaceAbove = { v: twipsToPt(before), u: 0 };
		const after = attrNum(spacing, "after");
		if (after != null) style.spaceBelow = { v: twipsToPt(after), u: 0 };
		const line = attrNum(spacing, "line");
		if (line != null) style.lineSpacing = line / 240; // 240 twips = single line
	}
	const ind = el(pPr, "ind");
	if (ind) {
		const firstLine = attrNum(ind, "firstLine");
		if (firstLine != null) style.indentFirstLine = { v: twipsToPt(firstLine), u: 0 };
		const hanging = attrNum(ind, "hanging");
		if (hanging != null) style.hanging = { v: twipsToPt(hanging), u: 0 };
		const left = attrNum(ind, "left") ?? attrNum(ind, "start");
		if (left != null) style.indentStart = { v: twipsToPt(left), u: 0 };
		const right = attrNum(ind, "right") ?? attrNum(ind, "end");
		if (right != null) style.indentEnd = { v: twipsToPt(right), u: 0 };
	}
	const pStyle = attrText(el(pPr, "pStyle"), "val");
	if (pStyle) {
		const heading = /^Heading(\d)$/i.exec(pStyle);
		if (heading) style.namedStyleType = NAMED_HEADING_BASE + (Number(heading[1]) - 1);
		else if (pStyle === "Title") style.namedStyleType = NAMED_TITLE;
	}
	const numPr = el(pPr, "numPr");
	if (numPr) {
		const numId = attrNum(el(numPr, "numId"), "val");
		const ilvl = attrNum(el(numPr, "ilvl"), "val") ?? 0;
		if (numId != null) style.xNum = `${numId}:${ilvl}`;
	}
	return style;
}

/** Flattens a table to visible text for the anchor paragraph. Rows join with
 * " | " — never "\n": the engine splits imported "\n" into separate
 * paragraphs, which would break the 1:1 anchor-paragraph ↔ XML-block mapping
 * and leak flattened rows into the saved body (verified live: each save added
 * another stray copy of the row text). */
function tableFlatText(tbl: Element): string {
	return Array.from(tbl.getElementsByTagNameNS(NS_W, "tr"))
		.map((tr) => Array.from(tr.getElementsByTagNameNS(NS_W, "tc"))
			.map((tc) => Array.from(tc.getElementsByTagNameNS(NS_W, "t")).map((t) => t.textContent ?? "").join(""))
			.join("\t"))
		.join(" | ");
}

function paragraphHasUnmodelledContent(para: Element): boolean {
	// Check direct runs and hyperlink runs (top-level content of this story);
	// deeply nested structures (e.g. textbox content inside a drawing) do not
	// make the paragraph itself unmodelled when the drawing already does.
	const runs = Array.from(para.getElementsByTagNameNS(NS_W, "r"));
	for (const run of runs) {
		for (const child of Array.from(run.children)) {
			if (UNMODELLED_RUN_CHILDREN.has(child.localName ?? "")) return true;
		}
	}
	if (para.getElementsByTagNameNS(NS_W, "oMathPara").length) return true;
	return false;
}

export interface DocxRunInput {
	text: string;
	ts?: UniverTextStyle;
}

export interface UniverTableCellSource {
	margin?: { start?: { v: number }; end?: { v: number }; top?: { v: number }; bottom?: { v: number } };
	rowSpan?: number;
	columnSpan?: number;
}

export interface UniverTableSource {
	tableId: string;
	tableRows: Array<{ tableCells: UniverTableCellSource[]; trHeight?: { val: { v: number }; hRule?: number } }>;
	tableColumns: Array<{ size: { type: number; width: { v: number } } }>;
	align?: number;
	indent?: { v: number };
	textWrap?: number;
}

export interface DocxImportBody {
	dataStream: string;
	paragraphs: UniverParagraph[];
	sectionBreaks: Array<{ sectionId: string; startIndex: number }>;
	tables: Array<{ startIndex: number; endIndex: number; tableId: string }>;
	tableSource: Record<string, UniverTableSource>;
	/** Globally-offset styled runs for the facade pass (UniverTextStyle per range). */
	styledRuns: Array<{ st: number; ed: number; ts: UniverTextStyle }>;
}

/** Engine stream control tokens (DataStreamTreeTokenType literals, kept inline
 * so this module stays free of a @univerjs import). */
const TOK = {
	TABLE_START: "\u001A",
	ROW_START: "\u001B",
	CELL_START: "\u001C",
	CELL_END: "\u001D",
	ROW_END: "\u000E",
	TABLE_END: "\u000F",
};

/**
 * Parse a docx into an engine body for the Univer docs editor.
 *
 * Tables become REAL engine tables (stream tokens + tableSource), so they show
 * as editable tables in the editor page — not placeholders. Paragraph styles
 * ride inside the body (the engine keeps them through createUnit); run styles
 * cannot (the full pipeline rebuilds the body and drops imported textRuns,
 * verified in-browser), so they are returned as `styledRuns` and applied via
 * the facade (getTextRange().setTextStyle), which rides the same mutation path
 * as user edits.
 *
 * Structures still unmodelled by the open-source preset (images, equations,
 * footnote references) become read-only anchor paragraphs ("〔#kN〕…") and are
 * spliced back verbatim at save time.
 */
export async function docxBytesToDocument(bytes: ArrayBuffer | Uint8Array): Promise<DocxImportBody> {
	const zip = JSZip();
	await zip.loadAsync(bytes);
	const documentXml = await zip.file("word/document.xml")?.async("string");
	if (!documentXml) throw new Error("Not a docx file (missing word/document.xml)");
	const dom = new DOMParser().parseFromString(documentXml, "application/xml");
	if (dom.getElementsByTagName("parsererror").length) throw new Error("Corrupt document.xml");
	const bodyEl = dom.getElementsByTagNameNS(NS_W, "body")[0];
	if (!bodyEl) throw new Error("Empty docx body");

	const out: DocxImportBody = { dataStream: "", paragraphs: [], sectionBreaks: [], tables: [], tableSource: {}, styledRuns: [] };

	const appendText = (text: string, ts: UniverTextStyle | null) => {
		if (!text) return;
		const st = out.dataStream.length;
		out.dataStream += text;
		if (ts && Object.keys(ts).length) out.styledRuns.push({ st, ed: out.dataStream.length, ts });
	};

	const pushParagraphFromXml = (para: Element) => {
		const startIndex = out.dataStream.length;
		// Inline runs only (direct children and runs inside w:hyperlink).
		const direct = Array.from(para.children).flatMap((child) => {
			if (child.localName === "r") return [child];
			if (child.localName === "hyperlink") return Array.from(child.children).filter((c) => c.localName === "r");
			return [];
		});
		for (const run of direct) {
			const ts = runStyleFromRPr(el(run, "rPr"));
			for (const node of Array.from(run.children)) {
				if (node.localName === "t") appendText(node.textContent ?? "", ts);
				else if (node.localName === "tab") appendText("\t", ts);
				else if (node.localName === "br") appendText("\n", ts);
			}
		}
		// The paragraph's trailing "\r"; paragraphs[].startIndex points at it.
		out.dataStream += "\r";
		out.paragraphs.push({ startIndex: out.dataStream.length - 1, paragraphId: `p-${out.paragraphs.length}`, paragraphStyle: paragraphStyleFromPPr(el(para, "pPr")) });
	};

	// --- Table conversion: OOXML grid semantics → engine grid semantics ---
	const cellWidthPt = (tc: Element): number | null => {
		const tcW = el(tc, "tcW");
		const type = attrText(tcW, "type");
		const w = attrNum(tcW, "w");
		if (w == null) return null;
		if (type === "dxa") return twipsToPt(w);
		if (type === "pct") return null; // relative widths fall back to even split
		return null;
	};

	const pushTable = (tbl: Element) => {
		const trs = Array.from(tbl.children).filter((c) => c.localName === "tr");
		if (!trs.length) {
			trs.push(...Array.from(tbl.getElementsByTagNameNS(NS_W, "tr")));
		}
		// OOXML tables are physical: every row's w:tc list covers the full grid
		// (gridSpan widens a cell, vMerge continuations are explicit cells).
		// Engine tables are logical: one entry per column, covered slots carry
		// {rowSpan:0, columnSpan:0}. Convert row by row.
		type EngineCell = { covered: boolean; rowSpan: number; columnSpan: number; tc: Element | null; width: number | null };
		const grid: EngineCell[][] = [];
		const columnWidths: number[] = [];
		const physRows: Element[][] = trs.map((tr) => Array.from(tr.children).filter((c) => c.localName === "tc"));
		for (let r = 0; r < physRows.length; r++) {
			const rowCells: EngineCell[] = [];
			const prChild = (tc2: Element, name: string): Element | null => el(el(tc2, "tcPr"), name);
			for (const tc of physRows[r]) {
				const tcPr = el(tc, "tcPr");
				const gridSpan = Math.max(1, attrNum(el(tcPr, "gridSpan"), "val") ?? 1);
				const vMergeEl = el(tcPr, "vMerge");
				const vMerge = vMergeEl ? (attrText(vMergeEl, "val") ?? "continue") : null;
				const width = cellWidthPt(tc);
				let rowSpan = 1;
				if (vMerge === "restart") {
					rowSpan = 1;
					for (let below = r + 1; below < physRows.length; below++) {
						// Find the physical cell in the below row that starts at
						// the same grid column: walk that row's cells tracking spans.
						let col = 0;
						let target: Element | null = null;
						const myCol = (() => {
							let c2 = 0;
							for (const t2 of physRows[r]) {
								if (t2 === tc) return c2;
								c2 += Math.max(1, attrNum(prChild(t2, "gridSpan"), "val") ?? 1);
							}
							return -1;
						})();
						for (const btc of physRows[below]) {
							const bgs = Math.max(1, attrNum(prChild(btc, "gridSpan"), "val") ?? 1);
							if (col === myCol) { target = btc; break; }
							col += bgs;
						}
						const tvm = target ? prChild(target, "vMerge") : null;
						const tval = tvm ? (attrText(tvm, "val") ?? "continue") : null;
						if (target && tval === "continue") rowSpan += 1;
						else break;
					}
				}
				for (let k = 0; k < gridSpan; k++) {
					if (vMerge === "continue") {
						rowCells.push({ covered: true, rowSpan: 0, columnSpan: 0, tc: null, width: null });
					} else if (k === 0) {
						rowCells.push({ covered: false, rowSpan, columnSpan: gridSpan, tc, width });
						if (width != null) columnWidths[rowCells.length - 1] = width;
					} else {
						rowCells.push({ covered: true, rowSpan: 0, columnSpan: 0, tc: null, width: null });
					}
				}
			}
			grid.push(rowCells);
		}
		const columnCount = Math.max(1, ...grid.map((r) => r.length));

		const tableId = `t-${Object.keys(out.tableSource).length}`;
		const tableSource: UniverTableSource = {
			tableId,
			tableRows: grid.map((rowCells) => ({
				tableCells: rowCells.map((cell) => ({
					margin: { start: { v: 5 }, end: { v: 5 }, top: { v: 2 }, bottom: { v: 2 } },
					...(cell.covered ? { rowSpan: 0, columnSpan: 0 } : cell.rowSpan > 1 || cell.columnSpan > 1 ? { rowSpan: cell.rowSpan, columnSpan: cell.columnSpan } : {}),
				})),
			})),
			tableColumns: Array.from({ length: columnCount }, (_, i) => ({ size: { type: 1, width: { v: columnWidths[i] ?? 80 } } })),
			align: 0,
			indent: { v: 0 },
			textWrap: 0,
		};
		out.tableSource[tableId] = tableSource;

		const startIndex = out.dataStream.length;
		out.dataStream += TOK.TABLE_START;
		for (const rowCells of grid) {
			out.dataStream += TOK.ROW_START;
			for (const cell of rowCells) {
				out.dataStream += TOK.CELL_START;
				if (cell.tc && !cell.covered) {
					// Cell paragraphs; each ends with a "\r" paragraph sentinel.
					const cellParas = Array.from(cell.tc.children).filter((c) => c.localName === "p");
					for (const cp of cellParas) {
						const direct = Array.from(cp.children).flatMap((child) => {
							if (child.localName === "r") return [child];
							if (child.localName === "hyperlink") return Array.from(child.children).filter((c) => c.localName === "r");
							return [];
						});
						for (const run of direct) {
							const ts = runStyleFromRPr(el(run, "rPr"));
							for (const node of Array.from(run.children)) {
								if (node.localName === "t") appendText(node.textContent ?? "", ts);
								else if (node.localName === "tab") appendText("\t", ts);
							}
						}
						out.dataStream += "\r";
						out.paragraphs.push({ startIndex: out.dataStream.length - 1, paragraphId: `p-${out.paragraphs.length}` });
					}
					if (!cellParas.length) {
						out.dataStream += "\r";
						out.paragraphs.push({ startIndex: out.dataStream.length - 1, paragraphId: `p-${out.paragraphs.length}` });
					}
				} else {
					out.dataStream += "\r";
					out.paragraphs.push({ startIndex: out.dataStream.length - 1, paragraphId: `p-${out.paragraphs.length}` });
				}
				// Engine table cells must close with a section-break sentinel
				// (structure validator: "Table cell must contain a paragraph
				// and section break child") — same shape as its own
				// genEmptyTable: CELL_START + "\r\n" + CELL_END.
				out.dataStream += "\n";
				out.sectionBreaks.push({ sectionId: `s-${out.sectionBreaks.length}`, startIndex: out.dataStream.length - 1 });
				out.dataStream += TOK.CELL_END;
			}
			out.dataStream += TOK.ROW_END;
		}
		out.dataStream += TOK.TABLE_END;
		// endIndex is exclusive: one past the TABLE_END sentinel (validator:
	// "Table endIndex must be the exclusive boundary immediately after a
	// table end sentinel").
	out.tables.push({ startIndex, endIndex: out.dataStream.length, tableId });
	};

	let anchorCounter = 0;
	for (const child of Array.from(bodyEl.children)) {
		if (child.localName === "p") {
			if (paragraphHasUnmodelledContent(child)) {
				const key = `k${anchorCounter++}`;
				// Anchor paragraph: marker + label + flattened text.
				let text = "";
				for (const t of child.getElementsByTagNameNS(NS_W, "t")) text += t.textContent ?? "";
				const label = child.getElementsByTagNameNS(NS_W, "drawing").length || child.getElementsByTagNameNS(NS_W, "pict").length
					? "〔图片〕"
					: child.getElementsByTagNameNS(NS_W, "oMath").length || child.getElementsByTagNameNS(NS_W, "oMathPara").length
						? "〔公式〕"
						: child.getElementsByTagNameNS(NS_W, "footnoteReference").length || child.getElementsByTagNameNS(NS_W, "endnoteReference").length
							? "〔脚注〕"
							: "";
				out.dataStream += `〔#${key}〕${label}${text}\r`;
				out.paragraphs.push({ startIndex: out.dataStream.length - 1, paragraphId: `p-${out.paragraphs.length}` });
			} else {
				pushParagraphFromXml(child);
			}
		} else if (child.localName === "tbl") {
			pushTable(child);
		}
	}
	// Engine documents end with a "\r\n" sentinel pair carrying both the
	// final paragraph and the final section-break metadata. When the stream
	// already ends with a bare "\r" that break is the final paragraph — only
	// the section break is appended, no duplicate paragraph entry.
	if (out.dataStream.endsWith("\r\n")) {
		// already complete
	} else if (out.dataStream.endsWith("\r")) {
		out.dataStream += "\n";
	} else {
		out.dataStream += "\r\n";
		out.paragraphs.push({ startIndex: out.dataStream.length - 2, paragraphId: `p-${out.paragraphs.length}` });
	}
	out.sectionBreaks.push({ sectionId: `s-${out.sectionBreaks.length}`, startIndex: out.dataStream.length - 1 });
	return out;
}

/** Walks the original body and assigns deterministic anchor keys (k0, k1, …)
 * to structures Univer cannot model (images, equations, footnote references).
 * Both the import parse and the save splice run this same walk — tables are
 * NOT anchors anymore (they convert to real engine tables) — so keys line up
 * by construction without shared state. */
function collectPreserved(bodyEl: Element): Map<string, Element> {
	const preserved = new Map<string, Element>();
	let counter = 0;
	for (const child of Array.from(bodyEl.children)) {
		if (child.localName === "p" && paragraphHasUnmodelledContent(child)) {
			preserved.set(`k${counter++}`, child);
		}
	}
	return preserved;
}

/* ------------------------------------------------------------------ */
/* Import via engine HTML paste: docx → HTML, then the engine's own    */
/* clipboard converter builds the body (tables, headings, run styles   */
/* and inline images are all parsed by its production code path).      */
/* ------------------------------------------------------------------ */

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function runStyleToCss(ts: UniverTextStyle): string {
	const parts: string[] = [];
	if (ts.bl === 1) parts.push("font-weight: bold");
	if (ts.it === 1) parts.push("font-style: italic");
	const deco: string[] = [];
	if (ts.ul?.s === 1) deco.push("underline");
	if (ts.st?.s === 1) deco.push("line-through");
	if (deco.length) parts.push(`text-decoration: ${deco.join(" ")}`);
	if (ts.cl?.rgb) parts.push(`color: ${ts.cl.rgb}`);
	if (typeof ts.fs === "number") parts.push(`font-size: ${ts.fs}pt`);
	if (ts.ff) parts.push(`font-family: ${ts.ff}`);
	return parts.join("; ");
}

function runsToHtml(runs: DocxRunInput[]): string {
	return runs.map((run) => {
		const inner = run.text
			.split("\n").map(escapeHtml).join("<br>")
			.replace(/\t/g, "&#9;");
		const css = run.ts ? runStyleToCss(run.ts) : "";
		const sup = run.ts?.va === "superscript" ? "sup" : run.ts?.va === "subscript" ? "sub" : null;
		const body = sup ? `<${sup}>${inner}</${sup}>` : inner;
		return css ? `<span style="${css}">${body}</span>` : body;
	}).join("") || "";
}

function paragraphStyleToCss(style: UniverParagraphStyle | undefined): string {
	if (!style) return "";
	const parts: string[] = [];
	if (style.horizontalAlign === HAL_CENTER) parts.push("text-align: center");
	else if (style.horizontalAlign === HAL_RIGHT) parts.push("text-align: right");
	else if (style.horizontalAlign === HAL_JUSTIFIED) parts.push("text-align: justify");
	return parts.join("; ");
}

function headingTag(style: UniverParagraphStyle | undefined): string | null {
	const named = style?.namedStyleType;
	if (named == null) return null;
	if (named === NAMED_TITLE) return "h1";
	if (named >= NAMED_HEADING_BASE && named <= NAMED_HEADING_BASE + 4) return `h${named - NAMED_HEADING_BASE + 1}`;
	return null;
}

/** EMU (914400/inch) → CSS px at 96 dpi. */
const emuToPx = (emu: number) => Math.round(emu / 9525);

async function mediaDataUrl(zip: JSZip, rels: Map<string, string>, embedId: string): Promise<{ url: string; ext: string } | null> {
	const target = rels.get(embedId);
	if (!target) return null;
	const path = target.startsWith("/") ? target.slice(1) : `word/${target.replace(/^\.\//, "")}`;
	const entry = zip.file(path);
	if (!entry) return null;
	const ext = (path.split(".").pop() ?? "png").toLowerCase();
	const mime = ext === "png" ? "image/png" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "gif" ? "image/gif" : ext === "bmp" ? "image/bmp" : ext === "svg" ? "image/svg+xml" : "image/png";
	const b64 = await entry.async("base64");
	return { url: `data:${mime};base64,${b64}`, ext };
}

function parseRels(relsXml: string): Map<string, string> {
	const rels = new Map<string, string>();
	const dom = new DOMParser().parseFromString(relsXml, "application/xml");
	for (const rel of Array.from(dom.getElementsByTagNameNS("http://schemas.openxmlformats.org/package/2006/relationships", "Relationship"))) {
		const id = rel.getAttribute("Id");
		const target = rel.getAttribute("Target");
		if (id && target && rel.getAttribute("Type")?.endsWith("/image")) rels.set(id, target);
	}
	return rels;
}

export interface DocxHtmlImport {
	html: string;
}

/**
 * Convert a docx into HTML for the engine's own clipboard paste path.
 *
 * The engine's HTML converter (HtmlToUDMService → legacyPaste) is its
 * production import path for pasted Word content: it natively understands
 * headings (h1-h5), text-align, run styles, tables (colspan/rowspan) and
 * inline <img data URLs> (which become editable custom-block drawings shown
 * directly in the editor). Feeding it HTML instead of a hand-built body keeps
 * every structure inside the engine's own invariants — hand-built bodies hit
 * OT/structure errors on large documents ("descent keys are not in order").
 *
 * Unmodelled structures (images, equations, footnote references) keep their
 * 〔#kN〕 anchor text at the paragraph head; the save path splices the
 * original XML back at those anchors, so what the drawing shows is only a
 * preview while the saved file keeps the original bytes.
 */
export async function docxBytesToHtml(bytes: ArrayBuffer | Uint8Array): Promise<DocxHtmlImport> {
	const zip = JSZip();
	await zip.loadAsync(bytes);
	const documentXml = await zip.file("word/document.xml")?.async("string");
	if (!documentXml) throw new Error("Not a docx file (missing word/document.xml)");
	const relsXml = await zip.file("word/_rels/document.xml.rels")?.async("string") ?? "";
	const rels = parseRels(relsXml);
	const dom = new DOMParser().parseFromString(documentXml, "application/xml");
	if (dom.getElementsByTagName("parsererror").length) throw new Error("Corrupt document.xml");
	const bodyEl = dom.getElementsByTagNameNS(NS_W, "body")[0];
	if (!bodyEl) throw new Error("Empty docx body");

	const htmlParts: string[] = [];
	let anchorCounter = 0;

	const paragraphRuns = (para: Element): DocxRunInput[] => {
		const runs: DocxRunInput[] = [];
		const direct = Array.from(para.children).flatMap((child) => {
			if (child.localName === "r") return [child];
			if (child.localName === "hyperlink") return Array.from(child.children).filter((c) => c.localName === "r");
			return [];
		});
		for (const run of direct) {
			const ts = runStyleFromRPr(el(run, "rPr"));
			let text = "";
			for (const node of Array.from(run.children)) {
				if (node.localName === "t") text += node.textContent ?? "";
				else if (node.localName === "tab") text += "\t";
				else if (node.localName === "br") text += "\n";
			}
			if (text) runs.push({ text, ...(Object.keys(ts).length ? { ts } : {}) });
		}
		return runs;
	};

	const emitParagraph = async (para: Element, anchorKey: string | null, label: string) => {
		const style = paragraphStyleFromPPr(el(para, "pPr"));
		const css = paragraphStyleToCss(style);
		const tag = headingTag(style) ?? "p";
		let inner = runsToHtml(paragraphRuns(para));
		if (anchorKey != null) {
			// Inline images become real drawings; other structures keep the
			// label text. Either way the 〔#kN〕 marker survives in the stream
			// so the save splice can find the original XML again.
			const imgs: string[] = [];
			for (const blip of Array.from(para.getElementsByTagNameNS("http://schemas.openxmlformats.org/drawingml/2006/main", "blip"))) {
				const embed = blip.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "embed") ?? blip.getAttribute("r:embed");
				if (!embed) continue;
				const media = await mediaDataUrl(zip, rels, embed);
				if (!media) continue;
				// Size from the paragraph's first drawing extent, if present.
				// (Element.closest cannot take a namespaced selector like
				// "wp:inline", so search from the owning paragraph instead.)
				const extent = para.getElementsByTagNameNS("http://schemas.openxmlformats.org/drawingml/2006/wordprocessing", "extent")[0] ?? null;
				const cx = attrNum(extent, "cx");
				const cy = attrNum(extent, "cy");
				const w = cx != null ? emuToPx(cx) : 0;
				const h = cy != null ? emuToPx(cy) : 0;
				const dims = w && h ? ` width="${w}" height="${h}"` : "";
				const dtw = w ? ` data-doc-transform-width="${w}px" data-doc-transform-height="${h}px"` : "";
				imgs.push(`<img src="${media.url}"${dims}${dtw} style="${w && h ? `width:${w}px;height:${h}px;` : ""}vertical-align:middle">`);
			}
			inner = `〔#${anchorKey}〕${label}${inner}${imgs.join("")}`;
		}
		htmlParts.push(`<${tag}${css ? ` style="${css}"` : ""}>${inner}</${tag}>`);
	};

	const emitTable = async (tbl: Element) => {
		const rows: string[] = [];
		for (const tr of Array.from(tbl.getElementsByTagNameNS(NS_W, "tr"))) {
			const cells: string[] = [];
			for (const tc of Array.from(tr.children).filter((c) => c.localName === "tc")) {
				const tcPr = el(tc, "tcPr");
				const gs = attrNum(el(tcPr, "gridSpan"), "val") ?? 1;
				const vMergeEl = el(tcPr, "vMerge");
				const vMerge = vMergeEl ? (attrText(vMergeEl, "val") ?? "continue") : null;
				const attrs: string[] = [];
				if (gs > 1) attrs.push(`colspan="${gs}"`);
				if (vMerge === "restart") attrs.push(`rowspan="1" data-vmerge="restart"`);
				const paras = Array.from(tc.children).filter((c) => c.localName === "p");
				const content = paras.map((cp) => {
					const st = paragraphStyleToCss(paragraphStyleFromPPr(el(cp, "pPr")));
					return `<p${st ? ` style="${st}"` : ""}>${runsToHtml(paragraphRuns(cp))}</p>`;
				}).join("") || "<p></p>";
				cells.push(`<td${attrs.length ? " " + attrs.join(" ") : ""}>${content}</td>`);
			}
			rows.push(`<tr>${cells.join("")}</tr>`);
		}
		htmlParts.push(`<table><tbody>${rows.join("")}</tbody></table>`);
	};

	for (const child of Array.from(bodyEl.children)) {
		if (child.localName === "p") {
			if (paragraphHasUnmodelledContent(child)) {
				const key = `k${anchorCounter++}`;
				const isImage = child.getElementsByTagNameNS(NS_W, "drawing").length > 0 || child.getElementsByTagNameNS(NS_W, "pict").length > 0;
				const label = isImage ? "" : child.getElementsByTagNameNS(NS_W, "oMath").length || child.getElementsByTagNameNS(NS_W, "oMathPara").length ? "〔公式〕" : child.getElementsByTagNameNS(NS_W, "footnoteReference").length || child.getElementsByTagNameNS(NS_W, "endnoteReference").length ? "〔脚注〕" : "";
				await emitParagraph(child, key, label);
			} else {
				await emitParagraph(child, null, "");
			}
		} else if (child.localName === "tbl") {
			await emitTable(child);
		}
	}
	return { html: htmlParts.join("") };
}

/* ------------------------------------------------------------------ */
/* Save: splice the edited body back into the original zip.           */
/* ------------------------------------------------------------------ */

function unitPt(unit: { v: number; u?: number } | undefined): number | undefined {
	if (!unit || typeof unit.v !== "number") return undefined;
	// u=0 is Univer's POINT; other units are rare in our own exports — treat
	// unknown as points rather than dropping the value.
	return unit.v;
}

const headingFor = (named?: number): string | null => {
	if (named == null) return null;
	if (named === NAMED_TITLE) return "Title";
	if (named >= NAMED_HEADING_BASE && named <= NAMED_HEADING_BASE + 4) return `Heading${named - NAMED_HEADING_BASE + 1}`;
	return null;
};

function setW(node: Element, name: string, value: string): void {
	node.setAttributeNS(NS_W, `w:${name}`, value);
}

function buildRun(doc: XMLDocument, text: string, ts: UniverTextStyle | null): Element {
	const run = doc.createElementNS(NS_W, "w:r");
	if (ts && Object.keys(ts).length) {
		const rPr = doc.createElementNS(NS_W, "w:rPr");
		// OOXML schema order for the subset we write.
		if (ts.ff) {
			const fonts = doc.createElementNS(NS_W, "w:rFonts");
			setW(fonts, "ascii", ts.ff);
			setW(fonts, "hAnsi", ts.ff);
			setW(fonts, "eastAsia", ts.ff);
			rPr.appendChild(fonts);
		}
		if (ts.bl === 1) rPr.appendChild(doc.createElementNS(NS_W, "w:b"));
		if (ts.it === 1) rPr.appendChild(doc.createElementNS(NS_W, "w:i"));
		if (ts.ul?.s === 1) {
			const u = doc.createElementNS(NS_W, "w:u");
			setW(u, "val", "single");
			rPr.appendChild(u);
		}
		if (ts.st?.s === 1) rPr.appendChild(doc.createElementNS(NS_W, "w:strike"));
		if (ts.cl?.rgb) {
			const color = doc.createElementNS(NS_W, "w:color");
			setW(color, "val", ts.cl.rgb.replace("#", "").toUpperCase());
			rPr.appendChild(color);
		}
		if (typeof ts.fs === "number") {
			const half = String(Math.round(ts.fs * 2));
			const sz = doc.createElementNS(NS_W, "w:sz");
			setW(sz, "val", half);
			rPr.appendChild(sz);
			const szCs = doc.createElementNS(NS_W, "w:szCs");
			setW(szCs, "val", half);
			rPr.appendChild(szCs);
		}
		if (ts.va) {
			const va = doc.createElementNS(NS_W, "w:vertAlign");
			setW(va, "val", ts.va === "superscript" ? "superscript" : "subscript");
			rPr.appendChild(va);
		}
		run.appendChild(rPr);
	}
	// Group the text into plain / tab / break chunks so ordinary text lands in
	// a single w:t instead of one per character.
	let buf = "";
	const flushText = () => {
		if (!buf) return;
		const t = doc.createElementNS(NS_W, "w:t");
		t.setAttribute("xml:space", "preserve");
		t.textContent = buf;
		run.appendChild(t);
		buf = "";
	};
	for (const ch of text) {
		if (ch === "\t") {
			flushText();
			run.appendChild(doc.createElementNS(NS_W, "w:tab"));
		} else if (ch === "\n") {
			flushText();
			run.appendChild(doc.createElementNS(NS_W, "w:br"));
		} else {
			buf += ch;
		}
	}
	flushText();
	return run;
}

function buildParagraph(doc: XMLDocument, pieces: Array<{ text: string; ts: UniverTextStyle | null }>, style: UniverParagraphStyle | undefined): Element {
	const p = doc.createElementNS(NS_W, "w:p");
	const pPr = doc.createElementNS(NS_W, "w:pPr");
	// OOXML schema order: pStyle, numPr, spacing, ind, jc.
	const pStyleName = style ? headingFor(style.namedStyleType) : null;
	if (pStyleName) {
		const pStyle = doc.createElementNS(NS_W, "w:pStyle");
		setW(pStyle, "val", pStyleName);
		pPr.appendChild(pStyle);
	}
	if (style?.xNum) {
		const [numId, ilvl] = style.xNum.split(":");
		const numPr = doc.createElementNS(NS_W, "w:numPr");
		const ilvlEl = doc.createElementNS(NS_W, "w:ilvl");
		setW(ilvlEl, "val", ilvl ?? "0");
		const numIdEl = doc.createElementNS(NS_W, "w:numId");
		setW(numIdEl, "val", numId ?? "0");
		numPr.appendChild(ilvlEl);
		numPr.appendChild(numIdEl);
		pPr.appendChild(numPr);
	}
	if (style) {
		const spacing: Array<[string, number | undefined]> = [
			["before", unitPt(style.spaceAbove) != null ? ptToTwips(unitPt(style.spaceAbove)!) : undefined],
			["after", unitPt(style.spaceBelow) != null ? ptToTwips(unitPt(style.spaceBelow)!) : undefined],
			["line", style.lineSpacing != null && style.lineSpacing > 0 ? Math.round(style.lineSpacing * 240) : undefined],
		];
		if (spacing.some(([, v]) => v != null)) {
			const spacingEl = doc.createElementNS(NS_W, "w:spacing");
			for (const [name, value] of spacing) if (value != null) setW(spacingEl, name, String(value));
			pPr.appendChild(spacingEl);
		}
		const ind: Array<[string, number | undefined]> = [
			["firstLine", unitPt(style.indentFirstLine) != null ? ptToTwips(unitPt(style.indentFirstLine)!) : undefined],
			["hanging", unitPt(style.hanging) != null ? ptToTwips(unitPt(style.hanging)!) : undefined],
			["left", unitPt(style.indentStart) != null ? ptToTwips(unitPt(style.indentStart)!) : undefined],
			["right", unitPt(style.indentEnd) != null ? ptToTwips(unitPt(style.indentEnd)!) : undefined],
		];
		if (ind.some(([, v]) => v != null)) {
			const indEl = doc.createElementNS(NS_W, "w:ind");
			for (const [name, value] of ind) if (value != null) setW(indEl, name, String(value));
			pPr.appendChild(indEl);
		}
		const align = style.horizontalAlign === HAL_CENTER ? "center" : style.horizontalAlign === HAL_RIGHT ? "right" : style.horizontalAlign === HAL_JUSTIFIED ? "both" : null;
		if (align) {
			const jc = doc.createElementNS(NS_W, "w:jc");
			setW(jc, "val", align);
			pPr.appendChild(jc);
		}
	}
	if (pPr.childNodes.length) p.appendChild(pPr);
	if (pieces.length) {
		for (const run of pieces) p.appendChild(buildRun(doc, run.text, run.ts));
	}
	return p;
}

/** Splits a snapshot paragraph's text into styled run pieces using the
 * snapshot's textRuns (inline ts or sId → styles registry). */
function styledPieces(snapshot: UniverDocSnapshot, start: number, textEnd: number, stream: string): Array<{ text: string; ts: UniverTextStyle | null }> {
	const pieces: Array<{ text: string; ts: UniverTextStyle | null }> = [];
	let cursor = start;
	let pieceStart = cursor;
	let ts: UniverTextStyle | null = null;
	const flush = (upTo: number) => {
		if (upTo > pieceStart) pieces.push({ text: stream.slice(pieceStart, upTo), ts });
		pieceStart = upTo;
	};
	for (const run of snapshot.body?.textRuns ?? []) {
		if (run.ed <= start || run.st >= textEnd) continue;
		if (run.st > cursor) {
			flush(run.st);
			ts = null;
		}
		ts = run.sId ? (snapshot.styles?.[run.sId]?.textStyle ?? {}) : (run.ts ?? {});
		cursor = Math.max(cursor, Math.min(run.ed, textEnd));
	}
	flush(textEnd);
	return pieces;
}

/**
 * Save path with an original file: splice the edited body into the original
 * zip. Every part except word/document.xml is byte-identical to the original
 * (media, numbering, footnotes, headers/footers, styles, rels), and inside
 * document.xml the trailing sectPr is kept verbatim. Preserved anchors
 * (〔#kN〕 paragraphs) are replaced by their original XML blocks.
 */
export async function univerDocToPreservedDocxBytes(originalBytes: ArrayBuffer | Uint8Array, snapshot: UniverDocSnapshot, name: string): Promise<Uint8Array> {
	const zip = JSZip();
	await zip.loadAsync(originalBytes);
	const documentXml = await zip.file("word/document.xml")?.async("string");
	if (!documentXml) throw new Error("Original docx lost document.xml");
	const dom = new DOMParser().parseFromString(documentXml, "application/xml");
	if (dom.getElementsByTagName("parsererror").length) throw new Error("Corrupt original document.xml");
	const bodyEl = dom.getElementsByTagNameNS(NS_W, "body")[0];
	if (!bodyEl) throw new Error("Empty original body");

	const preserved = collectPreserved(bodyEl);
	const usedAnchors = new Set<string>();
	const sectPr = Array.from(bodyEl.children).at(-1);
	const keepSectPr = sectPr?.localName === "sectPr" ? sectPr : null;

	while (bodyEl.firstChild) bodyEl.removeChild(bodyEl.firstChild);

	const stream = snapshot.body?.dataStream ?? "";
	const paragraphs = (snapshot.body?.paragraphs ?? []).slice().sort((a, b) => a.startIndex - b.startIndex);
	const boundaries = paragraphs.length
		? paragraphs.map((p, i) => ({
			start: i === 0 ? 0 : paragraphs[i - 1].startIndex + 1,
			end: p.startIndex,
			meta: p,
		}))
		: [];

	// Engine tables ride the snapshot as {startIndex, endIndex, tableId} over
	// the table stream tokens; the user-editable text lives between tables.
	// Output order follows the stream: tables and paragraphs interleave.
	const snapshotTables = (snapshot.body?.tables ?? []).slice().sort((a, b) => a.startIndex - b.startIndex);
	// The engine may reassign tableIds between import and save, so sources are
	// matched by position (tables and tableSource values keep document order).
	const sourceList = Object.values(snapshot.tableSource ?? {});
	let tableCursor = 0;
	let pendingTable = snapshotTables[tableCursor] ?? null;

	const buildTableXml = (table: { startIndex: number; endIndex: number; tableId: string }): Element => {
		const source = snapshot.tableSource?.[table.tableId] ?? sourceList[snapshotTables.indexOf(table)];
		const tbl = dom.createElementNS(NS_W, "w:tbl");
		// Rebuild OOXML physical rows from the engine grid: a covered slot
		// {rowSpan:0,columnSpan:0} at (r,c) means the cell above spans it.
		if (source) {
			const gridEl = dom.createElementNS(NS_W, "w:tblGrid");
			for (const column of source.tableColumns) {
				const gridCol = dom.createElementNS(NS_W, "w:gridCol");
				setW(gridCol, "w", String(ptToTwips(column.size.width.v ?? 80)));
				gridEl.appendChild(gridCol);
			}
			tbl.appendChild(gridEl);
		}
		// Walk the table's stream region to extract each cell's paragraph runs.
		const cellParagraphs: Array<Array<{ text: string; ts: UniverTextStyle | null }>> = [];
		let i = table.startIndex;
		let cellStart = -1;
		while (i <= table.endIndex && i < stream.length) {
			const ch = stream[i];
			if (ch === TOK.CELL_START) cellStart = i + 1;
			else if (ch === TOK.CELL_END && cellStart >= 0) {
				// Strip the trailing "\r\n" paragraph/section-break sentinels
				// that close every engine table cell.
				const pieces = styledPieces(snapshot, cellStart, i, stream)
					.map((p) => ({ ...p, text: p.text.replace(/\r\n+$/, "").replace(/\r+$/, "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "") }))
					.filter((p) => p.text);
				cellParagraphs.push(pieces);
				cellStart = -1;
			}
			i += 1;
		}
		let cellIndex = 0;
		if (source) {
			// Track which column each row's cells start at to map vertical merges.
			for (const row of source.tableRows) {
				const tr = dom.createElementNS(NS_W, "w:tr");
				let col = 0;
				for (const cell of row.tableCells) {
					const pieces = cellParagraphs[cellIndex++] ?? [];
					const tc = dom.createElementNS(NS_W, "w:tc");
					const tcPr = dom.createElementNS(NS_W, "w:tcPr");
					const columnSpan = cell.columnSpan ?? 1;
					const rowSpan = cell.rowSpan ?? 1;
					if (columnSpan > 1) {
						const gs = dom.createElementNS(NS_W, "w:gridSpan");
						setW(gs, "val", String(columnSpan));
						tcPr.appendChild(gs);
					}
					if (rowSpan === 0) {
						// Covered slot: continuation of the vertical merge above.
						const vm = dom.createElementNS(NS_W, "w:vMerge");
						tcPr.appendChild(vm);
					} else if (rowSpan > 1) {
						const vm = dom.createElementNS(NS_W, "w:vMerge");
						setW(vm, "val", "restart");
						tcPr.appendChild(vm);
					}
					if (source.tableColumns[col]) {
						const tcW = dom.createElementNS(NS_W, "w:tcW");
						setW(tcW, "w", String(ptToTwips(source.tableColumns[col].size.width.v ?? 80)));
						setW(tcW, "type", "dxa");
						tcPr.appendChild(tcW);
					}
					if (tcPr.childNodes.length) tc.appendChild(tcPr);
					if (pieces.length) {
						for (const piece of pieces) tc.appendChild(buildParagraph(dom, piece.text ? [piece] : [], undefined));
					} else {
						tc.appendChild(buildParagraph(dom, [], undefined));
					}
					tr.appendChild(tc);
					col += columnSpan;
				}
				tbl.appendChild(tr);
			}
		} else {
			// No source (shouldn't happen): emit one row of the raw cells.
			const tr = dom.createElementNS(NS_W, "w:tr");
			for (const pieces of cellParagraphs) {
				const tc = dom.createElementNS(NS_W, "w:tc");
				tc.appendChild(buildParagraph(dom, pieces, undefined));
				tr.appendChild(tc);
			}
			tbl.appendChild(tr);
		}
		return tbl;
	};

	// Walk paragraphs and tables in stream order with a cursor. Paragraphs
	// whose break falls inside a table range are cell content — the table
	// rebuild already emits them — so the cursor skips the whole table span.
	let segStart = 0;
	for (const meta of paragraphs) {
		const brk = meta.startIndex;
		while (pendingTable && pendingTable.startIndex <= brk) {
			bodyEl.appendChild(buildTableXml(pendingTable));
			segStart = Math.max(segStart, pendingTable.endIndex + 1);
			tableCursor += 1;
			pendingTable = snapshotTables[tableCursor] ?? null;
		}
		if (brk < segStart) continue; // inside the flushed table's cells
		const text = stream.slice(segStart, brk);
		segStart = brk + 1;
		const anchor = ANCHOR_RE.exec(text);
		if (anchor) {
			const key = anchor[1];
			const original = preserved.get(key);
			if (original && !usedAnchors.has(key)) {
				usedAnchors.add(key);
				bodyEl.appendChild(dom.importNode(original, true));
				continue;
			}
			// Anchor unknown or already used: emit the remaining text (marker
			// stripped) as a plain paragraph.
		}
		// Anchor markers may be split across styled pieces (the engine re-runs
		// styles after paste), and unmatched anchors leak engine control tokens
		// like \b (drawing) into the text — one such byte made the saved XML
		// "disallowed character"-invalid. Strip markers and control tokens
		// from every piece of every paragraph.
		const textStart = brk - text.length;
		const sanitize = (t: string) => t.replace(ANCHOR_RE, "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
		let pieces = styledPieces(snapshot, textStart, brk, stream)
			.map((p) => ({ ...p, text: sanitize(p.text) }))
			.filter((p) => p.text);
		if (!pieces.length) {
			const stripped = sanitize(text);
			if (stripped) pieces = [{ text: stripped, ts: null }];
		}
		bodyEl.appendChild(buildParagraph(dom, pieces, meta.paragraphStyle));
	}
	while (pendingTable) {
		bodyEl.appendChild(buildTableXml(pendingTable));
		tableCursor += 1;
		pendingTable = snapshotTables[tableCursor] ?? null;
	}
	if (keepSectPr) bodyEl.appendChild(dom.importNode(keepSectPr, true));

	zip.file("word/document.xml", new XMLSerializer().serializeToString(dom));
	const blob = await zip.generateAsync({ type: "uint8array" });
	return blob;
}

/**
 * Fallback save path without an original file (e.g. corrupted cache):
 * generate a fresh minimal docx from the snapshot via the docx writer.
 */
export async function univerDocToDocxBytes(snapshot: UniverDocSnapshot, name: string): Promise<Uint8Array> {
	const body = snapshot.body;
	const stream = body?.dataStream ?? "";
	const paragraphs = (body?.paragraphs ?? []).slice().sort((a, b) => a.startIndex - b.startIndex);
	const children: DocxParagraph[] = [];

	const boundaries = paragraphs.length
		? paragraphs.map((p, i) => ({
			start: i === 0 ? 0 : paragraphs[i - 1].startIndex + 1,
			end: p.startIndex,
			meta: p,
		}))
		: [];

	for (const { start, end, meta } of boundaries) {
		if (end < start) continue;
		const text = stream.slice(start, end).replace(ANCHOR_RE, "");
		const opts: Record<string, unknown> = {};
		const style = meta?.paragraphStyle;
		if (style) {
			if (style.horizontalAlign === HAL_CENTER) opts.alignment = AlignmentType.CENTER;
			else if (style.horizontalAlign === HAL_RIGHT) opts.alignment = AlignmentType.RIGHT;
			else if (style.horizontalAlign === HAL_JUSTIFIED) opts.alignment = AlignmentType.JUSTIFIED;
			const heading = headingFor(style.namedStyleType);
			if (heading) opts.heading = heading as never;
			const spacing: { before?: number; after?: number; line?: number } = {};
			const before = unitPt(style.spaceAbove);
			if (before != null) spacing.before = ptToTwips(before);
			const after = unitPt(style.spaceBelow);
			if (after != null) spacing.after = ptToTwips(after);
			if (style.lineSpacing != null && style.lineSpacing > 0) spacing.line = Math.round(style.lineSpacing * 240);
			if (Object.keys(spacing).length) opts.spacing = spacing;
			const indent: { firstLine?: number; hanging?: number; left?: number; right?: number } = {};
			const firstLine = unitPt(style.indentFirstLine);
			if (firstLine != null) indent.firstLine = ptToTwips(firstLine);
			const hanging = unitPt(style.hanging);
			if (hanging != null) indent.hanging = ptToTwips(hanging);
			const left = unitPt(style.indentStart);
			if (left != null) indent.left = ptToTwips(left);
			const right = unitPt(style.indentEnd);
			if (right != null) indent.right = ptToTwips(right);
			if (Object.keys(indent).length) opts.indent = indent;
		}
		const runs: TextRun[] = [];
		for (const piece of styledPieces(snapshot, start, end, stream)) {
			if (piece.ts && Object.keys(piece.ts).length) {
				const runOpts: Record<string, unknown> = { text: piece.text };
				if (piece.ts.bl === 1) runOpts.bold = true;
				if (piece.ts.it === 1) runOpts.italics = true;
				if (piece.ts.ul?.s === 1) runOpts.underline = {};
				if (piece.ts.st?.s === 1) runOpts.strike = true;
				if (typeof piece.ts.fs === "number") runOpts.size = Math.round(piece.ts.fs * 2);
				if (piece.ts.cl?.rgb) runOpts.color = piece.ts.cl.rgb.replace("#", "");
				if (piece.ts.ff) runOpts.font = piece.ts.ff;
				if (piece.ts.va === "superscript") runOpts.superScript = true;
				else if (piece.ts.va === "subscript") runOpts.subScript = true;
				runs.push(new TextRun(runOpts as never));
			} else {
				runs.push(new TextRun(piece.text));
			}
		}
		if (!runs.length && text === "") {
			children.push(new DocxParagraph(opts as never));
			continue;
		}
		if (!runs.length) runs.push(new TextRun(text));
		children.push(new DocxParagraph({ ...opts, children: runs } as never));
	}

	const doc = new Document({
		title: name,
		sections: [{ properties: {}, children: children.length ? children : [new DocxParagraph("")] }],
		numbering: {
			config: [{
				reference: "univer-bullet",
				levels: [
					{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT },
					{ level: 1, format: LevelFormat.BULLET, text: "◦", alignment: AlignmentType.LEFT },
					{ level: 2, format: LevelFormat.BULLET, text: "▪", alignment: AlignmentType.LEFT },
				],
			}],
		},
	});
	// Packer.toBuffer needs node's Buffer, which does not exist in the browser
	// (verified live: "nodebuffer is not supported by this platform"). Blob
	// works in both the browser and Node 18+ (vitest).
	const blob = await Packer.toBlob(doc);
	return new Uint8Array(await blob.arrayBuffer());
}
