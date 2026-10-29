/**
 * ExcelJS ↔ Univer snapshot conversion for the xlsx editor.
 *
 * Univer's xlsx import/export is a Pro feature; this converter covers the
 * open-source subset we need. The former SheetJS-based build lost every rich
 * style on save (the community build cannot write styles), so the pipeline now
 * round-trips through ExcelJS, which reads and writes them.
 *
 * Preserved across edit→save: values, formulas, merges, column widths, row
 * heights, and the common cell styles (bold, italic, font family/size, font
 * color, background fill, horizontal/vertical alignment, wrap, number
 * format, the four plain borders). Still NOT preserved: charts, images,
 * conditional formatting, data validation, pivot tables, shared formulas
 * (kept as static values) and rich text (flattened to plain text).
 */
import ExcelJS from "exceljs";

/** Univer CellValueType: STRING=1, NUMBER=2, BOOLEAN=3, FORCE_STRING=4. */
const T_STRING = 1;
const T_NUMBER = 2;
const T_BOOLEAN = 3;
const T_FORCE_STRING = 4;

/** Univer enum values (kept as literals so the editor bundle needs no core import). */
const HT_LEFT = 1;
const HT_CENTER = 2;
const HT_RIGHT = 3;
const VT_TOP = 1;
const VT_MIDDLE = 2;
const VT_BOTTOM = 3;
const TB_WRAP = 3;

const BORDER_STYLE_MAP: Record<string, number> = {
	thin: 1,
	hair: 2,
	dotted: 3,
	dashed: 4,
	dashDot: 5,
	dashDotDot: 6,
	double: 7,
	medium: 8,
	mediumDashed: 9,
	mediumDashDot: 10,
	mediumDashDotDot: 11,
	slantDashDot: 12,
	thick: 13,
};
const BORDER_STYLE_REVERSE: Record<number, string> = Object.fromEntries(
	Object.entries(BORDER_STYLE_MAP).map(([k, v]) => [v, k]),
);

/** Univer IColorStyle subset — only what this converter emits/reads. */
export interface UniverColorStyle {
	rgb?: string | null;
}

interface UniverBorderItem {
	s?: number;
	cl?: UniverColorStyle;
}

/** Univer IStyleData subset this converter round-trips. */
export interface UniverStyle {
	ff?: string | null;
	fs?: number;
	it?: number;
	bl?: number;
	bg?: UniverColorStyle | null;
	cl?: UniverColorStyle | null;
	n?: { pattern: string };
	ht?: number;
	vt?: number;
	tb?: number;
	bd?: {
		t?: UniverBorderItem | null;
		r?: UniverBorderItem | null;
		b?: UniverBorderItem | null;
		l?: UniverBorderItem | null;
	} | null;
}

export interface UniverCell {
	v?: string | number | boolean;
	t?: number;
	f?: string;
	s?: UniverStyle | string;
}

interface UniverSheetData {
	id: string;
	name: string;
	rowCount: number;
	columnCount: number;
	cellData: Record<number, Record<number, UniverCell>>;
	mergeData?: Array<{ startRow: number; endRow: number; startColumn: number; endColumn: number }>;
	columnData?: Record<number, { w?: number }>;
	rowData?: Record<number, { h?: number }>;
}

export interface UniverWorkbookData {
	id: string;
	name: string;
	sheetOrder: string[];
	sheets: Record<string, UniverSheetData>;
	/** Style registry the Univer engine attaches on save; cell.s ids resolve here. */
	styles?: Record<string, UniverStyle | null>;
}

const MAX_ROWS = 5000;
const MAX_COLS = 128;

/** ExcelJS column width is in character units; Univer wants pixels. */
const CHAR_TO_PX = (chars: number) => Math.round(chars * 7) + 5;
const PX_TO_CHAR = (px: number) => Math.max(0, (px - 5) / 7);

