import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
import { patchWordEditorRendering } from "./word-editor-render-compat.js";

let engine: any;
const chunk = "node_modules/@docx-editor.dev/core/dist/chunk-GDS24SZN.js";
beforeAll(async () => {
	const result = await build({
		entryPoints: [chunk], bundle: true, platform: "node", format: "esm", write: false,
		plugins: [{ name: "render-compat-test", setup(b) {
			b.onLoad({ filter: /chunk-(GDS24SZN|DDFHKQFU|SRVKFUFI)\.js$/ }, async ({ path }) => ({
				contents: (patchWordEditorRendering(await readFile(path, "utf8"), path) ?? await readFile(path, "utf8")) + (path.endsWith("chunk-GDS24SZN.js") ? '\nexport { $F as requestedFamilies, WT as selectedFormatting, Sg as fontMark, A2 as fontSource, innoStyleForFontSlot }; export { innoBudgetConfiguration } from "./chunk-SRVKFUFI.js";' : path.endsWith("chunk-SRVKFUFI.js") ? '\nexport { Qr as innoBudgetConfiguration };' : ''), loader: "js",
			}));
		} }],
	});
	engine = await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
});

function formatting(slots: ("eastAsia" | "ascii")[], end = slots.length) {
	const spans = slots.map((fontSlot, index) => ({
		kind: "text", text: fontSlot === "eastAsia" ? "中" : "a", fontSlot,
		range: { paragraphId: "p", start: index, end: index + 1 }, props: [],
		style: { fontFamily: "Times New Roman", fontFamilyEastAsia: "宋体", fontSizePt: 12, bold: false, italic: false, underline: null, strike: false, verticalAlign: "baseline", color: null, highlight: null },
	}));
	const range = { paragraphId: "p", start: 0, end: slots.length };
	const layout = { pages: [{ index: 0, fragments: [{ kind: "paragraph", paragraphId: "p", props: [], indent: { left: 0, right: 0, firstLine: 0, hanging: 0 }, lines: [{ id: "line", range, spans }] }] }] };
	return engine.selectedFormatting(layout, { anchor: { paragraphId: "p", offset: 0 }, head: { paragraphId: "p", offset: end } });
}

describe("pinned Word rendering compatibility", () => {
	it("admits a CJK font set above 128 MiB while retaining aggregate and per-face bounds", () => {
		const bytes = new Uint8Array(48 * 1024 * 1024);
		const sources = Array.from({ length: 6 }, (_, i) => ({ request: { family: `CJK ${i}`, weight: 400, style: "normal" }, id: `cjk-${i}`, hash: "test", faceIndex: 0, bytes }));
		const config = { epoch: 0, maxFontBytes: 64 * 1024 * 1024, defaultFont: { family: "Calibri", sizeHalfPoints: 22 } };
		expect(engine.innoBudgetConfiguration({ ...config, sources: sources.slice(0, 3) }).sources).toHaveLength(3);
		expect(() => engine.innoBudgetConfiguration({ ...config, sources })).toThrow("aggregate byte ceiling");
		expect(() => engine.innoBudgetConfiguration({ ...config, maxFontBytes: 65 * 1024 * 1024, sources: [] })).toThrow("hard maximum");
	});
	it("admits the selected TTC face as standalone bytes shared by shaping and browser paint", async () => {
		const original = new Uint8Array(await readFile("apps/inno-agent/web/public/fonts/math/KaTeX_Size1-Regular.ttf"));
		const collection = new Uint8Array(original.length + 20), view = new DataView(collection.buffer);
		collection.set([116, 116, 99, 102]); view.setUint32(4, 0x10000); view.setUint32(8, 2);
		view.setUint32(12, 20); view.setUint32(16, 20); collection.set(original, 20);
		for (let i = 0; i < view.getUint16(24); i++) { const at = 20 + 12 + i * 16 + 8; view.setUint32(at, view.getUint32(at) + 20); }
		const before = collection.slice();
		const result = engine.fontSource(collection, { family: "TTC test", weight: 400, style: "normal", faceIndex: 1 });
		expect(result.source).toBeDefined();
		expect(result.source.faceIndex).toBe(0);
		expect(result.source.bytes.length).toBeLessThan(collection.length);
		expect(new DataView(result.source.bytes.buffer).getUint32(0)).toBe(0x10000);
		expect(collection).toEqual(before);
		expect(engine.fontSource(collection, { family: "TTC test", weight: 400, style: "normal", faceIndex: 9 }).failure.reason).toBe("malformed");
	});
	it("applies a chosen family to Western, Chinese and complex-script slots", () => {
		expect(engine.fontMark({ mark: "fontFamily", value: "黑体" })).toEqual({ ok: true, localName: "rFonts", attributes: { ascii: "黑体", hAnsi: "黑体", eastAsia: "黑体", cs: "黑体" } });
		expect(engine.fontMark({ mark: "fontFamily", value: "" }).ok).toBe(false);
	});
	it("loads fonts used by rendered content without admitting latent style families", () => {
		const session = {
			packageRevision: () => 0, storyParts: () => [], stylesRoot: () => null, numberingRoot: () => null, documentThemeFonts: () => ({}), symbolFontFamilies: () => [],
			documentFonts: () => { throw new Error("must not load unused style fonts"); },
			renderedFontFamilies: () => ["宋体", "黑体"],
		};
		const families = engine.requestedFamilies(session, "Calibri", "Calibri");
		expect(families).toContain("宋体");
		expect(families).toContain("黑体");
	});

	it("reports the selected script's effective face and clears a genuinely mixed selection", () => {
		expect(formatting(["eastAsia", "eastAsia"]).fontFamily).toBe("宋体");
		expect(formatting(["ascii", "ascii"]).fontFamily).toBe("Times New Roman");
		expect(formatting(["eastAsia", "ascii"]).fontFamily).toBeNull();
		// A collapsed caret still resolves the neighboring span, without guessing
		// from the paragraph's ASCII font or from a previously selected range.
		expect(formatting(["eastAsia"], 0).fontFamily).toBe("宋体");
	});

	it("rejects dependency drift and remains idempotent", async () => {
		expect(patchWordEditorRendering("other", "/other.js")).toBeNull();
		expect(() => patchWordEditorRendering("new upstream", chunk)).toThrow("no longer matches");
		const patched = patchWordEditorRendering(await readFile(chunk, "utf8"), chunk)!;
		expect(patchWordEditorRendering(patched, `${chunk}?v=1`)).toBe(patched);
	});
});
