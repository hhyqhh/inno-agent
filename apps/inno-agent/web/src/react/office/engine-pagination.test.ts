import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { strToU8, zipSync } from "fflate";

// Regression tests for BetterOffice's pagination of section boundaries. They run the
// real WASM engine headlessly (exportDocxStructuredWithPages) so an upstream
// regression cannot slip through a dependency bump again.
//
// Background: BetterOffice 0.4.3 paginated "manual page break, then an empty
// paragraph carrying a next-page sectPr" as three pages (the section-final
// paragraph got a page of its own). Microsoft Word merges the two coincident
// page starts into one boundary; 0.5.0 fixed it. These tests pin that behavior
// and guard the legitimate blank-page cases (parity filler, doubled page break).

// The engine package exposes only an exports map (no "main" and no
// "./package.json" subpath), so locate its install directory by walking the
// node_modules chain up from this file — the same places Node itself searches.
function resolvePackageDir(name: string): string {
	let dir = import.meta.dirname!;
	for (;;) {
		const candidate = join(dir, "node_modules", name);
		if (existsSync(join(candidate, "package.json"))) return candidate;
		const parent = dirname(dir);
		if (parent === dir) throw new Error(`package not found: ${name}`);
		dir = parent;
	}
}
const coreDir = join(resolvePackageDir("@betteroffice/docx"), "dist");
const fontsDir = join(resolvePackageDir("@betteroffice/fonts"), "assets");

interface Engine {
	exportDocxStructuredWithPages(
		input: Uint8Array,
		options: Record<string, unknown>,
		layout: Record<string, unknown>,
	): Promise<{
		layout: {
			pages: Array<{ pageIndex: number; sectionIndex: number; sectionPageIndex: number; parityFiller: boolean }>;
			fragments: Array<{ pageIndex: number; slice: { kind: string; range?: { start: { paraId: string }; end: { paraId: string } } | null }; anchor: { kind: string; paraId?: string } }>;
			occurrences: Array<{ id: string; pageIndex: number; sectionIndex: number }>;
		};
	}>;
}

let enginePromise: Promise<Engine> | null = null;
async function loadEngine(): Promise<Engine> {
	enginePromise ??= (async () => {
		for (const kind of ["parse", "edit", "layout"]) {
			const mod = await import(pathToFileURL(join(coreDir, `wasm-${kind}.mjs`)).href);
			const bytes = await readFile(join(coreDir, "generated", kind, `docx_${kind}_bg.wasm`));
			await mod[`preload${kind[0]!.toUpperCase()}${kind.slice(1)}Wasm`](new Uint8Array(bytes));
		}
		return (await import(pathToFileURL(join(coreDir, "core.mjs")).href)) as Engine;
	})();
	return enginePromise;
}

const PAGE = '<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800" w:header="851" w:footer="992" w:gutter="0"/>';

function para(text: string, extraRuns = ""): string {
	return `<w:p>${text ? `<w:r><w:t>${text}</w:t></w:r>` : ""}${extraRuns}</w:p>`;
}

function sectionPara(type = ""): string {
	return `<w:p><w:pPr><w:sectPr>${type ? `<w:type w:val="${type}"/>` : ""}${PAGE}</w:sectPr></w:pPr></w:p>`;
}

function buildDocx(paras: string[]): Uint8Array {
	const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras.join("")}<w:sectPr>${PAGE}</w:sectPr></w:body></w:document>`;
	return zipSync({
		"[Content_Types].xml": strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
		"_rels/.rels": strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
		"word/document.xml": strToU8(documentXml),
	});
}

async function paginate(bytes: Uint8Array) {
	const engine = await loadEngine();
	const fonts = [{ key: "test", data: (await readFile(join(fontsDir, "LiberationSans-Regular.ttf"))).toString("base64") }];
	const out = await engine.exportDocxStructuredWithPages(bytes, { revisionView: "accepted", stories: ["body"] }, { fonts, defaultChain: ["test"] });
	return out.layout;
}

describe("BetterOffice engine pagination (real WASM engine)", () => {
	it("merges a manual page break with the following next-page section break into one boundary", async () => {
		// FIRST + explicit page break, empty paragraph ending section 0, SECOND in section 1.
		// Word shows 2 pages; 0.4.3 wrongly gave the section-final paragraph its own page.
		const layout = await paginate(buildDocx([
			para("FIRST", '<w:r><w:br w:type="page"/></w:r>'),
			sectionPara(),
			para("SECOND"),
		]));
		expect(layout.pages).toHaveLength(2);
		expect(layout.pages[0]!.sectionIndex).toBe(0);
		expect(layout.pages[1]!.sectionIndex).toBe(1);
		const secondPage = layout.pages[1]!.pageIndex;
		const secondText = layout.fragments.filter((f) => f.slice.kind === "text" && f.slice.range?.start.paraId === "body:p2");
		expect(secondText.map((f) => f.pageIndex)).toEqual([secondPage]);
		// The section-final paragraph no longer occupies a page of its own.
		const sectionOccurrence = layout.occurrences.find((o) => o.sectionIndex === 1);
		expect(sectionOccurrence?.pageIndex).toBe(secondPage);
	});

	it("keeps a manual page break alone at one page boundary", async () => {
		const layout = await paginate(buildDocx([
			para("FIRST", '<w:r><w:br w:type="page"/></w:r>'),
			para("SECOND"),
		]));
		expect(layout.pages).toHaveLength(2);
		const secondText = layout.fragments.filter((f) => f.slice.kind === "text" && f.slice.range?.start.paraId === "body:p1");
		expect(secondText.map((f) => f.pageIndex)).toEqual([1]);
	});

	it("keeps a next-page section break alone at one page boundary", async () => {
		const layout = await paginate(buildDocx([
			para("FIRST"),
			sectionPara(),
			para("SECOND"),
		]));
		expect(layout.pages).toHaveLength(2);
		expect(layout.pages[1]!.sectionIndex).toBe(1);
		const secondText = layout.fragments.filter((f) => f.slice.kind === "text" && f.slice.range?.start.paraId === "body:p2");
		expect(secondText.map((f) => f.pageIndex)).toEqual([1]);
	});

	it("still renders doubled page breaks as a legitimate blank page", async () => {
		const layout = await paginate(buildDocx([
			para("FIRST", '<w:r><w:br w:type="page"/></w:r>'),
			para("", '<w:r><w:br w:type="page"/></w:r>'),
			para("SECOND"),
		]));
		expect(layout.pages).toHaveLength(3);
		const secondText = layout.fragments.filter((f) => f.slice.kind === "text" && f.slice.range?.start.paraId === "body:p2");
		expect(secondText.map((f) => f.pageIndex)).toEqual([2]);
	});

	it("starts an odd-page section without crashing and documents the current filler behavior", async () => {
		// Word would insert a blank filler page here (section 1 must start on an
		// odd page; after page 1 that is page 3). The 0.5.0 headless snapshot
		// starts the section on page 2 and never sets parityFiller. Pin the
		// current behavior so any change (including a future filler
		// implementation) is a conscious, visible decision.
		const layout = await paginate(buildDocx([
			para("FIRST"),
			sectionPara("oddPage"),
			para("SECOND"),
		]));
		expect(layout.pages).toHaveLength(2);
		expect(layout.pages.some((p) => p.parityFiller)).toBe(false);
		const secondText = layout.fragments.filter((f) => f.slice.kind === "text" && f.slice.range?.start.paraId === "body:p2");
		expect(secondText.map((f) => f.pageIndex)).toEqual([1]);
	});
});
