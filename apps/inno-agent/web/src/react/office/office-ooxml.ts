/** Patch supported edits into the original package, rather than rebuilding it
 * from the editors' incomplete imports. Unchanged ZIP parts stay byte-identical.
 */
import JSZip from "jszip";
import type { UniverCell, UniverWorkbookData } from "./univer-xlsx.js";

const SS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
function fail(reason: string): never { throw new Error(`无法保真保存 / Cannot preserve this edit: ${reason}`); }
function validText(text: string): string {
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/u.test(text) || Array.from(text).some(char => { const cp = char.codePointAt(0)!; return cp >= 0xD800 && cp <= 0xDFFF; })) fail("文字包含无效 XML 字符 / Invalid XML text");
    return text;
}
const all = (node: Document | Element, ns: string, name: string) => Array.from(node.getElementsByTagNameNS(ns, name));
const children = (node: Element, name: string) => Array.from(node.children).filter(el => el.localName === name && el.namespaceURI === node.namespaceURI);
const stable = (value: unknown): string => JSON.stringify(value, (_key, v) => v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).filter(([, val]) => val !== undefined && val !== null).sort(([a], [b]) => a.localeCompare(b))) : v);
const equal = (a: unknown, b: unknown) => stable(a) === stable(b);
function xml(text: string): Document {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    if (doc.querySelector("parsererror")) fail("原文件 XML 无法解析 / Invalid original XML");
    return doc;
}
async function read(zip: JSZip, path: string): Promise<Document> {
    const part = zip.file(path);
    if (!part) return fail(`原文件缺少部件 / Missing part: ${path}`);
    return xml(await part.async("string"));
}
const write = (zip: JSZip, path: string, doc: Document) => zip.file(path, new XMLSerializer().serializeToString(doc));
async function packageFor(bytes: Uint8Array): Promise<JSZip> {
    const zip = await JSZip.loadAsync(bytes);
    // Editing a signed package invalidates its signature. Do not silently
    // strip signatures or claim the resulting file remains signed.
    if (Object.keys(zip.files).some(path => path.startsWith("_xmlsignatures/"))) fail("不支持修改已签名文件 / Signed files are unsupported");
    return zip;
}
/** Resolve relationship targets, including custom part names, without guessing
 * sheet1.xml/slide1.xml: their numeric names need not match display order. */
