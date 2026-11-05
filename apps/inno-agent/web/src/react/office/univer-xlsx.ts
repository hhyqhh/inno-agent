/** ExcelJS ↔ Univer conversion and complete workbook export. */
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
    ul?: { s?: number };
    st?: { s?: number };
    va?: number;
    tr?: { a?: number; v?: number };
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
    p?: {
        body?: {
            dataStream?: string;
            textRuns?: { st: number; ed: number; ts?: Record<string, unknown> }[];
            paragraphs?: { bullet?: unknown; [key: string]: unknown }[];
            customRanges?: unknown[];
            customBlocks?: unknown[];
            tables?: unknown[];
        };
        drawings?: Record<string, unknown>;
    };
	s?: UniverStyle | string;
}

interface UniverAxisData {
    h?: number;
    ah?: number;
    ia?: number;
    w?: number;
    hd?: number;
    s?: UniverStyle | string | null;
}

interface UniverSheetData {
    hidden?: number;
	scrollTop?: number;
	scrollLeft?: number;
	zoomRatio?: number;
	id: string;
	name: string;
	rowCount: number;
	columnCount: number;
	cellData: Record<number, Record<number, UniverCell>>;
	mergeData?: Array<{ startRow: number; endRow: number; startColumn: number; endColumn: number }>;
	columnData?: Record<number, UniverAxisData>;
	rowData?: Record<number, UniverAxisData>;
}