/** `FF00FF00` (ARGB) ↔ `#00FF00` (Univer rgb). Alpha is dropped/assumed opaque. */
function argbToRgb(argb: string): string | undefined {
	const raw = argb.replace("#", "").toUpperCase();
	if (raw.length !== 8 && raw.length !== 6) return undefined;
	const hex = raw.length === 8 ? raw.slice(2) : raw;
	if (!/^[0-9A-F]{6}$/.test(hex)) return undefined;
	return `#${hex}`;
}
const rgbToArgb = (rgb: string) => `FF${rgb.replace("#", "").toUpperCase()}`;

function decodeRange(range: string): { s: { r: number; c: number }; e: { r: number; c: number } } {
	const [a, b] = range.split(":");
	const decode = (ref: string) => {
		const match = /^([A-Z]+)(\d+)$/.exec(ref.trim());
		if (!match) throw new Error(`Bad cell ref ${ref}`);
		let c = 0;
		for (const ch of match[1]) c = c * 26 + (ch.charCodeAt(0) - 64);
		return { r: Number(match[2]) - 1, c: c - 1 };
	};
	return { s: decode(a), e: decode(b ?? a) };
}

function excelColToIndex(letters: string): number {
	let c = 0;
	for (const ch of letters) c = c * 26 + (ch.charCodeAt(0) - 64);
	return c - 1;
}

/** Flattens any ExcelJS cell value object we do not model into display text. */
function staticText(cell: ExcelJS.Cell, value: ExcelJS.CellValue): string | null {
	try {
		const text = cell.text;
		return text == null ? null : String(text);
	} catch {
		return value == null ? null : String(value);
	}
}

function excelStyleToUniver(cell: ExcelJS.Cell): UniverStyle | undefined {
	const style = cell.style;
	const out: UniverStyle = {};
	const font = style.font;
	if (font) {
		if (font.name) out.ff = font.name;
		if (typeof font.size === "number") out.fs = font.size;
		if (font.bold) out.bl = 1;
		if (font.italic) out.it = 1;
		const fontColor = font.color?.argb;
		if (fontColor) {
			const rgb = argbToRgb(fontColor);
			if (rgb) out.cl = { rgb };
		}
	}
	const fill = style.fill as ExcelJS.FillPattern | undefined;
	if (fill && fill.type === "pattern" && fill.pattern === "solid") {
		const fg = fill.fgColor?.argb;
		if (fg) {
			const rgb = argbToRgb(fg);
			if (rgb) out.bg = { rgb };
		}
	}
	const alignment = style.alignment;
	if (alignment) {
		if (alignment.horizontal === "left") out.ht = HT_LEFT;
		else if (alignment.horizontal === "center" || alignment.horizontal === "centerContinuous") out.ht = HT_CENTER;
		else if (alignment.horizontal === "right") out.ht = HT_RIGHT;
		if (alignment.vertical === "top") out.vt = VT_TOP;
		else if (alignment.vertical === "middle") out.vt = VT_MIDDLE;
		else if (alignment.vertical === "bottom") out.vt = VT_BOTTOM;
		if (alignment.wrapText) out.tb = TB_WRAP;
	}
	const numFmt = cell.numFmt ?? style.numFmt;
	if (numFmt && numFmt !== "General") out.n = { pattern: numFmt };
	const border = style.border;
	if (border) {
		const bd: NonNullable<UniverStyle["bd"]> = {};
		const edges: Array<[keyof NonNullable<UniverStyle["bd"]>, keyof ExcelJS.Borders]> = [
			["t", "top"], ["r", "right"], ["b", "bottom"], ["l", "left"],
		];
		for (const [univerKey, excelKey] of edges) {
			const edge = border[excelKey] as Partial<ExcelJS.Border> | undefined;
			if (!edge || !edge.style) continue;
			const s = BORDER_STYLE_MAP[edge.style];
			if (!s) continue;
			bd[univerKey] = { s, cl: edge.color?.argb ? { rgb: argbToRgb(edge.color.argb) ?? undefined } : undefined };
		}
		if (bd.t || bd.r || bd.b || bd.l) out.bd = bd;
	}
	return Object.keys(out).length ? out : undefined;
}

