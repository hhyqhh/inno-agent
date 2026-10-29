// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { docxBytesToDocument, univerDocToPreservedDocxBytes, univerDocToDocxBytes, type UniverDocSnapshot } from "./docx-univer.js";

function zipFile(xml: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${xml}</w:body></w:document>`;
}

/** Minimal hand-built docx so the parse path never depends on the writer. */
async function buildDocx(bodyXml: string, extra: Record<string, string> = {}): Promise<Uint8Array> {
	const zip = JSZip();
	zip.file(
		"[Content_Types].xml",
		`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>`,
	);
	zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
	zip.file("word/document.xml", zipFile(bodyXml));
	// Extra parts exercise the "everything but document.xml stays untouched" splice.
	zip.file("word/numbering.xml", `<?xml version="1.0"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:num w:numId="7"><w:abstractNumId w:val="0"/></w:num></w:numbering>`);
	zip.file("word/header1.xml", `<?xml version="1.0"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>页眉内容</w:t></w:r></w:p></w:hdr>`);
	zip.file("word/media/image1.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00]));
	for (const [name, content] of Object.entries(extra)) zip.file(name, content);
	const blob = await zip.generateAsync({ type: "uint8array" });
	return blob;
}

const run = (text: string, rPr = "") => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}<w:t xml:space="preserve">${text}</w:t></w:r>`;

const tc = (text: string) => `<w:tc><w:p>${run(text)}</w:p></w:tc>`;
const TBL = `<w:tbl><w:tr>${tc("甲")}${tc("乙")}</w:tr><w:tr>${tc("丙")}${tc("丁")}</w:tr></w:tbl>`;
const DRAWING_P = `<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessing"><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"/></wp:inline></w:drawing></w:r></w:p>`;
const SECT_PR = `<w:sectPr><w:headerReference w:type="default" r:id="rId5" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>`;

describe("docx-univer import", () => {
	it("parses paragraphs, run styles, headings and numbering", async () => {
		const bytes = await buildDocx(
			`<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:jc w:val="center"/></w:pPr>${run("标题一")}</w:p>` +
			`<w:p>${run("普通", "")}${run("加粗", '<w:b/><w:sz w:val="28"/><w:color w:val="FF0000"/>')}</w:p>` +
			`<w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="7"/></w:numPr><w:spacing w:before="240" w:after="120"/></w:pPr>${run("列表项")}</w:p>`,
		);
		const imported = await docxBytesToDocument(bytes);
		expect(imported.paragraphs).toHaveLength(3);
		expect(imported.paragraphs[0].paragraphStyle?.namedStyleType).toBe(4);
		expect(imported.paragraphs[0].paragraphStyle?.horizontalAlign).toBe(2);
		const boldRun = imported.styledRuns.find((r) => r.ts.bl === 1)!;
		expect(boldRun.ts.fs).toBe(14);
		expect(boldRun.ts.cl?.rgb).toBe("#FF0000");
		expect(imported.paragraphs[2].paragraphStyle?.xNum).toBe("7:1");
		expect(imported.paragraphs[2].paragraphStyle?.spaceAbove).toEqual({ v: 12, u: 0 });
	});

	it("converts tables to engine tables and marks images as anchors", async () => {
		const bytes = await buildDocx(`${run2Para("第一段")}${TBL}${DRAWING_P}${SECT_PR}`);
		const imported = await docxBytesToDocument(bytes);
		// Real engine table: stream tokens + tableSource + tables entry.
		expect(imported.tables).toHaveLength(1);
		expect(imported.dataStream).toContain("\u001A"); // TABLE_START token
		const table = imported.tableSource[imported.tables[0].tableId];
		expect(table.tableRows).toHaveLength(2);
		expect(table.tableRows[0].tableCells).toHaveLength(2);
		expect(imported.dataStream).toContain("甲");
		expect(imported.dataStream).toContain("丁");
		// Images stay anchor paragraphs (open-source preset has no doc image model).
		expect(imported.dataStream).toContain("〔#k0〕〔图片〕");
	});
});

const run2Para = (text: string) => `<w:p>${run(text)}</w:p>`;

describe("docx-univer save (preserved splice)", () => {
	// Snapshot shape as saved by the Univer engine: "\r"-separated paragraphs,
	// "\r\n" sentinel tail, paragraphs[i].startIndex at that paragraph's "\r".
	function snapshotFor(stream: string, runs: Array<{ st: number; ed: number; ts?: Record<string, unknown> }>, paraMeta: Array<{ startIndex: number; style?: Record<string, unknown> }>, extra?: { tables?: UniverDocSnapshot["body"] extends undefined ? never : Array<{ startIndex: number; endIndex: number; tableId: string }>; tableSource?: Record<string, unknown> }): UniverDocSnapshot {
		return {
			id: "doc-1",
			documentStyle: {},
			body: {
				dataStream: stream,
				textRuns: runs as never,
				paragraphs: paraMeta.map((p, i) => ({ startIndex: p.startIndex, paragraphId: `p-${i}`, ...(p.style ? { paragraphStyle: p.style } : {}) })) as never,
				...(extra?.tables ? { tables: extra.tables } as never : {}),
			},
			...(extra?.tableSource ? { tableSource: extra.tableSource as never } : {}),
		} as UniverDocSnapshot;
	}

	it("splices edits into the original zip and preserves tables, images, headers, media and numbering", async () => {
		const original = await buildDocx(`${run2Para("第一段")}${TBL}${DRAWING_P}<w:p>${run("尾部段")}</w:p>${SECT_PR}`);
		// Simulated engine state after the user edited the first paragraph:
		// text paragraph + REAL table tokens (cells carry 甲/乙) + image anchor
		// + trailing numbered paragraph. Token chars are the engine's
		// DataStreamTreeTokenType literals.
		const T = { tbl: "\u001A", row: "\u001B", cell: "\u001C", cellEnd: "\u001D", rowEnd: "\u000E", tblEnd: "\u000F" };
		const tableStream = `${T.tbl}${T.row}${T.cell}甲\r${T.cellEnd}${T.cell}乙\r${T.cellEnd}${T.rowEnd}${T.tblEnd}`;
		const stream = `第一段改\r${tableStream}〔#k0〕〔图片〕\r尾部段\r\r\n`;
		// Derive paragraph break positions from the stream itself (the last
		// "\r\n" is the engine's trailing sentinel, not a paragraph).
		const breaks = [...stream].map((c, i) => (c === "\r" ? i : -1)).filter((i) => i >= 0).slice(0, -1);
		const paraMeta = breaks.map((startIndex, i) => ({
			startIndex,
			style: i === 0 ? { namedStyleType: 4, horizontalAlign: 2 } : i === breaks.length - 1 ? { xNum: "7:1" } : undefined,
		}));
		const snapshot = snapshotFor(stream, [{ st: 0, ed: 4, ts: { bl: 1 } }], paraMeta,
			{ tables: [{ startIndex: 5, endIndex: 5 + tableStream.length - 1, tableId: "t-0" }], tableSource: { "t-0": {
				tableId: "t-0",
				tableRows: [
					{ tableCells: [{ margin: {} }, { margin: {} }] },
				],
				tableColumns: [{ size: { type: 1, width: { v: 80 } } }, { size: { type: 1, width: { v: 80 } } }],
				align: 0, indent: { v: 0 }, textWrap: 0,
			} } },
		);

		const out = await univerDocToPreservedDocxBytes(original, snapshot, "t.docx");
		const zip = JSZip();
		await zip.loadAsync(out);
		const xml = await zip.file("word/document.xml")!.async("string");

		// Edited paragraph content, style, heading and alignment round-trip.
		expect(xml).toContain("第一段改");
		expect(xml).toContain("<w:b/>");
		expect(xml).toContain('w:val="Heading1"');
		expect(xml).toContain('w:val="center"');
		// Numbering membership round-trips through the custom style field.
		expect(xml).toContain('w:numId w:val="7"');
		expect(xml).toContain('w:ilvl w:val="1"');
		// The engine table is rebuilt as OOXML and the drawing block is spliced
		// back verbatim at its anchor.
		expect(xml).toContain("<w:tbl>");
		expect(xml).toContain("甲");
		expect(xml).toContain("乙");
		expect(xml).toContain("<w:drawing>");
		// No anchor markers leak into the saved file.
		expect(xml).not.toContain("〔#k");
		// sectPr with header reference survives.
		expect(xml).toContain("headerReference");
		// Untouched parts stay present and identical.
		expect(await zip.file("word/numbering.xml")!.async("string")).toContain('w:numId="7"');
		expect(await zip.file("word/header1.xml")!.async("string")).toContain("页眉内容");
		expect(await zip.file("word/media/image1.png")!.async("uint8array")).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00]));
	});
});

