import { describe, expect, it } from "vitest";
import { UnsupportedMathError, convertOmml } from "./omml-to-mathml.js";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const M = "http://schemas.openxmlformats.org/officeDocument/2006/math";

/**
 * The consistency-check equation from the real AHP sample that exposed the bug
 * (green_island_report.docx page 55): an equation array holding fractions, a
 * λ_max subscript, and Word's `#(10)` equation-number convention.
 */
const CI_FORMULA = `<m:oMathPara><m:oMath><m:eqArr><m:eqArrPr><m:maxDist m:val="1"/><m:ctrlPr><w:rPr><w:rFonts w:ascii="Cambria Math"/></w:rPr></m:ctrlPr></m:eqArrPr><m:e><m:r><w:rPr><w:rFonts w:ascii="Cambria Math"/></w:rPr><m:t>CI</m:t></m:r><m:r><m:rPr><m:sty m:val="p"/></m:rPr><w:rPr><w:rFonts w:ascii="Cambria Math"/></w:rPr><m:t>=</m:t></m:r><m:f><m:fPr><m:ctrlPr><w:rPr><w:rFonts w:ascii="Cambria Math"/></w:rPr></m:ctrlPr></m:fPr><m:num><m:sSub><m:e><m:r><m:t>λ</m:t></m:r></m:e><m:sub><m:r><m:t>max</m:t></m:r></m:sub></m:sSub><m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t>-</m:t></m:r><m:r><m:t>n</m:t></m:r></m:num><m:den><m:r><m:t>n</m:t></m:r><m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t>-1</m:t></m:r></m:den></m:f><m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t>=</m:t></m:r><m:f><m:num><m:r><m:t>6.0315-6</m:t></m:r></m:num><m:den><m:r><m:t>6-1</m:t></m:r></m:den></m:f><m:r><m:t>≈0.0063</m:t></m:r><m:r><m:t>#</m:t></m:r><m:d><m:dPr><m:ctrlPr><w:rPr/></m:ctrlPr></m:dPr><m:e><m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t>10</m:t></m:r></m:e></m:d></m:e></m:eqArr></m:oMath></m:oMathPara>`;

const parse = (omml: string): Element => {
	const doc = new DOMParser().parseFromString(`<w:root xmlns:w="${W}" xmlns:m="${M}">${omml}</w:root>`, "application/xml");
	if (doc.getElementsByTagName("parsererror").length) throw new Error("fixture is not valid XML");
	return doc.documentElement.firstElementChild!;
};

