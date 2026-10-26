import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { createMathSession } from "./prepare-math.js";

const CT = `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>`;
const RELS = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;
const STYLES = `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults></w:styles>`;

/** Real fixture shape: display CI equation with `#(10)` (see omml-to-mathml.test). */
const DISPLAY_FORMULA = `<w:p><m:oMathPara><m:oMath><m:eqArr><m:e><m:r><m:t>CI</m:t></m:r><m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t>=</m:t></m:r><m:f><m:num><m:r><m:t>λ</m:t></m:r><m:r><m:t>n</m:t></m:r></m:num><m:den><m:r><m:t>n</m:t></m:r><m:r><m:t>-1</m:t></m:r></m:den></m:f><m:r><m:t>≈0.0063</m:t></m:r><m:r><m:t>#</m:t></m:r><m:d><m:e><m:r><m:t>10</m:t></m:r></m:e></m:d></m:e></m:eqArr></m:oMath></m:oMathPara></w:p>`;
const INLINE_FORMULA = `<w:p><w:r><w:t>其中</w:t></w:r><m:oMath><m:sSub><m:e><m:r><m:t>λ</m:t></m:r></m:e><m:sub><m:r><m:t>max</m:t></m:r></m:sub></m:sSub></m:oMath><w:r><w:t>为阶数。</w:t></w:r></w:p>`;

const documentXml = (body: string) => `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}<w:sectPr><w:pgSz w:w="11906"/><w:pgMar w:left="1440" w:right="1440"/></w:sectPr></w:body></w:document>`;

// Wrapped copies keep the bytes in the test realm, matching the other
// fflate-based tests in this suite.
const encode = (text: string) => new Uint8Array(strToU8(text));

const pack = (body: string) => zipSync({
	"[Content_Types].xml": encode(CT),
	"word/document.xml": encode(documentXml(body)),
	"word/styles.xml": encode(STYLES),
	"word/_rels/document.xml.rels": encode(RELS),
});

const unzip = (buffer: ArrayBuffer) => Object.fromEntries(Object.entries(unzipSync(new Uint8Array(buffer))).map(([name, data]) => [name, strFromU8(data)]));