async function orderedParts(zip: JSZip, parent: string, ns: string, listName: string, itemName: string): Promise<{ doc: Document; paths: string[] }> {
    const doc = await read(zip, parent);
    const slash = parent.lastIndexOf("/");
    const rels = await read(zip, `${parent.slice(0, slash + 1)}_rels/${parent.slice(slash + 1)}.rels`);
    const list = all(doc, ns, listName)[0];
    if (!list) return fail("原文件结构不受支持 / Unsupported package structure");
    const paths = children(list, itemName).map(item => {
        const id = item.getAttributeNS(R, "id");
        const matches = Array.from(rels.documentElement.children).filter(rel => rel.getAttribute("Id") === id);
        if (matches.length !== 1 || matches[0].getAttribute("TargetMode") === "External") return fail("无法映射原文件对象 / Unmapped relationship");
        const target = matches[0].getAttribute("Target") ?? "";
        if (!target || /[\\?#]/.test(target)) return fail("部件路径不受支持 / Unsupported part path");
        const segments: string[] = target.startsWith("/") ? [] : parent.slice(0, slash).split("/");
        for (const segment of target.split("/")) {
            if (segment === "..") { if (!segments.length) return fail("无效的部件路径 / Invalid part path"); segments.pop(); }
            else if (segment && segment !== ".") segments.push(segment);
        }
        return segments.join("/");
    });
    if (new Set(paths).size !== paths.length) fail("重复部件映射 / Duplicate part mapping");
    return { doc, paths };
}
const cellRef = (row: number, col: number) => {
    let letters = "";
    for (let c = col + 1; c; c = Math.floor((c - 1) / 26)) letters = String.fromCharCode(65 + (c - 1) % 26) + letters;
    return `${letters}${row + 1}`;
};
const refPosition = (ref: string): [number, number] => {
    const match = /^([A-Z]+)([1-9][0-9]*)$/.exec(ref);
    if (!match) return fail("无效单元格地址 / Invalid cell reference");
    let col = 0;
    for (const char of match[1]) col = col * 26 + char.charCodeAt(0) - 64;
    return [Number(match[2]) - 1, col - 1];
};
function cellValue(cell: UniverCell | undefined): { value?: string | number | boolean; formula?: string } {
    if (!cell) return {};
    if (cell.f) return { formula: cell.f.replace(/^=/, "") };
    if (cell.p) {
        // Rich text cannot be flattened safely. Plain input belongs in v;
        // refusing p avoids silently removing per-character formatting.
        return fail("暂不支持富文本单元格编辑 / Rich cell text is unsupported");
    }
    if (cell.v === undefined || cell.v === null || cell.v === "") return {};
    return { value: cell.t === 3 ? Boolean(cell.v) : cell.v };
}
const style = (cell: UniverCell | undefined, book: UniverWorkbookData) => {
    if (typeof cell?.s !== "string") return cell?.s ?? {};
    if (!Object.hasOwn(book.styles ?? {}, cell.s)) return fail("无法解析单元格格式 / Unresolved cell style");
    return book.styles?.[cell.s] ?? {};
};
function cellMeta(cell: UniverCell | undefined, book: UniverWorkbookData) {
    const { v: _v, t: _t, f: _f, p: _p, s: _s, ...other } = cell ?? {};
    return { ...other, s: style(cell, book) };
}
export async function preserveXlsx(original: Uint8Array, baseline: UniverWorkbookData, current: UniverWorkbookData, implicitTextColor?: string): Promise<Uint8Array> {
    if (baseline.dateSystem !== current.dateSystem) fail("日期系统不可修改 / Date system changes are unsupported");
    if (!equal(baseline.sheetOrder, current.sheetOrder) || !equal(Object.keys(baseline.sheets).sort(), Object.keys(current.sheets).sort())) fail("暂不支持增删或重排工作表 / Sheet structure changes are unsupported");
    const zip = await packageFor(original);
    const { doc: workbook, paths } = await orderedParts(zip, "xl/workbook.xml", SS, "sheets", "sheet");
    if (paths.length !== baseline.sheetOrder.length) fail("工作表无法一一映射 / Sheets cannot be mapped");
    let changed = false;
    let sharedStrings: Document | undefined;
    for (const [index, id] of baseline.sheetOrder.entries()) {
        const before = baseline.sheets[id], after = current.sheets[id];
        const { cellData: _bc, scrollTop: _bst, scrollLeft: _bsl, zoomRatio: _bz, ...beforeMeta } = before;
        const { cellData: _ac, scrollTop: _ast, scrollLeft: _asl, zoomRatio: _az, ...afterMeta } = after;
        if (!equal(beforeMeta, afterMeta)) fail("暂不支持工作表格式、行列或布局修改 / Sheet formatting and layout changes are unsupported");
        const updates: { row: number; col: number; cell?: UniverCell }[] = [];
        const rowKeys = new Set([...Object.keys(before.cellData ?? {}), ...Object.keys(after.cellData ?? {})]);
        for (const rowKey of rowKeys) {
            const row = Number(rowKey);
            const a = before.cellData?.[row] ?? {}, b = after.cellData?.[row] ?? {};
            for (const colKey of new Set([...Object.keys(a), ...Object.keys(b)])) {
                const col = Number(colKey), oldCell = a[col], newCell = b[col];
                const beforeCellMeta = cellMeta(oldCell, baseline), afterCellMeta = cellMeta(newCell, current);
                // Univer's formula/input document injects gray.900 as an inline
                // color even for plain typing (observed in the running editor).
                // Explicit formatting/paste commands are blocked by XlsxEditor;
                // this view-only default must not overwrite an original theme font.
                if (implicitTextColor && !beforeCellMeta.s.cl && afterCellMeta.s.cl?.rgb?.toUpperCase() === implicitTextColor.toUpperCase()) {
                    afterCellMeta.s = { ...afterCellMeta.s }; delete afterCellMeta.s.cl;
                }
                if (!equal(beforeCellMeta, afterCellMeta)) fail(`暂不支持单元格格式修改 / Cell formatting is unsupported: ${cellRef(row, col)}`);
                // Untouched rich text and shared formula imports must stay in
                // the original XML, even when the importer flattened them.
                if (equal(oldCell, newCell)) continue;
                if (equal(cellValue(oldCell), cellValue(newCell))) continue;
                if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0 || row >= before.rowCount || col >= before.columnCount) fail("编辑范围不受支持 / Unsupported edit range");
                updates.push({ row, col, cell: newCell });
            }
        }
        if (!updates.length) continue;
        const doc = await read(zip, paths[index]);
        const sheetData = all(doc, SS, "sheetData")[0];
        if (!sheetData) return fail("原工作表缺少单元格数据 / Missing sheet data");
        const formulas = all(doc, SS, "f");
        for (const update of updates) {
            const address = cellRef(update.row, update.col);
            // Shared/array/spill formulas can span cells without their own f.
            // Editing any cell inside their declared range would corrupt them.
            for (const formula of formulas) {
                const ref = formula.getAttribute("ref");
                if (!ref || !formula.getAttribute("t") || formula.getAttribute("t") === "normal") continue;
                const [start, end = start] = ref.split(":").map(refPosition);
                if (update.row >= start[0] && update.row <= end[0] && update.col >= start[1] && update.col <= end[1]) fail(`复杂公式区域不可编辑 / Complex formula range: ${address}`);
            }
            let row = children(sheetData, "row").find(el => Number(el.getAttribute("r")) === update.row + 1);
            if (!row) {
                row = doc.createElementNS(SS, "row"); row.setAttribute("r", String(update.row + 1));
                sheetData.insertBefore(row, children(sheetData, "row").find(el => Number(el.getAttribute("r")) > update.row + 1) ?? null);
            }
            let cell = children(row, "c").find(el => el.getAttribute("r") === address);
            if (!cell) {
                cell = doc.createElementNS(SS, "c"); cell.setAttribute("r", address);
                row.insertBefore(cell, children(row, "c").find(el => refPosition(el.getAttribute("r") ?? "")[1] > update.col) ?? null);
            }
            if (children(cell, "f").some(f => f.hasAttribute("t") && f.getAttribute("t") !== "normal") || cell.hasAttribute("cm") || cell.hasAttribute("vm")) fail(`复杂单元格不可编辑 / Complex cell: ${address}`);
            // Replacing rich text/hyperlink display or error values would discard
            // source semantics that the importer does not expose faithfully.
            if (cell.getAttribute("t") === "s") {
                sharedStrings ??= await read(zip, "xl/sharedStrings.xml");
                const entry = all(sharedStrings, SS, "si")[Number(children(cell, "v")[0]?.textContent)];
                if (!entry || all(entry, SS, "r").length) fail(`暂不支持富文本单元格编辑 / Rich shared string: ${address}`);
            }
            if (all(cell, SS, "r").length || children(cell, "v").length && cell.getAttribute("t") === "e") fail(`暂不支持富文本或错误单元格编辑 / Rich text or error cell: ${address}`);
            if (all(doc, SS, "hyperlink").some(link => link.getAttribute("ref") === address)) fail(`暂不支持超链接单元格编辑 / Hyperlink cell: ${address}`);
            for (const el of Array.from(cell.children)) if (el.namespaceURI === SS && ["f", "v", "is"].includes(el.localName)) el.remove();
            cell.removeAttribute("t");
            const value = cellValue(update.cell);
            const append = (name: string, text: string) => { const el = doc.createElementNS(SS, name); el.textContent = text; cell!.insertBefore(el, cell!.firstChild); return el; };
            if (value.formula !== undefined) append("f", validText(value.formula));
            else if (typeof value.value === "string") {
                cell.setAttribute("t", "inlineStr");
                const is = append("is", ""), text = doc.createElementNS(SS, "t");
                text.setAttributeNS("http://www.w3.org/XML/1998/namespace", "xml:space", "preserve"); text.textContent = validText(value.value); is.appendChild(text);
            } else if (value.value !== undefined) {
                if (typeof value.value === "number" && !Number.isFinite(value.value)) fail("数值无效 / Invalid numeric value");
                if (typeof value.value === "boolean") cell.setAttribute("t", "b");
                append("v", typeof value.value === "boolean" ? value.value ? "1" : "0" : String(value.value));
            }
        }
        const dimension = all(doc, SS, "dimension")[0];
        if (dimension) {
            const bounds = all(sheetData, SS, "c").reduce((b, el) => {
                const [r, c] = refPosition(el.getAttribute("r") ?? "");
                return [Math.min(b[0], r), Math.min(b[1], c), Math.max(b[2], r), Math.max(b[3], c)];
            }, [Infinity, Infinity, 0, 0]);
            dimension.setAttribute("ref", `${cellRef(bounds[0], bounds[1])}:${cellRef(bounds[2], bounds[3])}`);
        }
        write(zip, paths[index], doc); changed = true;
    }
    if (!changed) return original.slice();
    // Values can invalidate formula caches. Force Office to recalculate on
    // opening, and remove the obsolete chain plus its package references.
    let calc = all(workbook, SS, "calcPr")[0];
    if (!calc) { calc = workbook.createElementNS(SS, "calcPr"); workbook.documentElement.insertBefore(calc, all(workbook, SS, "extLst")[0] ?? null); }
    calc.setAttribute("fullCalcOnLoad", "1"); calc.setAttribute("forceFullCalc", "1");
    write(zip, "xl/workbook.xml", workbook);
    const relPath = "xl/_rels/workbook.xml.rels", rels = await read(zip, relPath);
    const chains = Array.from(rels.documentElement.children).filter(rel => rel.getAttribute("Type")?.endsWith("/calcChain"));
    if (chains.length) {
        const types = await read(zip, "[Content_Types].xml");
        for (const rel of chains) {
            // Standard calcChain target only; unusual targets are refused rather
            // than removed by a path guess that could leave dangling references.
            const target = rel.getAttribute("Target");
            if (target !== "calcChain.xml" && target !== "/xl/calcChain.xml") fail("计算链路径不受支持 / Unsupported calculation chain target");
            zip.remove("xl/calcChain.xml"); rel.remove();
            for (const part of Array.from(types.documentElement.children)) if (part.getAttribute("PartName") === "/xl/calcChain.xml") part.remove();
        }
        write(zip, relPath, rels); write(zip, "[Content_Types].xml", types);
    }
    return zip.generateAsync({ type: "uint8array" });
}

export interface PptxSnapshot {
    slides: { id: string; elements: { id: string; type: string; content?: string; [key: string]: unknown }[]; [key: string]: unknown }[];
    [key: string]: unknown;
}
function plainHtml(html: string): { text: string; skeleton: string } {
    const body = new DOMParser().parseFromString(html, "text/html").body;
    if (body.children.length !== 1 || body.firstElementChild?.tagName !== "P" || body.querySelector("br,img,table,ul,ol")) fail("仅支持单段纯文本 / Only single-paragraph plain text is supported");
    const formats: string[] = [];
    const visit = (node: Node, inherited: Record<string, string>) => {
        if (node.nodeType === Node.TEXT_NODE) {
            if (node.textContent) formats.push(stable(inherited));
            return;
        }
        if (!(node instanceof HTMLElement) || !["P", "SPAN", "STRONG", "B", "EM", "I", "U", "S", "STRIKE"].includes(node.tagName)) fail("文字标记不受支持 / Unsupported text markup");
        const format = { ...inherited };
        for (const attr of Array.from(node.attributes)) if (attr.name !== "style") format[`attr:${node.tagName}:${attr.name}`] = attr.value;
        for (const prop of Array.from(node.style)) format[prop] = node.style.getPropertyValue(prop);
        // ProseMirror normalizes a bold span into <strong> and canonicalizes
        // colors. Compare effective formatting, not wrapper/tag serialization.
        if (["STRONG", "B"].includes(node.tagName)) format["font-weight"] = "bold";
        if (["EM", "I"].includes(node.tagName)) format["font-style"] = "italic";
        if (node.tagName === "U") format["text-decoration"] = "underline";
        if (["S", "STRIKE"].includes(node.tagName)) format["text-decoration"] = "line-through";
        if (format["font-weight"] === "bold") format["font-weight"] = "700";
        if (["normal", "400"].includes(format["font-weight"])) delete format["font-weight"];
        if (format["font-style"] === "normal") delete format["font-style"];
        if (format["text-decoration"] === "none") delete format["text-decoration"];
        if (format["text-align"] === "left") delete format["text-align"];
        for (const child of Array.from(node.childNodes)) visit(child, format);
    };
    visit(body.firstElementChild!, {});
    if (new Set(formats).size !== 1) fail("仅支持格式一致的纯文本 / Only uniformly formatted plain text is supported");
    return { text: body.textContent ?? "", skeleton: formats[0] };
}
function pptText(element: PptxSnapshot["slides"][number]["elements"][number]): { content?: string; meta: unknown } {
    if (element.type === "text") {
        const { content, ...meta } = element;
        return { content, meta };
    }
    // pptxtojson imports many ordinary text boxes as shapes with a text body.
    // They still map to p:sp/a:t in the source, so use the same conservative gate.
    if (element.type === "shape" && element.text && typeof element.text === "object") {
        const { content, ...textMeta } = element.text as Record<string, unknown>;
        return { content: typeof content === "string" ? content : undefined, meta: { ...element, text: textMeta } };
    }
    return { meta: element };
}
export async function preservePptx(original: Uint8Array, baseline: PptxSnapshot, current: PptxSnapshot): Promise<Uint8Array> {
    const { slides: beforeSlides, ...beforeMeta } = baseline, { slides: afterSlides, ...afterMeta } = current;
    if (!equal(beforeMeta, afterMeta) || beforeSlides.length !== afterSlides.length) fail("暂不支持主题、画布或幻灯片结构修改 / Deck structure changes are unsupported");
    const zip = await packageFor(original);
    const { paths } = await orderedParts(zip, "ppt/presentation.xml", P, "sldIdLst", "sldId");
    if (paths.length !== beforeSlides.length) fail("幻灯片无法一一映射 / Slides cannot be mapped");
    let changed = false;
    for (const [index, before] of beforeSlides.entries()) {
        const after = afterSlides[index];
        const { elements: beforeElements, ...a } = before, { elements: afterElements, ...b } = after;
        if (!equal(a, b) || beforeElements.length !== afterElements.length) fail("暂不支持幻灯片布局或增删对象 / Slide layout and object changes are unsupported");
        let doc: Document | undefined;
        let sourceShapes: { node: Element; text: string }[] = [];
        for (const [elementIndex, oldElement] of beforeElements.entries()) {
            const newElement = afterElements[elementIndex];
            if (equal(oldElement, newElement)) continue;
            const { content: oldContent, meta: oldMeta } = pptText(oldElement), { content: newContent, meta: newMeta } = pptText(newElement);
            if (!equal(oldMeta, newMeta) || typeof oldContent !== "string" || typeof newContent !== "string") fail("暂不支持对象格式、位置或类型修改 / Object formatting and position changes are unsupported");
            const oldText = plainHtml(oldContent), newText = plainHtml(newContent);
            if (oldText.skeleton !== newText.skeleton) fail("暂不支持文字格式修改 / Text formatting changes are unsupported");
            if (oldText.text === newText.text) continue;
            if (!doc) {
                doc = await read(zip, paths[index]);
                sourceShapes = all(doc, P, "sp").filter(shape => all(shape, A, "t").length === 1 && all(shape, A, "p").length === 1 && !all(shape, A, "fld").length && !all(shape, A, "br").length).map(node => ({ node, text: all(node, A, "t")[0].textContent ?? "" }));
            }
            // PPTist assigns random IDs and flattens objects. Map only a unique
            // source text shape with one run; never guess by its array index.
            const shapes = sourceShapes.filter(shape => shape.text === oldText.text);
            const modelMatches = beforeElements.filter(el => { const { content } = pptText(el); return typeof content === "string" && new DOMParser().parseFromString(content, "text/html").body.textContent === oldText.text; });
            if (!oldText.text || shapes.length !== 1 || modelMatches.length !== 1) fail("原文字无法唯一映射或含复杂文本 / Source text is ambiguous or complex");
            all(shapes[0].node, A, "t")[0].textContent = validText(newText.text);
            changed = true;
        }
        if (doc) write(zip, paths[index], doc);
    }
    return changed ? zip.generateAsync({ type: "uint8array" }) : original.slice();
}