export function excelJsToUniver(workbook: ExcelJS.Workbook, name: string): UniverWorkbookData {
	const sheets: Record<string, UniverSheetData> = {};
	const sheetOrder: string[] = [];
	workbook.worksheets.forEach((ws, i) => {
		const id = `sheet-${i + 1}`;
		const rowCount = Math.min(ws.rowCount, MAX_ROWS);
		const columnCount = Math.min(Math.max(ws.columnCount, 1), MAX_COLS);
		const cellData: Record<number, Record<number, UniverCell>> = {};
		for (let r = 1; r <= rowCount; r++) {
			const row = ws.getRow(r);
			for (let c = 1; c <= columnCount; c++) {
				const cell = row.getCell(c);
				const raw = cell.value;
				const style = excelStyleToUniver(cell);
				if (raw == null || (typeof raw === "string" && raw === "")) {
					// Style-only cell: keep the formatting, no value.
					if (style) (cellData[r - 1] ??= {})[c - 1] = { s: style };
					continue;
				}
				const out: UniverCell = {};
				if (typeof raw === "object") {
					if ("formula" in raw && typeof raw.formula === "string") {
						out.f = `=${raw.formula}`;
						const result = raw.result;
						if (typeof result === "number") {
							out.v = result;
							out.t = T_NUMBER;
						} else if (typeof result === "string") {
							out.v = result;
							out.t = T_STRING;
						} else if (typeof result === "boolean") {
							out.v = result ? 1 : 0;
							out.t = T_BOOLEAN;
						}
					} else if (raw instanceof Date) {
						const text = staticText(cell, raw);
						if (text != null) {
							out.v = text;
							out.t = T_FORCE_STRING;
						}
					} else {
						// richText / hyperlink / formulaError / sharedFormula — flatten.
						const text = staticText(cell, raw);
						if (text != null) {
							out.v = text;
							out.t = T_FORCE_STRING;
						}
					}
				} else if (typeof raw === "number") {
					out.v = raw;
					out.t = T_NUMBER;
				} else if (typeof raw === "boolean") {
					out.v = raw ? 1 : 0;
					out.t = T_BOOLEAN;
				} else {
					out.v = raw;
					out.t = T_STRING;
				}
				if (style) out.s = style;
				if (out.v !== undefined || out.f || out.s) (cellData[r - 1] ??= {})[c - 1] = out;
			}
		}
		const mergeData = (ws.model.merges ?? []).map((range: string) => {
			const { s, e } = decodeRange(range);
			return { startRow: s.r, endRow: e.r, startColumn: s.c, endColumn: e.c };
		});
		const columnData: Record<number, { w?: number }> = {};
		for (let c = 1; c <= columnCount; c++) {
			const width = ws.getColumn(c).width;
			if (width != null) columnData[c - 1] = { w: CHAR_TO_PX(width) };
		}
		const rowData: Record<number, { h?: number }> = {};
		for (let r = 1; r <= rowCount; r++) {
			const height = ws.getRow(r).height;
			if (height != null) rowData[r - 1] = { h: Math.round(height * 4 / 3) };
		}
		sheets[id] = {
			id,
			name: (ws.name || `Sheet${i + 1}`).slice(0, 31),
			rowCount: Math.max(rowCount, 100),
			columnCount: Math.max(columnCount, 26),
			cellData,
			mergeData,
			columnData,
			rowData,
		};
		sheetOrder.push(id);
	});
	return { id: `wb-${Date.now()}`, name, sheetOrder, sheets };
}

function resolveStyle(cell: UniverCell, styles?: Record<string, UniverStyle | null>): UniverStyle | undefined {
	if (!cell.s) return undefined;
	if (typeof cell.s === "string") return styles?.[cell.s] ?? undefined;
	return cell.s;
}