export interface UniverWorkbookData {
	dateSystem?: "date1900" | "date1904";
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

function excelStyleToUniver(cell: Partial<Pick<ExcelJS.Cell, "style" | "font" | "fill" | "alignment" | "numFmt" | "border">>): UniverStyle | undefined {
	const style = cell.style ?? cell;
	const out: UniverStyle = {};
	const font = style.font;
	if (font) {
		if (font.name) out.ff = font.name;
		if (typeof font.size === "number") out.fs = font.size;
		if (font.bold) out.bl = 1;
		if (font.italic) out.it = 1;
        if (font.underline) out.ul = { s: 1 };
        if (font.strike) out.st = { s: 1 };
        if (font.vertAlign) out.va = font.vertAlign === "superscript" ? 3 : 2;
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
        if (typeof alignment.textRotation === "number") out.tr = { a: alignment.textRotation };
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
		if (ws.rowCount > MAX_ROWS || ws.columnCount > MAX_COLS) {
            throw new Error(`Workbook exceeds editor limits (${MAX_ROWS} rows / ${MAX_COLS} columns). The original file is unchanged.`);
        }
        const rowCount = ws.rowCount;
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
					if (("formula" in raw || "sharedFormula" in raw) && typeof cell.formula === "string") {
						out.f = `=${cell.formula}`;
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
                        // Dates are numeric Excel values, including fractional
                        // days. Flattening them to strings breaks date formulas.
                        out.v = raw.getTime() / 86_400_000 + 25569;
                        // The editor supports both epochs; preserving saves keep the
                        // original workbookPr, so numeric dates must use its epoch.
                        if (workbook.properties.date1904) out.v -= 1462;
                        else if (out.v < 61) out.v--;
                        out.t = T_NUMBER;
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
		const columnData: Record<number, UniverAxisData> = {};
		for (let c = 1; c <= columnCount; c++) {
			const col = ws.getColumn(c);
            columnData[c - 1] = { ...(col.width != null ? { w: CHAR_TO_PX(col.width) } : {}), ...(col.hidden ? { hd: 1 } : {}), s: excelStyleToUniver(col) };
		}
		const rowData: Record<number, UniverAxisData> = {};
		for (let r = 1; r <= rowCount; r++) {
			const row = ws.getRow(r);
            rowData[r - 1] = { ...(row.height != null ? { h: Math.round(row.height * 4 / 3) } : {}), ...(row.hidden ? { hd: 1 } : {}), s: excelStyleToUniver(row) };
		}
		sheets[id] = {
			id,
			name: (ws.name || `Sheet${i + 1}`).slice(0, 31),
            hidden: ws.state === "veryHidden" ? 2 : ws.state === "hidden" ? 1 : 0,
			rowCount: Math.max(rowCount, 100),
			columnCount: Math.max(columnCount, 26),
			cellData,
			mergeData,
			columnData,
			rowData,
		};
		sheetOrder.push(id);
	});
	return { id: `wb-${Date.now()}`, name, sheetOrder, sheets, dateSystem: workbook.properties.date1904 ? "date1904" : "date1900" };
}

function resolveStyle(cell: { s?: UniverStyle | string | null }, styles?: Record<string, UniverStyle | null>): UniverStyle | undefined {
	if (!cell.s) return undefined;
	if (typeof cell.s === "string") return styles?.[cell.s] ?? undefined;
	return cell.s;
}

function univerFontToExcel(style: UniverStyle): Partial<ExcelJS.Font> {
	const font: Partial<ExcelJS.Font> = {};
	if (style.ff) font.name = style.ff;
	if (typeof style.fs === "number") font.size = style.fs;
	if (style.bl != null) font.bold = style.bl === 1;
	if (style.it != null) font.italic = style.it === 1;
    if (style.ul) font.underline = Boolean(style.ul.s);
    if (style.st) font.strike = Boolean(style.st.s);
    if (style.va != null) font.vertAlign = style.va === 3 ? "superscript" : style.va === 2 ? "subscript" : undefined;
	if (style.cl?.rgb) font.color = { argb: rgbToArgb(style.cl.rgb) };
	return font;
}

function univerStyleToExcel(cell: Partial<Pick<ExcelJS.Cell, "font" | "fill" | "alignment" | "numFmt" | "border">>, style: UniverStyle): void {
    const font = univerFontToExcel(style);
    if (Object.keys(font).length) cell.font = font;
	if (style.bg?.rgb) {
		cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: rgbToArgb(style.bg.rgb) } };
	}
	const alignment: Partial<ExcelJS.Alignment> = {};
	if (style.ht === HT_LEFT) alignment.horizontal = "left";
	else if (style.ht === HT_CENTER) alignment.horizontal = "center";
	else if (style.ht === HT_RIGHT) alignment.horizontal = "right";
    else if (style.ht === 4 || style.ht === 5) alignment.horizontal = "justify";
    else if (style.ht === 6) alignment.horizontal = "distributed";
	if (style.vt === VT_TOP) alignment.vertical = "top";
	else if (style.vt === VT_MIDDLE) alignment.vertical = "middle";
	else if (style.vt === VT_BOTTOM) alignment.vertical = "bottom";
	if (style.tb != null) alignment.wrapText = style.tb === TB_WRAP;
    if (style.tr?.a != null) alignment.textRotation = style.tr.a;
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
	wb.properties.date1904 = snapshot.dateSystem === "date1904";
	for (const sheetId of snapshot.sheetOrder) {
		const sheet = snapshot.sheets[sheetId];
		if (!sheet) continue;
		const ws = wb.addWorksheet(sheet.name.slice(0, 31) || `Sheet${sheetId}`);
        ws.state = sheet.hidden === 2 ? "veryHidden" : sheet.hidden === 1 ? "hidden" : "visible";
        // Univer keeps whole-axis formatting and visibility outside cellData.
        // Exporting only cells silently lost these enabled editor actions.
        for (const [c, meta] of Object.entries(sheet.columnData ?? {})) {
            const col = ws.getColumn(Number(c) + 1), style = resolveStyle(meta, snapshot.styles);
            if (style) univerStyleToExcel(col, style);
            col.hidden = meta.hd === 1;
            if (meta.w != null) col.width = PX_TO_CHAR(meta.w);
        }
        for (const [r, meta] of Object.entries(sheet.rowData ?? {})) {
            const row = ws.getRow(Number(r) + 1), style = resolveStyle(meta, snapshot.styles);
            if (style) univerStyleToExcel(row, style);
            row.hidden = meta.hd === 1;
            const height = meta.ia === 1 ? meta.ah ?? meta.h : meta.h;
            if (height != null) row.height = height * 3 / 4;
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
				} else if (typeof cell.p?.body?.dataStream === "string") {
                    // Univer stores rich cell input in a document body. Keep
                    // its text even when the formatting subset is unsupported.
                    const text = cell.p.body.dataStream.replace(/\r\n$/, "");
                    const runs = cell.p.body.textRuns ?? [];
                    const boundaries = [...new Set([0, text.length, ...runs.flatMap(run => [Math.min(text.length, Math.max(0, run.st)), Math.min(text.length, Math.max(0, run.ed))])])].sort((a, b) => a - b);
                    if (!runs.length) target.value = text.replace(/\r/g, "\n");
                    else target.value = { richText: boundaries.slice(0, -1).filter((start, i) => start < boundaries[i + 1]).map((start, i) => {
                        const format = Object.assign({}, ...runs.filter(run => run.st <= start && run.ed > start).map(run => run.ts));
                        // Reuse the same font mapping for inline and cell styles.
                        const font = univerFontToExcel(format);
                        return { text: text.slice(start, boundaries[i + 1]).replace(/\r/g, "\n"), ...(Object.keys(font).length ? { font } : {}) };
                    }) };
                } else if (cell.t === T_BOOLEAN) {
					target.value = Boolean(cell.v);
				} else if (cell.v != null) {
					target.value = cell.v;
				}
				const style = composedCellStyle(sheet, Number(rStr), Number(cStr), snapshot.styles);
                univerStyleToExcel(target, style);
			}
		}
        // Populate before merging: ExcelJS redirects slave-cell writes to the
        // master, so stale imported slave values used to undo a master edit.
		for (const merge of sheet.mergeData ?? []) {
			ws.mergeCells(merge.startRow + 1, merge.startColumn + 1, merge.endRow + 1, merge.endColumn + 1);
		}

	}
	if (wb.worksheets.length === 0) wb.addWorksheet("Sheet1");
	return wb;
}

