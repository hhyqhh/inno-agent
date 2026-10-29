// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import ExcelJS from "exceljs";
import { excelJsToUniver } from "./univer-xlsx.js";
import { preservePptx, preserveXlsx, type PptxSnapshot } from "./office-ooxml.js";
const SS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const parse = (text: string) => new DOMParser().parseFromString(text, "application/xml");
async function sameParts(before: Uint8Array, after: Uint8Array, changed: string[]) {
    const a = await JSZip.loadAsync(before), b = await JSZip.loadAsync(after);
    expect(Object.keys(b.files).sort()).toEqual(Object.keys(a.files).sort());
    for (const [path, part] of Object.entries(a.files)) {
        if (!changed.includes(path)) expect(await b.file(path)?.async("uint8array"), path).toEqual(part.dir ? undefined : await part.async("uint8array"));
    }
}
async function xlsx() {
    const wb = new ExcelJS.Workbook(), ws = wb.addWorksheet("原始表");
    ws.getCell("A1").value = "original";
    ws.getCell("B1").value = { formula: "1+1", result: 2 };
    ws.getCell("C1").value = true;
    ws.getCell("A2").value = { richText: [{ text: "keep", font: { bold: true } }, { text: " rich" }] };
    ws.getCell("B2").value = { text: "website", hyperlink: "https://example.com" };
    ws.getCell("A1").font = { bold: true, underline: true, color: { theme: 4 } };
    ws.getCell("A1").alignment = { textRotation: 45, indent: 2 };
    ws.getCell("D1").dataValidation = { type: "whole", operator: "between", formulae: [0, 100] };
    ws.addConditionalFormatting({ ref: "A1:A10", rules: [{ type: "expression", formulae: ["A1>0"], priority: 1, style: { font: { bold: true } } }] });
    ws.getCell("A1").note = "original comment";
    ws.mergeCells("F1:G1"); ws.getColumn(1).width = 30; ws.getRow(1).height = 40;
    const id = wb.addImage({ base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", extension: "png" });
    ws.addImage(id, "H1:I3");
    const raw = new Uint8Array(await wb.xlsx.writeBuffer() as ArrayBuffer);
    const zip = await JSZip.loadAsync(raw);
    // The editor does not understand these parts. Their preservation must not
    // depend on what ExcelJS/Univer happen to import.
    zip.file("xl/charts/chart42.xml", '<chart xmlns="urn:test">original chart data</chart>');
    zip.file("xl/pivotTables/pivotTable1.xml", '<pivotTable xmlns="urn:test">original pivot</pivotTable>');
    const original = await zip.generateAsync({ type: "uint8array" });
    return { original, baseline: excelJsToUniver(wb, "test.xlsx") };
}
describe("preserving XLSX edits", () => {
    it("patches values/formulas while retaining all unrelated parts and original cell formatting", async () => {
        const { original, baseline } = await xlsx(), current = structuredClone(baseline);
        current.sheets["sheet-1"].cellData[0][0].v = "  edited <&> 中文  ";
        current.sheets["sheet-1"].cellData[0][1].f = "=2+3";
        current.sheets["sheet-1"].cellData[0][2].v = 0;
        current.sheets["sheet-1"].cellData[3] = { 3: { v: 99, t: 2 } };
        const result = await preserveXlsx(original, baseline, current);
        await sameParts(original, result, ["xl/worksheets/sheet1.xml", "xl/workbook.xml"]);
        const before = await JSZip.loadAsync(original), after = await JSZip.loadAsync(result);
        const a = parse(await before.file("xl/worksheets/sheet1.xml")!.async("string"));
        const b = parse(await after.file("xl/worksheets/sheet1.xml")!.async("string"));
        for (const tag of ["conditionalFormatting", "dataValidations", "mergeCells", "drawing", "hyperlinks", "cols"]) expect(b.getElementsByTagNameNS(SS, tag)[0]?.outerHTML, tag).toBe(a.getElementsByTagNameNS(SS, tag)[0]?.outerHTML);
        expect(b.querySelector('c[r="A1"]')!.getAttribute("s")).toBe(a.querySelector('c[r="A1"]')!.getAttribute("s"));
        const wb = new ExcelJS.Workbook(); await wb.xlsx.load(result as any);
        expect(wb.worksheets[0].getCell("A1").value).toBe("  edited <&> 中文  ");
        expect(wb.worksheets[0].getCell("B1").formula).toBe("2+3");
        expect(wb.worksheets[0].getCell("C1").value).toBe(false);
        expect(wb.worksheets[0].getCell("D4").value).toBe(99);
        expect(wb.worksheets[0].getImages()).toHaveLength(1);
        expect(wb.worksheets[0].getCell("A1").font.underline).toBe(true);
    });

    it("accepts the input view color without changing an original theme font, and ignores view scrolling", async () => {
        const { original, baseline } = await xlsx(), current = structuredClone(baseline);
        const sheet = current.sheets["sheet-1"];
        sheet.cellData[0][0].v = "typed";
        sheet.cellData[0][0].s = { ...(sheet.cellData[0][0].s as object), cl: { rgb: "#123456" } };
        sheet.scrollTop = 50; sheet.zoomRatio = 1.5;
        const result = await preserveXlsx(original, baseline, current, "#123456"), wb = new ExcelJS.Workbook();
        await wb.xlsx.load(result as any);
        expect(wb.worksheets[0].getCell("A1").value).toBe("typed");
        expect(wb.worksheets[0].getCell("A1").font.color).toEqual({ theme: 4 });
        await expect(preserveXlsx(original, baseline, current)).rejects.toThrow("Cell formatting");
    });
    it("returns the exact original when nothing changed, including recalculated formula caches", async () => {
        const { original, baseline } = await xlsx(), current = structuredClone(baseline);
        current.sheets["sheet-1"].cellData[0][1].v = 123;
        expect(await preserveXlsx(original, baseline, current)).toEqual(original);
    });
    it.each(["style", "row", "merge", "sheet", "rich", "link"])("refuses unsupported %s changes", async (kind) => {
        const { original, baseline } = await xlsx(), current = structuredClone(baseline), sheet = current.sheets["sheet-1"];
        if (kind === "style") sheet.cellData[0][0].s = { bl: 0 };
        if (kind === "row") sheet.rowCount++;
        if (kind === "merge") sheet.mergeData = [];
        if (kind === "sheet") sheet.name = "renamed";
        if (kind === "rich") sheet.cellData[1][0].v = "flatten";
        if (kind === "link") sheet.cellData[1][1].v = "changed";
        await expect(preserveXlsx(original, baseline, current)).rejects.toThrow("Cannot preserve");
    });
    it("maps sheet relationship targets instead of guessing their filenames", async () => {
        const { original, baseline } = await xlsx(), current = structuredClone(baseline), zip = await JSZip.loadAsync(original);
        const sheet = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
        zip.remove("xl/worksheets/sheet1.xml"); zip.file("xl/worksheets/custom.xml", sheet);
        zip.file("xl/_rels/workbook.xml.rels", (await zip.file("xl/_rels/workbook.xml.rels")!.async("string")).replace("worksheets/sheet1.xml", "worksheets/custom.xml"));
        current.sheets["sheet-1"].cellData[0][0].v = "changed";
        const result = await JSZip.loadAsync(await preserveXlsx(await zip.generateAsync({ type: "uint8array" }), baseline, current));
        expect(await result.file("xl/worksheets/custom.xml")!.async("string")).toContain("changed");
    });
    it.each(["shared", "array"])("rejects edits inside a %s formula range", async (type) => {
        const { original, baseline } = await xlsx(), current = structuredClone(baseline), zip = await JSZip.loadAsync(original);
        zip.file("xl/worksheets/sheet1.xml", (await zip.file("xl/worksheets/sheet1.xml")!.async("string")).replace("<f>", `<f t="${type}" ref="B1:D4">`));
        current.sheets["sheet-1"].cellData[3] = { 3: { v: 3 } };
        await expect(preserveXlsx(await zip.generateAsync({ type: "uint8array" }), baseline, current)).rejects.toThrow("Complex formula range");
    });

    it("keeps the original 1904 epoch while editing a date", async () => {
        const wb = new ExcelJS.Workbook(); wb.properties.date1904 = true;
        const ws = wb.addWorksheet("Dates"); ws.getCell("A1").value = new Date("2026-10-26T12:00:00Z"); ws.getCell("A1").numFmt = "yyyy-mm-dd hh:mm";
        const original = new Uint8Array(await wb.xlsx.writeBuffer() as ArrayBuffer);
        const baseline = excelJsToUniver(wb, "dates.xlsx"), current = structuredClone(baseline);
        expect(baseline.dateSystem).toBe("date1904");
        current.sheets["sheet-1"].cellData[0][0].v = Number(baseline.sheets["sheet-1"].cellData[0][0].v) + 1;
        const result = await preserveXlsx(original, baseline, current), parsed = new ExcelJS.Workbook();
        await parsed.xlsx.load(result as any);
        expect(parsed.properties.date1904).toBe(true);
        expect(parsed.worksheets[0].getCell("A1").value).toEqual(new Date("2026-10-27T12:00:00Z"));
    });
    it("refuses characters that would make the saved XML invalid", async () => {
        const { original, baseline } = await xlsx(), current = structuredClone(baseline);
        current.sheets["sheet-1"].cellData[0][0].v = "bad" + String.fromCharCode(0);
        await expect(preserveXlsx(original, baseline, current)).rejects.toThrow("Invalid XML text");
    });
    it("removes obsolete calculation chain references after editing a value", async () => {
        const { original, baseline } = await xlsx(), current = structuredClone(baseline), zip = await JSZip.loadAsync(original);
        zip.file("xl/calcChain.xml", `<calcChain xmlns="${SS}"/>`);
        zip.file("xl/_rels/workbook.xml.rels", (await zip.file("xl/_rels/workbook.xml.rels")!.async("string")).replace("</Relationships>", `<Relationship Id="calc" Target="calcChain.xml" Type="${R}/calcChain"/></Relationships>`));
        zip.file("[Content_Types].xml", (await zip.file("[Content_Types].xml")!.async("string")).replace("</Types>", '<Override PartName="/xl/calcChain.xml" ContentType="application/test"/></Types>'));
        current.sheets["sheet-1"].cellData[0][0].v = "new";
        const result = await JSZip.loadAsync(await preserveXlsx(await zip.generateAsync({ type: "uint8array" }), baseline, current));
        expect(result.file("xl/calcChain.xml")).toBeNull();
        expect(await result.file("xl/_rels/workbook.xml.rels")!.async("string")).not.toContain("calcChain");
        expect(await result.file("[Content_Types].xml")!.async("string")).not.toContain("calcChain");
        expect(await result.file("xl/workbook.xml")!.async("string")).toContain('fullCalcOnLoad="1"');
    });
});
const textElement = (id: string, content: string) => ({ id, type: "text", content, left: 12, top: 20, width: 80, height: 50, fixedHeight: true });
async function pptx(text = "Original") {
    const zip = new JSZip();
    zip.file("ppt/presentation.xml", `<p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldIdLst><p:sldId id="256" r:id="rId7"/></p:sldIdLst></p:presentation>`);
    zip.file("ppt/_rels/presentation.xml.rels", `<Relationships xmlns="${REL}"><Relationship Id="rId7" Target="slides/custom.xml" Type="${R}/slide"/></Relationships>`);
    zip.file("ppt/slides/custom.xml", `<p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="9" name="original"/></p:nvSpPr><p:spPr><a:xfrm rot="60000"/></p:spPr><p:txBody><a:bodyPr/><a:p><a:pPr marL="10"/><a:r><a:rPr lang="zh-CN" b="1"/><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp><p:pic><p:blipFill><a:blip r:embed="image"/></p:blipFill></p:pic><p:graphicFrame><a:graphic/></p:graphicFrame></p:spTree></p:cSld><p:timing><p:tnLst/></p:timing></p:sld>`);
    zip.file("ppt/media/image1.png", new Uint8Array([0, 128, 255]));
    zip.file("ppt/charts/chart1.xml", '<chart xmlns="urn:test">original</chart>');
    zip.file("ppt/notesSlides/notesSlide1.xml", '<notes xmlns="urn:test">original notes</notes>');
    zip.file("ppt/slides/_rels/custom.xml.rels", `<Relationships xmlns="${REL}"><Relationship Id="image" Target="../media/image1.png" Type="${R}/image"/></Relationships>`);
    const baseline: PptxSnapshot = { slides: [{ id: "random-slide", elements: [textElement("random-text", `<p><span style="font-size:20px">${text}</span></p>`)] }], theme: { fontName: "Arial" }, viewportSize: 960, viewportRatio: 0.5625 };
    return { original: await zip.generateAsync({ type: "uint8array" }), baseline };
}
describe("preserving PPTX edits", () => {
    it("changes only uniquely mapped plain text, preserving images, charts, notes, animations, geometry and run styles", async () => {
        const { original, baseline } = await pptx(), current = structuredClone(baseline);
        current.slides[0].elements[0].content = '<p><span style="font-size:20px">Edited &amp; 中文</span></p>';
        const result = await preservePptx(original, baseline, current);
        await sameParts(original, result, ["ppt/slides/custom.xml"]);
        const zip = await JSZip.loadAsync(result), doc = parse(await zip.file("ppt/slides/custom.xml")!.async("string"));
        expect(doc.getElementsByTagNameNS(A, "t")[0].textContent).toBe("Edited & 中文");
        expect(doc.getElementsByTagNameNS(A, "rPr")[0].getAttribute("b")).toBe("1");
        expect(doc.getElementsByTagNameNS(A, "xfrm")[0].getAttribute("rot")).toBe("60000");
        expect(doc.getElementsByTagNameNS(P, "timing")).toHaveLength(1);
    });

    it("accepts ProseMirror's equivalent bold/color markup for text imported as a shape", async () => {
        const { original, baseline } = await pptx(), old = baseline.slides[0].elements[0];
        baseline.slides[0].elements[0] = { ...old, type: "shape", content: undefined, text: { content: '<p style="text-align:left"><span style="color:#222222;font-weight:bold;font-size:20px">Original</span></p>', align: "middle" } };
        const current = structuredClone(baseline);
        (current.slides[0].elements[0].text as { content: string }).content = '<p style=""><strong><span style="font-size:20px"><span style="color:rgb(34,34,34)">Edited</span></span></strong></p>';
        const result = await JSZip.loadAsync(await preservePptx(original, baseline, current));
        expect(await result.file("ppt/slides/custom.xml")!.async("string")).toContain(">Edited</a:t>");
    });
    it("returns the exact source for an untouched draft", async () => {
        const { original, baseline } = await pptx();
        expect(await preservePptx(original, baseline, structuredClone(baseline))).toEqual(original);
    });
    it.each(["position", "style", "new object", "reorder", "notes", "paragraph"])("refuses unsupported %s changes", async (kind) => {
        const { original, baseline } = await pptx(), current = structuredClone(baseline), el = current.slides[0].elements[0];
        if (kind === "position") el.left = 13;
        if (kind === "style") el.content = '<p><b>Edited</b></p>';
        if (kind === "new object") current.slides[0].elements.push(textElement("new", "<p>new</p>"));
        if (kind === "reorder") current.slides[0].id = "new-slide";
        if (kind === "notes") current.slides[0].remark = "edited notes";
        if (kind === "paragraph") el.content = '<p>one</p><p>two</p>';
        await expect(preservePptx(original, baseline, current)).rejects.toThrow("Cannot preserve");
    });
    it.each(["duplicate", "multiple runs", "field", "signature"])("refuses ambiguous or complex source text: %s", async (kind) => {
        const { original, baseline } = await pptx(), current = structuredClone(baseline), zip = await JSZip.loadAsync(original);
        let slide = await zip.file("ppt/slides/custom.xml")!.async("string");
        if (kind === "duplicate") slide = slide.replace("</p:spTree>", slide.match(/<p:sp>.*?<\/p:sp>/)![0] + "</p:spTree>");
        if (kind === "multiple runs") slide = slide.replace("<a:t>Original</a:t>", "<a:t>Ori</a:t></a:r><a:r><a:t>ginal</a:t>");
        if (kind === "field") slide = slide.replace("<a:r>", '<a:fld id="test">').replace("</a:r>", "</a:fld>");
        if (kind === "signature") zip.file("_xmlsignatures/sig1.xml", "signed");
        zip.file("ppt/slides/custom.xml", slide);
        current.slides[0].elements[0].content = '<p><span style="font-size:20px">Edited</span></p>';
        await expect(preservePptx(await zip.generateAsync({ type: "uint8array" }), baseline, current)).rejects.toThrow("Cannot preserve");
    });
});