describe("OMML → MathML conversion", () => {
	it("converts the real CI formula with fractions, subscript and equation number", () => {
		const rows = convertOmml(parse(CI_FORMULA));
		expect(rows).toHaveLength(1);
		const { mathml, number } = rows[0];
		// Two fractions: (λmax−n)/(n−1) and (6.0315−6)/(6−1).
		expect(mathml.match(/<mfrac>/g)).toHaveLength(2);
		expect(mathml).toContain("<msub>");
		// λ stays italic, but the `m:sty val="p"` runs render upright.
		expect(mathml).toContain("<mi>λ</mi>");
		expect(mathml).toContain('mathvariant="normal"');
		// The `#(10)` marker becomes the separated number, not inline text.
		expect(mathml).not.toContain("#");
		expect(number).toBeTruthy();
		expect(number).toContain("10");
	});

	it("keeps multi-row equation arrays as separate rows", () => {
		const rows = convertOmml(parse(`<m:oMathPara><m:oMath><m:eqArr><m:e><m:r><m:t>a</m:t></m:r></m:e><m:e><m:r><m:t>b</m:t></m:r></m:e></m:eqArr></m:oMath></m:oMathPara>`));
		expect(rows.map((row) => row.mathml)).toHaveLength(2);
	});

	it("ignores control-property elements that Word stores inside equation rows", () => {
		// Real documents carry `m:ctrlPr` as a direct child of `m:e` (green_island
		// report, page 55); the row must still convert instead of failing.
		const rows = convertOmml(parse(`<m:oMath><m:e><m:r><m:t>x</m:t></m:r><m:d><m:dPr><m:ctrlPr><w:rPr><w:i/></w:rPr></m:ctrlPr></m:dPr><m:e><m:r><m:t>10</m:t></m:r></m:e></m:d><m:ctrlPr><w:rPr><w:rFonts w:ascii="Cambria Math"/><w:i/></w:rPr></m:ctrlPr></m:e></m:oMath>`));
		expect(rows[0].mathml).toContain("<mi>x</mi>");
		expect(rows[0].mathml).toContain("10");
		expect(rows[0].mathml).not.toContain("ctrlPr");
	});

	it("maps n-ary operators to under/over limits in display equations", () => {
		const rows = convertOmml(parse(`<m:oMathPara><m:oMath><m:nary><m:naryPr><m:chr m:val="∑"/></m:naryPr><m:sub><m:r><m:t>i</m:t></m:r></m:sub><m:sup><m:r><m:t>6</m:t></m:r></m:sup><m:e><m:r><m:t>A</m:t></m:r></m:e></m:nary></m:oMath></m:oMathPara>`));
		expect(rows[0].mathml).toContain("<munderover>");
		expect(rows[0].mathml).toContain("∑");
	});

	it("honours sub/sup limit placement and hidden limits of n-ary operators", () => {
		const rows = convertOmml(parse(`<m:oMath><m:nary><m:naryPr><m:chr m:val="∑"/><m:limLoc m:val="subSup"/><m:supHide m:val="1"/></m:naryPr><m:sub><m:r><m:t>i</m:t></m:r></m:sub><m:sup><m:r><m:t>6</m:t></m:r></m:sup><m:e><m:r><m:t>A</m:t></m:r></m:e></m:nary></m:oMath>`));
		expect(rows[0].mathml).toContain("<msub>");
		expect(rows[0].mathml).not.toContain("msubsup");
	});

	it("expands custom delimiters and radicals", () => {
		const rows = convertOmml(parse(`<m:oMath><m:d><m:dPr><m:begChr m:val="["/><m:endChr m:val="]"/></m:dPr><m:e><m:r><m:t>0.6</m:t></m:r></m:e></m:d><m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e><m:r><m:t>x</m:t></m:r></m:e></m:rad><m:rad><m:deg><m:r><m:t>3</m:t></m:r></m:deg><m:e><m:r><m:t>y</m:t></m:r></m:e></m:rad></m:oMath>`));
		const mathml = rows[0].mathml;
		expect(mathml).toContain("[");
		expect(mathml).toContain("]");
		expect(mathml).toContain("<msqrt>");
		expect(mathml).toContain("<mroot>");
	});

	it("converts matrices with column alignment", () => {
		const rows = convertOmml(parse(`<m:oMath><m:m><m:mPr><m:mcs><m:mc><m:mcPr><m:mcJc m:val="left"/></m:mcPr></m:mc><m:mc><m:mcPr><m:mcJc m:val="center"/></m:mcPr></m:mc></m:mcs></m:mPr><m:mr><m:e><m:r><m:t>a</m:t></m:r></m:e><m:e><m:r><m:t>b</m:t></m:r></m:e></m:mr><m:mr><m:e><m:r><m:t>c</m:t></m:r></m:e><m:e><m:r><m:t>d</m:t></m:r></m:e></m:mr></m:m></m:oMath>`));
		const mathml = rows[0].mathml;
		expect(mathml).toContain('columnalign="left center"');
		expect(mathml.match(/<mtd/g)).toHaveLength(4);
	});

	it("separates upright function names from italic variables", () => {
		const rows = convertOmml(parse(`<m:oMath><m:func><m:fName><m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t>max</m:t></m:r></m:fName><m:e><m:r><m:t>x</m:t></m:r></m:e></m:func></m:oMath>`));
		expect(rows[0].mathml).toContain('<mi mathvariant="normal">max</mi>');
		expect(rows[0].mathml).toContain("<mi>x</mi>");
	});

	it("throws for structures it cannot convert so the OMML stays untouched", () => {
		expect(() => convertOmml(parse(`<m:oMath><m:groupChr><m:groupChrPr><m:chr m:val="⏟"/></m:groupChrPr><m:e><m:r><m:t>x</m:t></m:r></m:e></m:groupChr></m:oMath>`))).toThrow(UnsupportedMathError);
		expect(() => convertOmml(parse(`<w:p><w:r><w:t>not math</w:t></w:r></w:p>`))).toThrow(UnsupportedMathError);
	});
});