describe("docx-univer save (fallback writer)", () => {
	it("generates a valid docx without an original file", async () => {
		const snapshot: UniverDocSnapshot = {
			id: "doc-1",
			documentStyle: {},
			body: {
				dataStream: "二标题\r正文\r\r\n",
				textRuns: [{ st: 0, ed: 3, ts: { bl: 1, cl: { rgb: "#CC0000" } } }],
				paragraphs: [
					{ startIndex: 3, paragraphId: "p-0", paragraphStyle: { namedStyleType: 5, horizontalAlign: 2 } },
					{ startIndex: 6, paragraphId: "p-1" },
				],
			},
		};
		const bytes = await univerDocToDocxBytes(snapshot, "t.docx");
		const zip = JSZip();
		await zip.loadAsync(bytes);
		const xml = await zip.file("word/document.xml")!.async("string");
		expect(xml).toContain("二标题");
		expect(xml).toContain('w:val="Heading2"');
		expect(xml).toContain('w:val="CC0000"');
		// The writer's output must itself parse back.
		const reparsed = await docxBytesToDocument(bytes);
		expect(reparsed.dataStream).toContain("二标题");
		expect(reparsed.dataStream).toContain("正文");
	});

	it("emits an empty paragraph for an empty snapshot", async () => {
		const snapshot: UniverDocSnapshot = {
			id: "doc-1",
			documentStyle: {},
			body: { dataStream: "\r\n", paragraphs: [{ startIndex: 0, paragraphId: "p-0" }] },
		};
		const out = await univerDocToDocxBytes(snapshot, "e.docx");
		const zip = JSZip();
		await zip.loadAsync(out);
		expect(await zip.file("word/document.xml")!.async("string")).toContain("<w:p");
	});
});