function composedCellStyle(sheet: UniverSheetData, row: number, col: number, styles?: UniverWorkbookData["styles"]): UniverStyle {
    return { ...resolveStyle(sheet.columnData?.[col] ?? {}, styles), ...resolveStyle(sheet.rowData?.[row] ?? {}, styles), ...resolveStyle(sheet.cellData?.[row]?.[col] ?? {}, styles) };
}

function applyStyleChanges(target: { style: Partial<ExcelJS.Style> }, converted: { style: Partial<ExcelJS.Style> }, oldStyle: UniverStyle, nextStyle: UniverStyle): void {
    const equal = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    const changed = new Set(Object.keys({ ...oldStyle, ...nextStyle }).filter(key => !equal((oldStyle as any)[key], (nextStyle as any)[key])));
    target.style = structuredClone(target.style);
    for (const [key, group, property] of [
        ["ff", "font", "name"], ["fs", "font", "size"], ["bl", "font", "bold"], ["it", "font", "italic"], ["cl", "font", "color"], ["ul", "font", "underline"], ["st", "font", "strike"], ["va", "font", "vertAlign"],
        ["ht", "alignment", "horizontal"], ["vt", "alignment", "vertical"], ["tb", "alignment", "wrapText"], ["tr", "alignment", "textRotation"],
    ]) if (changed.has(key)) {
        const style = target.style as any, renderedStyle = converted.style as any;
        style[group] = { ...style[group] };
        if (renderedStyle[group]?.[property] === undefined) delete style[group][property];
        else style[group][property] = renderedStyle[group][property];
    }
    if (changed.has("bg")) target.style.fill = converted.style.fill;
    if (changed.has("bd")) {
        const border = { ...target.style.border };
        for (const [key, edge] of [["t", "top"], ["r", "right"], ["b", "bottom"], ["l", "left"]] as const) {
            if (!equal(oldStyle.bd?.[key], nextStyle.bd?.[key])) {
                if (converted.style.border?.[edge]) border[edge] = converted.style.border[edge];
                else delete border[edge];
            }
        }
        target.style.border = border;
    }
    if (changed.has("n")) target.style.numFmt = converted.style.numFmt || "General";
}

/** Native ExcelJS serialization keeps the loaded workbook's supported objects.
 * Apply model differences to it, rather than discarding images/comments and
 * source theme fonts just because the view converter does not expose them. */
