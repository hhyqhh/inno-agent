import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { prepareVml } from "./prepare-vml.js";
import { parseVmlPath, vmlFormulaResolver } from "./vml-path.js";
import { validateWordExport } from "./validate-word-export.js";

const V = "urn:schemas-microsoft-com:vml", W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main", WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const encode = (s: string) => new Uint8Array(strToU8(s));
const documentXml = (body: string) => `<w:document xmlns:w="${W}" xmlns:v="${V}"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;
const pack = (body: string, extra: Record<string, Uint8Array> = {}) => zipSync({
	"word/document.xml": encode(documentXml(body)),
	"[Content_Types].xml": encode('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
	"_rels/.rels": encode('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'), ...extra,
});
const pict = (s: string) => `<w:p><w:r><w:pict>${s}</w:pict></w:r></w:p>`;
const shape = (attrs = "", content = "") => `<v:shape style="position:absolute;margin-left:37.05pt;margin-top:15.9pt;width:55.5pt;height:60pt" filled="f" strokecolor="#2e54a1" strokeweight="1pt" ${attrs}>${content}</v:shape>`;
const triangleType = '<v:shapetype id="triangle" coordsize="21600,21600" adj="10800" path="m@0,l,21600r21600,xe"><v:formulas><v:f eqn="val #0"/></v:formulas></v:shapetype>';
const unpack = (bytes: Uint8Array, part = "word/document.xml") => new DOMParser().parseFromString(strFromU8(unzipSync(bytes)[part]), "application/xml");
const svgs = (bytes: Uint8Array) => Object.entries(unzipSync(bytes)).filter(([name]) => name.endsWith(".svg")).map(([, data]) => new DOMParser().parseFromString(strFromU8(data), "application/xml"));

describe("VML vector import", () => {
	it("resolves shared shape types, omitted zeroes, relative lines and triangle formula references", () => {
		const source = pack(pict(triangleType + shape('id="triangle-1" type="#triangle"')) + pict(shape('id="triangle-2" type="#triangle"')));
		const result = prepareVml(source), doc = unpack(result.bytes);
		expect(result).toMatchObject({ converted: 2, unsupported: 0 });
		expect(svgs(result.bytes)[0].querySelector("path")?.getAttribute("d")).toBe("M37,0 L0,80 L74,80 Z");
		expect(doc.getElementsByTagNameNS(WP, "positionH")[0].getAttribute("relativeFrom")).toBe("column");
		expect(doc.getElementsByTagNameNS(WP, "positionV")[0].getAttribute("relativeFrom")).toBe("paragraph");
		expect(Array.from(doc.getElementsByTagNameNS(WP, "posOffset")).slice(0, 2).map((e) => Number(e.textContent))).toEqual([457835, 189230]);
		expect(doc.getElementsByTagNameNS(WP, "extent")[0].getAttribute("cx")).toBe("730250");
		expect(svgs(result.bytes)[0].documentElement.getAttribute("stroke")).toBe("#2E54A1");
		expect(doc.getElementsByTagNameNS(V, "shape")).toHaveLength(2); // original VML fallback, no rasterization
		expect(prepareVml(result.bytes).bytes).toBe(result.bytes); // no duplicate Choice/fallback render on reopen
		validateWordExport(result.bytes.slice().buffer as ArrayBuffer);
	});
	it("imports ellipse, rectangle, star and cloud-style cubic paths, keeping other ZIP entries", () => {
		const source = pack(pict('<v:oval style="width:57.75pt;height:54.75pt" filled="f"/>') + pict('<v:rect style="width:67.5pt;height:66.75pt"/>') + pict(shape('coordsize="1152525,1038225" path="m1,396565r440226,3l576262,,712297,396568r440226,-3l796371,641655r136040,396567l576262,793127,220113,1038222,356153,641655xe"')) + pict(shape('coordsize="43200,43200" path="m3900,14370v-41,-405,-62,-819,-62,-1239c3838,8056,6861,3941,10591,3941v1246,,2413,459,3415,1260xem4693,26177nfc4582,26189,4470,26195,4356,26195e"')), { "word/media/untouched.png": new Uint8Array([2, 3, 4]) });
		const result = prepareVml(source), doc = unpack(result.bytes);
		expect(result).toMatchObject({ converted: 4, unsupported: 0 });
		const vectors = svgs(result.bytes);
		expect(vectors[0].querySelector("ellipse")).not.toBeNull(); expect(vectors[1].querySelector("rect")).not.toBeNull();
		expect(vectors[3].querySelector("path")?.getAttribute("d")?.match(/C/g)).toHaveLength(3);
		expect(vectors[3].querySelectorAll("path")[1].getAttribute("fill")).toBe("none");
		expect(unzipSync(result.bytes)["word/media/untouched.png"]).toEqual(new Uint8Array([2, 3, 4]));
	});
	it("converts header/footer stories and leaves documents without VML unchanged", () => {
		const plain = pack("<w:p/>"); expect(prepareVml(plain).bytes).toBe(plain);
		const result = prepareVml(pack("<w:p/>", { "word/header1.xml": encode(`<w:hdr xmlns:w="${W}" xmlns:v="${V}">${pict('<v:rect style="width:1in;height:2cm"/>')}</w:hdr>`) }));
		expect(result.converted).toBe(1); expect(unpack(result.bytes, "word/header1.xml").getElementsByTagNameNS(W, "drawing")).toHaveLength(1);
	});
	it("does not overwrite existing media or relationship IDs", () => {
		const source = pack(pict('<v:oval style="width:1in;height:1in"/>'), {
			"word/media/inno-vml-1.svg": encode("existing media"),
			"word/_rels/document.xml.rels": encode('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdInnoVml2" Type="urn:existing" Target="existing.xml"/></Relationships>'),
		});
		const result = prepareVml(source), parts = unzipSync(result.bytes);
		expect(strFromU8(parts["word/media/inno-vml-1.svg"])).toBe("existing media");
		expect(parts["word/media/inno-vml-3.svg"]).toBeDefined();
		const rels = unpack(result.bytes, "word/_rels/document.xml.rels");
		expect(Array.from(rels.documentElement.children).map((e) => e.getAttribute("Id"))).toEqual(["rIdInnoVml2", "rIdInnoVml3"]);
	});
	it("does not convert existing modern fallback pictures or image-only VML", () => {
		const source = pack(pict(shape('', '<v:imagedata xmlns:r="urn:rel" r:id="rId1"/>')) + `<w:p><w:r><mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="wps"><w:drawing/></mc:Choice><mc:Fallback><w:pict><v:oval style="width:1in;height:1in"/></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>`);
		expect(prepareVml(source)).toMatchObject({ bytes: source, converted: 0, unsupported: 0 });
	});
	it("retains unsupported groups, textboxes and path commands without partial conversion", () => {
		const source = pack(pict('<v:group><v:rect style="width:1in;height:1in"/></v:group>') + pict(shape('path="m0,0ar1,2,3,4,5,6,7,8e"')) + pict(shape('path="m0,0l100,100e"', '<v:textbox><w:txbxContent><w:p/></w:txbxContent></v:textbox>')));
		expect(prepareVml(source)).toMatchObject({ bytes: source, converted: 0, unsupported: 3 });
	});
	it("never executes expressions and bounds path/formula complexity", () => {
		expect(() => vmlFormulaResolver(["prod 1 2 0"], "", 100, 100)).toThrow();
		expect(() => vmlFormulaResolver(["val @0"], "", 100, 100)).toThrow();
		expect(() => parseVmlPath("m0,0javascript:alert(1)", Number)).toThrow();
		expect(() => parseVmlPath("m0,0" + "l1,2".repeat(4200), Number)).toThrow();
		expect(parseVmlPath("m10,20v1,2,3,4,5,6e", Number)[0].commands[1].points).toEqual([[11, 22], [13, 24], [15, 26]]);
	});
	it("passes SVG images to BetterOffice and preserves vector bytes and edited text on export/reopen", async () => {
		// Exercise the actual pinned importer, not a mock of the editor API.
		// npm may hoist @betteroffice/docx to any node_modules level; find it.
		const root = (() => {
			let dir = process.cwd();
			for (;;) {
				const candidate = join(dir, "node_modules", "@betteroffice", "docx", "dist");
				if (existsSync(join(candidate, "wasm-parse.mjs"))) return candidate;
				const parent = dirname(dir);
				if (parent === dir) throw new Error("@betteroffice/docx not found");
				dir = parent;
			}
		})();
		const wasm = await import(/* @vite-ignore */ pathToFileURL(`${root}/wasm-parse.mjs`).href);
		await wasm.preloadParseWasm(new Uint8Array(await readFile(`${root}/generated/parse/docx_parse_bg.wasm`)));
		const result = prepareVml(pack(pict(triangleType + shape('id="native-triangle" type="#triangle"'))));
		const wire = JSON.parse(wasm.parseDocxS9Wire(result.bytes, "{}"));
		const images: Record<string, unknown>[] = [];
		const visit = (value: unknown) => { if (!value || typeof value !== "object") return; const o = value as Record<string, unknown>; if (o.type === "image" && o.size) images.push(o); Object.values(o).forEach(visit); };
		visit(wire);
		expect(images).toHaveLength(1);
		expect(images[0]).toMatchObject({ size: { width: 730250, height: 787400 }, position: { horizontal: { relativeTo: "column", posOffset: 457835 }, vertical: { relativeTo: "paragraph", posOffset: 189230 } } });
		const io = await import(/* @vite-ignore */ pathToFileURL(`${root}/docx/index.mjs`).href);
		const model = await io.parseDocx(result.bytes, { preloadFonts: false });
		const paragraph = model.package.document.content[0];
		paragraph.content.push({ type: "run", content: [{ type: "text", text: "中文编辑" }] });
		const saved = await io.repackDocx(model);
		validateWordExport(saved);
		const output = new Uint8Array(saved);
		expect(svgs(output).map((s) => new XMLSerializer().serializeToString(s))).toEqual(svgs(result.bytes).map((s) => new XMLSerializer().serializeToString(s)));
		expect(unpack(output).documentElement.textContent).toContain("中文编辑");
		expect(prepareVml(output)).toMatchObject({ converted: 0, unsupported: 0 });
	});
});
