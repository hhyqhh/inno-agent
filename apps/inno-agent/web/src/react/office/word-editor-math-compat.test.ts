import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
import { patchWordEditorMath } from "./word-editor-math-compat.js";
import type { OoxmlNode, OmmlEquationProjection } from "@docx-editor.dev/core/store";

const M = "http://schemas.openxmlformats.org/officeDocument/2006/math";
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
// Use Vitest's existing DOM runtime without adding a production dependency.
const { JSDOM } = createRequire(import.meta.url)("jsdom") as { JSDOM: new (html: string) => { window: { document: Document; close(): void } } };
let serial = 0;
function node(localName: string, children: OoxmlNode[] = [], namespaceUri = M, attrs: Record<string, string> = {}): OoxmlNode {
	return { kind: "generic", id: `math-${serial++}`, namespaceUri, localName, namespaceBindings: [], attributes: Object.entries(attrs).map(([localName, value]) => ({ kind: "genericExtension" as const, namespaceUri, localName, value })), children } as OoxmlNode;
}
function run(value: string) {
	return node("r", [node("t", [{ kind: "textValue", id: `text-${serial++}`, value } as OoxmlNode])]);
}
let layout: any, runStyle: any, measurer: any;
let project: (node: OoxmlNode) => OmmlEquationProjection | null;
let paint: any;
beforeAll(async () => {
	// Exercise the actual pinned projector, including its existing budgets and
	// refusal paths, instead of testing only the replacement strings.
	const result = await build({
		stdin: { contents: 'export { projectOmmlAtom } from "@docx-editor.dev/core/store"; export { layoutEquation, DEFAULT_RUN_STYLE, createFixedMeasurer } from "@docx-editor.dev/core/layout"; export { innoTestPaint } from "./node_modules/@docx-editor.dev/core/dist/chunk-FS7CMYLT.js";', resolveDir: process.cwd() },
		bundle: true, platform: "node", format: "esm", write: false,
		plugins: [{ name: "math-compat-test", setup(b) {
			b.onLoad({ filter: /chunk-(GWM3AKUD|DDFHKQFU|FS7CMYLT)\.js$/ }, async ({ path }) => ({ contents: patchWordEditorMath(await readFile(path, "utf8"), path)! + (path.endsWith("chunk-FS7CMYLT.js") ? '\nexport { E as innoTestPaint };' : ''), loader: "js" }));
		} }],
	});
	const module = (await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`));
	project = module.projectOmmlAtom; layout = module.layoutEquation; runStyle = module.DEFAULT_RUN_STYLE; measurer = module.createFixedMeasurer();
	paint = module.innoTestPaint;
});

describe("pinned Word OMML compatibility", () => {
	it("projects script arguments containing Word control properties and rFonts hint without mutating OOXML", () => {
		const control = () => node("ctrlPr", [node("rPr", [node("rFonts", [], W, { ascii: "Cambria Math", hAnsi: "Cambria Math", hint: "eastAsia" })], W)]);
		const source = node("oMath", [node("sSub", [node("e", [control(), run("λ")]), node("sub", [control(), run("max")])])]);
		const before = JSON.stringify(source);
		const result = project(source)!;
		expect(JSON.stringify(result.expression)).not.toContain('"fallback"');
		expect(JSON.stringify(result.expression)).toContain('"subscript"');
		expect(result.fallbackText).toBe("λmax");
		expect(JSON.stringify(source)).toBe(before);
	});

	it("keeps a single equation-array row structured, including fractions and delimiters", () => {
		const source = node("oMath", [node("eqArr", [node("eqArrPr", [node("maxDist", [], M, { val: "1" })]), node("e", [
			run("CI="), node("f", [node("num", [run("λ−n")]), node("den", [run("n−1")])]),
			run("#"), node("d", [node("dPr", [node("begChr", [], M, { val: "(" }), node("endChr", [], M, { val: ")" })]), node("e", [run("10")])]),
		])])]);
		const result = project(source)!;
		const expression = JSON.stringify(result.expression);
		expect(expression).toContain('"fraction"');
		expect(expression).not.toContain('"fallback"');
		expect(expression).toContain('"value":"("');
		expect(expression).toContain('"controlProperties":true'); // prevents lossy compact editing
	});

	it("stacks piecewise branches vertically and separates equation numbers without changing the source", () => {
		const source = node("oMath", [node("eqArr", [node("e", [run("y="), node("d", [node("dPr", [node("begChr", [], M, { val: "{" }), node("endChr", [], M, { val: "" })]), node("e", [node("eqArr", [node("e", [run("−1"), run(" if "), run("x"), run("<0")]), node("e", [run("1"), run(" if "), run("x"), run(">0")])])])]), run("#")])]), node("d", [node("e", [run("4")])])]);
		const before = JSON.stringify(source), result = project(source)!;
		const expression = JSON.stringify(result.expression);
		expect(expression).not.toContain('"fallback"');
		expect(expression).toContain('"stacked":true');
		expect(expression).not.toContain('"value":"#"');
		const geometry = layout(result, measurer, runStyle).geometry;
		const find = (g: any): any => g.kind === "row" && g.items.length === 2 && g.items[1].box.y > g.items[0].box.y ? g : g.items?.map(find).find(Boolean);
		const stack = find(geometry);
		expect(stack).toBeTruthy();
		expect(stack.items).toHaveLength(2);
		expect(stack.items[0].items).toHaveLength(4);
		expect(stack.items[0].items[3].box.x).toBeGreaterThan(stack.items[0].items[0].box.x);
		expect(stack.items[1].box.y).toBeGreaterThanOrEqual(stack.items[0].box.height);
		expect(JSON.stringify(source)).toBe(before);
		expect(JSON.stringify(project(node("oMath", [run("#")]))!.expression)).toContain('"value":"#"');
	});

	it("positions numeric subscripts relative to the base baseline", () => {
		const source = node("oMath", [node("sSub", [node("e", [run("b")]), node("sub", [run("1")])])]);
		const g = layout(project(source), measurer, runStyle).geometry;
		const baseBaseline = g.base.box.y + g.base.baseline;
		const subBaseline = g.subscript.box.y + g.subscript.baseline;
		expect(subBaseline).toBeGreaterThan(baseBaseline);
		expect(subBaseline - baseBaseline).toBeLessThan(runStyle.fontSizePt * .4);
		expect(g.subscript.box.y).toBeLessThan(baseBaseline);
	});

	it("recognizes a numbering marker attached to the preceding run", () => {
		const source = node("oMath", [node("eqArr", [node("e", [run("B=W⋅R#"), node("d", [node("e", [run("13")])])])])]);
		expect(JSON.stringify(project(source)!.expression)).not.toContain("#");
		expect(JSON.stringify(project(source)!.expression)).toContain("B=W⋅R");
	});

	it("renders overbar accents and centered matrices, with a bounded budget for Word formatting", () => {
		const accent = node("acc", [node("accPr", [node("chr", [], M, { val: "\u0305" })]), node("e", [run("X")])]);
		expect(JSON.stringify(project(node("oMath", [accent]))!.expression)).toContain('"bar"');
		const matrix = node("m", [node("mr", [node("e", [run("a")]), node("e", [run("long")])]), node("mr", [node("e", [run("123")]), node("e", [run("b")])])]);
		const result = project(node("oMath", [matrix]))!;
		expect(JSON.stringify(result.expression)).not.toContain('"fallback"');
		const g = layout(result, measurer, runStyle).geometry;
		expect(g.items[1].box.y).toBeGreaterThanOrEqual(g.items[0].box.height);
		const center = (cell: any) => cell.box.x + cell.box.width / 2;
		expect(center(g.items[0].items[1])).toBeCloseTo(center(g.items[1].items[1]));
		const formattedRun = () => node("r", [node("rPr", [node("rFonts", [], W, { ascii: "Cambria Math", eastAsia: "华文细黑" }), node("color", [], W, { val: "000000" }), node("szCs", [], W, { val: "21" })], W), node("t", [{ kind: "textValue", id: `value-${serial++}`, value: "x" } as OoxmlNode])]);
		const many = node("oMath", Array.from({ length: 80 }, formattedRun));
		expect(project(many)!.truncated).toBe(false);
		expect(JSON.stringify(project(many)!.expression)).not.toContain('"fallback"');
		expect(project(node("oMath", Array.from({ length: 600 }, formattedRun)))!.truncated).toBe(true);
	});

	it("retains the upstream fallback for foreign namespaces", () => {
		for (const unsupported of [node("eqArr", [node("e", [run("a")])], "urn:foreign")]) {
			expect(JSON.stringify(project(node("oMath", [unsupported]))!.expression)).toContain('"fallback"');
		}
	});

	it("fits tall matrix parentheses without magnifying their stroke width", () => {
		const host = globalThis as { __innoMathDelimFamilies?: string[] };
		host.__innoMathDelimFamilies = [1, 2, 3, 4].map(i => `InnoMathDelim${i}`);
		try {
			const matrix = node("m", Array.from({ length: 6 }, () => node("mr", Array.from({ length: 6 }, () => node("e", [run("r")])))));
			const source = node("oMath", [node("d", [node("e", [matrix])])]);
			const before = JSON.stringify(source);
			const g = layout(project(source), measurer, runStyle).geometry;
			expect(g.items).toHaveLength(3);
			const [left, body, right] = g.items;
			for (const delimiter of [left, right]) {
				expect(delimiter.box.height).toBeGreaterThanOrEqual(body.box.height);
				expect(delimiter.fontSizePt).toBe(runStyle.fontSizePt);
				expect(delimiter.box.width).toBeLessThan(runStyle.fontSizePt);
				expect(delimiter.runStyle.fontFamily).toBe("InnoMathDelim4");
				expect(delimiter.runStyle.bold).toBe(false);
				expect(delimiter.runStyle.italic).toBe(false);
				expect(delimiter.innoDelimiterPaint.scaleY).toBeGreaterThan(1);
			}
			const dom = new JSDOM("<!doctype html><body></body>");
			try {
				const doc = dom.window.document;
				paint(doc, doc.body, g, {}, 2, 0, 0, [], "0", (el: HTMLElement, style: any) => { el.style.fontFamily = style.fontFamily; });
				const painted = [...doc.querySelectorAll<HTMLElement>("span")].filter(el => el.textContent === "(" || el.textContent === ")");
				expect(painted).toHaveLength(2);
				for (const el of painted) {
					expect(el.style.transform).toBe(`scaleY(${left.innoDelimiterPaint.scaleY})`);
					expect(parseFloat(el.style.height)).toBeCloseTo(left.innoDelimiterPaint.lineHeight * 2);
					expect(parseFloat(el.style.width)).toBeCloseTo(left.box.width * 2);
					expect(el.style.fontFamily).toBe("InnoMathDelim4");
				}
			} finally { dom.window.close(); }
			expect(left.text).toBe("("); expect(right.text).toBe(")");
			expect(JSON.stringify(source)).toBe(before);
		} finally { delete host.__innoMathDelimFamilies; }
	});

	it("only patches the pinned chunk and fails visibly on dependency drift", async () => {
		expect(patchWordEditorMath("unrelated", "/other.js")).toBeNull();
		expect(() => patchWordEditorMath("new upstream", "/@docx-editor.dev/core/dist/chunk-GWM3AKUD.js")).toThrow("no longer matches");
		const path = "node_modules/@docx-editor.dev/core/dist/chunk-GWM3AKUD.js";
		const patched = patchWordEditorMath(await readFile(path, "utf8"), path)!;
		expect(patchWordEditorMath(patched, `${path}?v=1`)).toBe(patched);
	});
});