export async function univerSnapshotToXlsxBytes(snapshot: UniverWorkbookData, name: string, imported?: { bytes: Uint8Array; baseline: UniverWorkbookData }): Promise<Uint8Array> {
    const generated = univerToExcelJs(snapshot, name);
    let wb = generated;
    if (imported) {
        wb = new ExcelJS.Workbook();
        await wb.xlsx.load(imported.bytes.slice().buffer as ArrayBuffer);
        const originals = wb.worksheets;
        // A source shared-formula slave cannot survive replacing its master.
        // Translate the group before edits, retaining every dependent formula.
        for (const ws of originals) ws.eachRow(row => row.eachCell(cell => {
            const value = cell.value;
            if (value && typeof value === "object" && ("sharedFormula" in value || ("shareType" in value && value.shareType === "shared"))) {
                cell.value = { formula: cell.formula, result: cell.result };
            }
        }));
        const sheets = new Map(imported.baseline.sheetOrder.map((id, index) => [id, originals[index]]));
        // Temporary names allow swaps/renames without duplicate-name failures.
        for (const sheet of originals) sheet.name = `__inno_export_${sheet.id}`;
        for (const [id, sheet] of sheets) if (!snapshot.sheetOrder.includes(id) && sheet) wb.removeWorksheet(sheet.id);
        const order: ExcelJS.Worksheet[] = [];
        const equal = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
        for (const [index, id] of snapshot.sheetOrder.entries()) {
            const current = snapshot.sheets[id], baseline = imported.baseline.sheets[id];
            const ws = sheets.get(id) ?? wb.addWorksheet(current.name);
            ws.name = current.name; order.push(ws);
            const rendered = generated.worksheets[index];
            for (const range of [...ws.model.merges]) ws.unMergeCells(range);
            const rows = new Set([...Object.keys(baseline?.cellData ?? {}), ...Object.keys(current.cellData ?? {})]);
            for (const row of rows) {
                const beforeRow = baseline?.cellData[Number(row)] ?? {}, afterRow = current.cellData[Number(row)] ?? {};
                for (const col of new Set([...Object.keys(beforeRow), ...Object.keys(afterRow)])) {
                    const before = beforeRow[Number(col)] ?? {}, after = afterRow[Number(col)] ?? {};
                    const target = ws.getCell(Number(row) + 1, Number(col) + 1), converted = rendered.getCell(Number(row) + 1, Number(col) + 1);
                    const value = (cell: UniverCell) => ({ v: cell.v, t: cell.t, f: cell.f, p: cell.p });
                    if (!equal(value(before), value(after))) target.value = converted.value;
                    const oldStyle = baseline ? composedCellStyle(baseline, Number(row), Number(col), imported.baseline.styles) : {}, nextStyle = composedCellStyle(current, Number(row), Number(col), snapshot.styles);
                    applyStyleChanges(target, converted, oldStyle, nextStyle);
                }
            }
            ws.state = rendered.state;
            for (const [axis, previous, next] of [
                ["row", baseline?.rowData, current.rowData], ["column", baseline?.columnData, current.columnData],
            ] as const) for (const key of new Set([...Object.keys(previous ?? {}), ...Object.keys(next ?? {})])) {
                const i = Number(key), meta = next?.[i] ?? {};
                // ExcelJS Row has style at runtime, but omits it from its public type.
                const target = (axis === "row" ? ws.getRow(i + 1) : ws.getColumn(i + 1)) as (ExcelJS.Row | ExcelJS.Column) & { style: Partial<ExcelJS.Style> };
                const converted = (axis === "row" ? rendered.getRow(i + 1) : rendered.getColumn(i + 1)) as (ExcelJS.Row | ExcelJS.Column) & { style: Partial<ExcelJS.Style> };
                applyStyleChanges(target, converted, resolveStyle(previous?.[i] ?? {}, imported.baseline.styles) ?? {}, resolveStyle(meta, snapshot.styles) ?? {});
                target.hidden = meta.hd === 1;
                if (axis === "row") ws.getRow(i + 1).height = rendered.getRow(i + 1).height ?? 15;
                else ws.getColumn(i + 1).width = rendered.getColumn(i + 1).width ?? 8.43;
            }
            for (const merge of current.mergeData ?? []) ws.mergeCells(merge.startRow + 1, merge.startColumn + 1, merge.endRow + 1, merge.endColumn + 1);
        }
        const model = wb.model;
        // ExcelJS's published WorkbookModel types invert worksheets/sheets;
        // its runtime setter consumes WorksheetModel[] for both arrays.
        // Worksheet.model emits merges; its setter consumes mergeCells.
        // Supply that field when reordering so saved merges survive reload.
        const orderedModels = order.map(sheet => ({ ...sheet.model, mergeCells: sheet.model.merges }));
        model.worksheets = orderedModels as unknown as typeof model.worksheets;
        model.sheets = orderedModels;
        wb.model = model;
    }
    wb.calcProperties.fullCalcOnLoad = true;
    const buf = await wb.xlsx.writeBuffer();
    return new Uint8Array(buf as ArrayBuffer);
}
