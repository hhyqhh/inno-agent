import { describe, expect, it } from "vitest";
import { fontPxForPoints, typesetRows } from "./render-math.js";

const px = (svg: string, attr: "width" | "height") => Number(new RegExp(`${attr}="([\\d.]+)"`).exec(svg)?.[1]);

describe("MathML → SVG typesetting", () => {
	it("typesets an inline row with explicit px dimensions", async () => {
		const image = await typesetRows([{ mathml: "<mrow><mi>λ</mi></mrow>", number: null }], { display: false, fontPx: fontPxForPoints(11) });
		expect(image).toBeTruthy();
		expect(image!.widthPx).toBeGreaterThan(0);
		expect(image!.heightPx).toBeGreaterThan(0);
		expect(image!.svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
		expect(px(image!.svg, "width")).toBeCloseTo(image!.widthPx, 1);
		expect(px(image!.svg, "height")).toBeCloseTo(image!.heightPx, 1);
	});

	it("spans the column for display rows and flushes the equation number right", async () => {
		const columnPx = 400;
		const image = await typesetRows(
			[{ mathml: "<mrow><mi>CI</mi></mrow>", number: "<mrow><mo>(</mo><mn>10</mn><mo>)</mo></mrow>" }],
			{ display: true, fontPx: fontPxForPoints(11), columnPx },
		);
		expect(image).toBeTruthy();
		expect(image!.widthPx).toBe(columnPx);
		// Two composed groups: centered equation plus the right-aligned number.
		expect(image!.svg.match(/<g transform="translate\(/g)).toHaveLength(2);
		const placements = [...image!.svg.matchAll(/<g transform="translate\(([\d.]+) ([\d.]+)\)">/g)].map((m) => Number(m[1]));
		expect(placements[1]).toBeGreaterThan(columnPx - 60);
	});

	it("stacks multi-row equation arrays vertically", async () => {
		const fontPx = fontPxForPoints(11);
		const image = await typesetRows(
			[{ mathml: "<mrow><mi>a</mi></mrow>", number: null }, { mathml: "<mrow><mi>b</mi></mrow>", number: null }],
			{ display: true, fontPx, columnPx: 300 },
		);
		expect(image).toBeTruthy();
		expect(image!.svg.match(/<g transform="translate\(/g)).toHaveLength(2);
		expect(image!.heightPx).toBeGreaterThan(fontPx);
	});

	it("returns null so unsupported equations fall back to the untouched OMML", async () => {
		expect(await typesetRows([], { display: false, fontPx: 14 })).toBeNull();
		// An merror in the typeset output means the equation did not render —
		// treat it as "not typeset" so the original OMML is kept instead.
		const broken = await typesetRows([{ mathml: "<merror><mtext>x</mtext></merror>", number: null }], { display: false, fontPx: 14 });
		expect(broken).toBeNull();
	});
});