function univerStyleToExcel(cell: ExcelJS.Cell, style: UniverStyle): void {
	const font: Partial<ExcelJS.Font> = {};
	if (style.ff) font.name = style.ff;
	if (typeof style.fs === "number") font.size = style.fs;
	if (style.bl === 1) font.bold = true;
	if (style.it === 1) font.italic = true;
	if (style.cl?.rgb) font.color = { argb: rgbToArgb(style.cl.rgb) };
	if (Object.keys(font).length) cell.font = font;
	if (style.bg?.rgb) {
		cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: rgbToArgb(style.bg.rgb) } };
	}
	const alignment: Partial<ExcelJS.Alignment> = {};
	if (style.ht === HT_LEFT) alignment.horizontal = "left";
	else if (style.ht === HT_CENTER) alignment.horizontal = "center";
	else if (style.ht === HT_RIGHT) alignment.horizontal = "right";
	if (style.vt === VT_TOP) alignment.vertical = "top";
	else if (style.vt === VT_MIDDLE) alignment.vertical = "middle";
	else if (style.vt === VT_BOTTOM) alignment.vertical = "bottom";
	if (style.tb === TB_WRAP) alignment.wrapText = true;
	if (Object.keys(alignment).length) cell.alignment = alignment;
	if (style.n?.pattern && style.n.pattern !== "General") cell.numFmt = style.n.pattern;
	if (style.bd) {
		const border: Partial<ExcelJS.Borders> = {};
		const edges: Array<[keyof NonNullable<UniverStyle["bd"]>, keyof ExcelJS.Borders]> = [
			["t", "top"], ["r", "right"], ["b", "bottom"], ["l", "left"],
		];
		for (const [univerKey, excelKey] of edges) {
			const item = style.bd[univerKey];
			if (!item?.s) continue;
			const styleName = BORDER_STYLE_REVERSE[item.s];
			if (!styleName) continue;
			border[excelKey] = { style: styleName as ExcelJS.BorderStyle, color: item.cl?.rgb ? { argb: rgbToArgb(item.cl.rgb) } : undefined };
		}
		if (Object.keys(border).length) cell.border = border;
	}
}

export function univerToExcelJs(snapshot: UniverWorkbookData, name: string): ExcelJS.Workbook {
	const wb = new ExcelJS.Workbook();
	wb.creator = name;
	for (const sheetId of snapshot.sheetOrder) {
		const sheet = snapshot.sheets[sheetId];
		if (!sheet) continue;
		const ws = wb.addWorksheet(sheet.name.slice(0, 31) || `Sheet${sheetId}`);
		for (const merge of sheet.mergeData ?? []) {
			ws.mergeCells(merge.startRow + 1, merge.startColumn + 1, merge.endRow + 1, merge.endColumn + 1);
		}
		for (const [rStr, row] of Object.entries(sheet.cellData ?? {})) {
			for (const [cStr, cell] of Object.entries(row)) {
				const target = ws.getCell(Number(rStr) + 1, Number(cStr) + 1);
				if (cell.f) {
					const formula = cell.f.replace(/^=/, "");
					let result: string | number | boolean | undefined;
					if (cell.t === T_BOOLEAN) result = Boolean(cell.v);
					else if (typeof cell.v === "number" || typeof cell.v === "string") result = cell.v;
					target.value = result === undefined ? { formula } : { formula, result };
				} else if (cell.t === T_BOOLEAN) {
					target.value = Boolean(cell.v);
				} else if (cell.v != null) {
					target.value = cell.v;
				}
				const style = resolveStyle(cell, snapshot.styles);
				if (style) univerStyleToExcel(target, style);
			}
		}
		for (const [cStr, col] of Object.entries(sheet.columnData ?? {})) {
			if (col.w != null) ws.getColumn(Number(cStr) + 1).width = PX_TO_CHAR(col.w);
		}
		for (const [rStr, rowMeta] of Object.entries(sheet.rowData ?? {})) {
			if (rowMeta.h != null) ws.getRow(Number(rStr) + 1).height = rowMeta.h * 3 / 4;
		}
	}
	if (wb.worksheets.length === 0) wb.addWorksheet("Sheet1");
	return wb;
}

export async function univerSnapshotToXlsxBytes(snapshot: UniverWorkbookData, name: string): Promise<Uint8Array> {
	const wb = univerToExcelJs(snapshot, name);
	const buf = await wb.xlsx.writeBuffer();
	return new Uint8Array(buf as ArrayBuffer);
}
