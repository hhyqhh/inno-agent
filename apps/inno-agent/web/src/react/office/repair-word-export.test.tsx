// @vitest-environment node
// fflate's zipSync/unzipSync round trip needs one consistent Uint8Array realm;
// the jsdom test environment swaps globals per file and breaks `instanceof`,
// so these zip-level tests run in node. The validator cross-check needs a
// DOMParser — jsdom provides one that reports parsererror like browsers do.
// @ts-expect-error jsdom ships without bundled type declarations
import { JSDOM } from "jsdom";
import { unzipSync, zipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { dedupeIgnorableAttributes, hasDuplicateIgnorable, repairWordExport } from "./repair-word-export.js";
import { validateWordExport } from "./validate-word-export.js";

beforeAll(() => {
	if (typeof globalThis.DOMParser === "undefined") {
		globalThis.DOMParser = new JSDOM().window.DOMParser as unknown as typeof DOMParser;
	}
});

const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006";

function buildDocx(documentXml: string, extra: Record<string, Uint8Array> = {}): ArrayBuffer {
	const files: Record<string, Uint8Array> = {
		"[Content_Types].xml": new TextEncoder().encode('<?xml version="1.0" encoding="UTF-8"?><Types/>'),
		"word/document.xml": new TextEncoder().encode(documentXml),
		...extra,
	};
	return zipSync(files).slice().buffer as ArrayBuffer;
}

const partXml = (buffer: ArrayBuffer, name: string): string => new TextDecoder().decode(unzipSync(new Uint8Array(buffer))[name]);

// The exact root-element shape captured from a BetterOffice 0.4.3 export
// (runtime/office-trial/betteroffice-invalid-export.docx).
const DEFECTIVE_ROOT = `<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"`
	+ ` xmlns:mc="${MC}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`
	+ ` xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"`
	+ ` xmlns:ns1="${MC}"`
	+ ` ns1:Ignorable="w14 w15 w16se w16cid w16 w16cex w16sdtdh wp14"`
	+ ` mc:Ignorable="w14 w15 w16se w16cid w16 w16cex w16sdtdh wp14">`
	+ `<w:body><w:p><w:t>正文</w:t></w:p></w:body></w:document>`;

describe("repairWordExport", () => {
	it("drops the duplicate ns1:Ignorable and keeps the canonical mc attribute byte-identical elsewhere", () => {
		const repaired = repairWordExport(buildDocx(DEFECTIVE_ROOT));
		const xml = partXml(repaired, "word/document.xml");
		expect(xml).toContain(` xmlns:ns1="${MC}"`); // unused binding is legal and left alone
		expect(xml).toContain(` mc:Ignorable="w14 w15 w16se w16cid w16 w16cex w16sdtdh wp14"`);
		expect(xml).not.toContain("ns1:Ignorable");
		expect(xml).toContain("<w:body><w:p><w:t>正文</w:t></w:p></w:body></w:document>");
		expect(hasDuplicateIgnorable(xml.match(/<w:document[^>]*>/g)![0])).toBe(false);
	});

	it("lets the strict export validator accept a repaired export and reject the raw one", () => {
		const defective = buildDocx(DEFECTIVE_ROOT);
		expect(() => validateWordExport(defective)).toThrow("WORD_EDITOR_INVALID_EXPORT");
		expect(() => validateWordExport(repairWordExport(defective))).not.toThrow();
	});

	it("keeps legal distinct-namespace Ignorable attributes", () => {
		const tag = `<root xmlns:mc="${MC}" xmlns:foo="urn:example:foo" mc:Ignorable="w14" foo:Ignorable="w14">`;
		expect(dedupeIgnorableAttributes(tag)).toBe(tag);
		const buffer = buildDocx(`<root xmlns:mc="${MC}" xmlns:foo="urn:example:foo" mc:Ignorable="w14" foo:Ignorable="w14"/>`);
		expect(repairWordExport(buffer)).toBe(buffer);
	});

	it("leaves duplicates whose prefix is only declared on an ancestor to the validator", () => {
		const tag = `<w:document xmlns:w="urn:w" ns1:Ignorable="w14" mc:Ignorable="w14">`;
		expect(hasDuplicateIgnorable(tag)).toBe(false);
		expect(dedupeIgnorableAttributes(tag)).toBe(tag);
	});

	it("keeps the first duplicate when no mc prefix is present", () => {
		const tag = `<r xmlns:a="urn:x" xmlns:b="urn:x" a:Ignorable="p" b:Ignorable="q">`;
		const fixed = dedupeIgnorableAttributes(tag);
		expect(fixed).toContain(`a:Ignorable="p"`);
		expect(fixed).not.toContain(`b:Ignorable="q"`);
	});

	it("returns the original buffer when nothing is defective, and passes media through", () => {
		const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
		const buffer = buildDocx(`<root xmlns:mc="${MC}" mc:Ignorable="w14"/>`, { "word/media/image1.png": png });
		expect(repairWordExport(buffer)).toBe(buffer);
		const repacked = repairWordExport(buildDocx(DEFECTIVE_ROOT, { "word/media/image1.png": png }));
		expect([...unzipSync(new Uint8Array(repacked))["word/media/image1.png"]]).toEqual([...png]);
	});

	it("treats a raw > inside a quoted attribute as part of the tag", () => {
		const tag = `<r xmlns:a="urn:x" xmlns:b="urn:x" w:val="1 > 0" a:Ignorable="p" b:Ignorable="q">`;
		const fixed = dedupeIgnorableAttributes(tag);
		expect(fixed).toContain(`a:Ignorable="p"`);
		expect(fixed).toContain(`w:val="1 > 0"`);
		expect(fixed).not.toContain(`b:Ignorable="q"`);
	});
});