describe("math placeholder preparation and OMML restore", () => {
	it("replaces display and inline equations with placeholder pictures", async () => {
		const source = pack(`${DISPLAY_FORMULA}${INLINE_FORMULA}`);
		const session = await createMathSession(new Uint8Array(source));
		expect(session.converted).toBe(2);
		expect(session.unsupported).toBe(0);
		const parts = unzip(session.bytes as unknown as ArrayBuffer);
		expect(parts["word/document.xml"]).not.toContain("<m:oMath");
		expect(parts["word/document.xml"]).toContain('r:embed="rIdInnoMath1"');
		expect(parts["word/document.xml"]).toContain('r:embed="rIdInnoMath2"');
		expect(parts["word/media/inno-math-1.svg"]).toMatch(/^<svg/);
		expect(parts["word/media/inno-math-2.svg"]).toMatch(/^<svg/);
		expect(parts["word/_rels/document.xml.rels"]).toContain("media/inno-math-1.svg");
		expect(parts["[Content_Types].xml"]).toContain("/word/media/inno-math-1.svg");
		// The display equation spans the text column (A4 minus margins).
		expect(Number(new RegExp('width="([\\d.]+)"').exec(parts["word/media/inno-math-1.svg"])?.[1])).toBeGreaterThan(400);
	});

	it("puts the original OMML back into an engine export and cleans the placeholders", async () => {
		const session = await createMathSession(new Uint8Array(pack(`${DISPLAY_FORMULA}${INLINE_FORMULA}`)));
		// The engine round-trips the placeholder package unchanged; restore must
		// return exactly the original equation XML.
		const restored = unzip(session.restore(session.bytes as unknown as ArrayBuffer));
		expect(restored["word/document.xml"]).toContain("<m:oMathPara>");
		expect(restored["word/document.xml"]).toContain("<m:t>≈0.0063</m:t>");
		expect(restored["word/document.xml"]).toContain("<m:t>#</m:t>");
		expect(restored["word/document.xml"]).toContain("<m:t>max</m:t>");
		// OMML must sit directly in the paragraph — inside a w:r the editor and
		// Word drop the equation on reopen.
		expect(restored["word/document.xml"]).not.toMatch(/<w:r>(?:(?!<\/w:r>).)*<m:oMathPara>/s);
		expect(restored["word/media/inno-math-1.svg"]).toBeUndefined();
		expect(restored["word/_rels/document.xml.rels"]).not.toContain("inno-math");
		expect(restored["[Content_Types].xml"]).not.toContain("inno-math");
	});

	it("climbs out of the extra run the engine export wraps pictures in", async () => {
		const session = await createMathSession(new Uint8Array(pack(DISPLAY_FORMULA)));
		const parts = unzipSync(new Uint8Array(session.bytes as unknown as ArrayBuffer));
		// The engine re-serializes pictures inside its own run on top of ours;
		// restore must replace the whole run, not leave OMML nested inside it.
		// Wrap the engine's own run around ours: <w:r><w:r><w:drawing>…</w:r></w:r>.
		const document = strFromU8(parts["word/document.xml"])
			.replace("<w:r><w:drawing>", "<w:r><w:r><w:drawing>")
			.replace("</w:drawing></w:r>", "</w:drawing></w:r></w:r>");
		const exported = zipSync({ ...parts, "word/document.xml": encode(document) }).slice().buffer;
		const restored = unzip(session.restore(exported));
		console.log("DEBUG restored doc:", restored["word/document.xml"].slice(0, 900));
		console.log("DEBUG saved doc:", strFromU8(unzipSync(new Uint8Array(exported))["word/document.xml"]).slice(0, 900));
		expect(restored["word/document.xml"]).toContain("<m:oMathPara>");
		expect(restored["word/document.xml"]).not.toMatch(/<w:r>(?:(?!<\/w:r>).)*<m:oMathPara>/s);
	});

	it("treats a deleted placeholder picture as an intentionally removed equation", async () => {
		const session = await createMathSession(new Uint8Array(pack(`${DISPLAY_FORMULA}${INLINE_FORMULA}`)));
		const parts = unzipSync(new Uint8Array(session.bytes as unknown as ArrayBuffer));
		const document = strFromU8(parts["word/document.xml"])
			.replace(/<w:r><w:drawing>(?:(?!<\/w:drawing>).)*r:embed="rIdInnoMath2"(?:(?!<\/w:drawing>).)*<\/w:drawing><\/w:r>/s, "");
		const exported = zipSync({ ...parts, "word/document.xml": encode(document) }).slice().buffer;
		const restored = unzip(session.restore(exported));
		console.log("DEBUG restored doc:", restored["word/document.xml"].slice(0, 900));
		console.log("DEBUG saved doc:", strFromU8(unzipSync(new Uint8Array(exported))["word/document.xml"]).slice(0, 900));
		expect(restored["word/document.xml"]).toContain("<m:oMathPara>");
		expect(restored["word/document.xml"]).not.toContain("<m:t>max</m:t>");
		expect(restored["word/media/inno-math-2.svg"]).toBeUndefined();
	});

	it("passes documents without equations through untouched", async () => {
		const source = pack("<w:p><w:r><w:t>no math here</w:t></w:r></w:p>");
		const session = await createMathSession(new Uint8Array(source));
		expect(session.converted).toBe(0);
		expect([...session.bytes]).toEqual([...new Uint8Array(source)]);
	});

	it("leaves equations it cannot typeset as OMML and reports them", async () => {
		const session = await createMathSession(new Uint8Array(pack("<w:p><m:oMathPara><m:oMath><m:groupChr><m:e><m:r><m:t>x</m:t></m:r></m:e></m:groupChr></m:oMath></m:oMathPara></w:p>")));
		expect(session.converted).toBe(0);
		expect(session.unsupported).toBe(1);
		const parts = unzip(session.bytes as unknown as ArrayBuffer);
		expect(parts["word/document.xml"]).toContain("m:groupChr");
	});
});
