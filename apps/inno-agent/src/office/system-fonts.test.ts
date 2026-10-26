import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFaceSfnt, parseSfntFaceNames, scanSystemFontFaces, subfamilyToWeightStyle, SystemFontService } from "./system-fonts.js";

function u16(value: number): Buffer { const b = Buffer.alloc(2); b.writeUInt16BE(value); return b; }
function u32(value: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b; }
function tag(text: string): Buffer { return Buffer.from(text, "latin1"); }

/** Build a minimal sfnt with one `name` table holding the given records. */
function buildSfnt(records: Array<{ platform: number; encoding: number; language: number; nameId: number; value: string }>, options?: { faceOffset?: number }): Buffer {
	const encoded = records.map((record) => {
		const raw = record.platform === 1 ? Buffer.from(record.value, "latin1") : Buffer.from(record.value, "utf16le").swap16();
		return { ...record, raw };
	});
	const storage = Buffer.concat(encoded.map((r) => r.raw));
	let storageOffset = 0;
	const recordBuffers = encoded.map((r) => {
		const record = Buffer.concat([u16(r.platform), u16(r.encoding), u16(r.language), u16(r.nameId), u16(r.raw.length), u16(storageOffset)]);
		storageOffset += r.raw.length;
		return record;
	});
	const nameTable = Buffer.concat([u16(0), u16(encoded.length), u16(6 + encoded.length * 12), ...recordBuffers, storage]);
	const tableDirectory = Buffer.concat([tag("name"), u32(0), u32(12 + 16), u32(nameTable.length)]);
	const header = Buffer.concat([u32(0x00010000), u16(1), u16(16), u16(0), u16(0), tableDirectory]);
	const faceOffset = options?.faceOffset ?? 0;
	if (faceOffset > 0) return Buffer.concat([Buffer.alloc(faceOffset), header, nameTable]);
	return Buffer.concat([header, nameTable]);
}

function buildTtc(faceBuffers: Buffer[]): Buffer {
	const header = Buffer.concat([tag("ttcf"), u32(0x00010000), u32(faceBuffers.length)]);
	const offsetsSize = faceBuffers.length * 4;
	let offset = header.length + offsetsSize;
	const offsetBuffers = faceBuffers.map((face) => {
		const entry = u32(offset);
		offset += face.length;
		return entry;
	});
	return Buffer.concat([header, ...offsetBuffers, ...faceBuffers]);
}

/** Apple-style collection: the face directory stores file-absolute offsets. */
function buildTtcAbsolute(faceBuffers: Buffer[]): Buffer {
	const header = Buffer.concat([tag("ttcf"), u32(0x00010000), u32(faceBuffers.length)]);
	const offsetsSize = faceBuffers.length * 4;
	let offset = header.length + offsetsSize;
	const offsetBuffers: Buffer[] = [];
	const relocated: Buffer[] = [];
	for (const face of faceBuffers) {
		offsetBuffers.push(u32(offset));
		// Move each face's table directory plus its data, rewriting the table
		// entries to stay face-relative so the faces themselves stay valid.
		const numTables = face.readUInt16BE(4);
		const shifted = Buffer.from(face);
		for (let i = 0; i < numTables; i += 1) {
			const base = 12 + i * 16;
			shifted.writeUInt32BE(offset + face.readUInt32BE(base + 8), base + 8);
		}
		relocated.push(shifted);
		offset += face.length;
	}
	return Buffer.concat([header, ...offsetBuffers, ...relocated]);
}

let dir: string;
beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "inno-system-fonts-"));
	await writeFile(join(dir, "Times New Roman.ttf"), buildSfnt([
		{ platform: 3, encoding: 1, language: 0x409, nameId: 1, value: "Times New Roman" },
		{ platform: 3, encoding: 1, language: 0x409, nameId: 2, value: "Regular" },
		{ platform: 1, encoding: 0, language: 0, nameId: 1, value: "Times New Roman" },
	]));
	await writeFile(join(dir, "Songti.ttc"), buildTtc([
		buildSfnt([
			{ platform: 3, encoding: 1, language: 0x409, nameId: 1, value: "Songti SC" },
			{ platform: 3, encoding: 1, language: 0x409, nameId: 2, value: "Bold" },
		]),
		buildSfnt([
			{ platform: 3, encoding: 1, language: 0x409, nameId: 16, value: "宋体-简" },
			{ platform: 3, encoding: 1, language: 0x409, nameId: 17, value: "Light" },
		]),
	]));
	await writeFile(join(dir, "broken.ttf"), Buffer.from("not a font at all"));
	await writeFile(join(dir, "notes.txt"), Buffer.from("ignored"));
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

describe("sfnt name parsing", () => {
	it("reads family and subfamily from a simple TTF", () => {
		const faces = parseSfntFaceNames(buildSfnt([
			{ platform: 3, encoding: 1, language: 0x409, nameId: 1, value: "Arial" },
			{ platform: 3, encoding: 1, language: 0x409, nameId: 2, value: "Bold Italic" },
		]));
		expect(faces).toEqual([{ family: "Arial", subfamily: "Bold Italic" }]);
	});
	it("prefers the typographic family ids when present", () => {
		const faces = parseSfntFaceNames(buildSfnt([
			{ platform: 3, encoding: 1, language: 0x409, nameId: 1, value: "Songti SC Light" },
			{ platform: 3, encoding: 1, language: 0x409, nameId: 16, value: "Songti SC" },
			{ platform: 3, encoding: 1, language: 0x409, nameId: 17, value: "Light" },
		]));
		expect(faces).toEqual([{ family: "Songti SC", subfamily: "Light" }]);
	});
	it("expands every face of a TrueType collection", () => {
		const faces = parseSfntFaceNames(buildTtc([
			buildSfnt([
				{ platform: 3, encoding: 1, language: 0x409, nameId: 1, value: "Songti SC" },
				{ platform: 3, encoding: 1, language: 0x409, nameId: 2, value: "Regular" },
			]),
			buildSfnt([
				{ platform: 3, encoding: 1, language: 0x409, nameId: 1, value: "宋体-简" },
				{ platform: 3, encoding: 1, language: 0x409, nameId: 2, value: "Black" },
			]),
		]));
		expect(faces.map((face) => face.family)).toEqual(["Songti SC", "宋体-简"]);
	});
	it("maps subfamilies to CSS weight and style", () => {
		expect(subfamilyToWeightStyle("Regular")).toEqual({ weight: 400, style: "normal" });
		expect(subfamilyToWeightStyle("Bold")).toEqual({ weight: 700, style: "normal" });
		expect(subfamilyToWeightStyle("Bold Italic")).toEqual({ weight: 700, style: "italic" });
		expect(subfamilyToWeightStyle("Light")).toEqual({ weight: 300, style: "normal" });
		expect(subfamilyToWeightStyle("Semibold")).toEqual({ weight: 600, style: "normal" });
		expect(subfamilyToWeightStyle("Heavy Oblique")).toEqual({ weight: 900, style: "italic" });
	});
});

describe("system font service", () => {
	it("scans directories into deduplicated faces with opaque file refs", async () => {
		const faces = await scanSystemFontFaces([dir]);
		const families = faces.map((face) => face.family).sort();
		// The broken binary is skipped silently; non-font extensions ignored.
		expect(families).toEqual(["Songti SC", "Times New Roman", "宋体-简"]);
		expect(faces.every((face) => /^0:/.test(face.file))).toBe(true);
		const songtiBold = faces.find((face) => face.family === "Songti SC");
		expect(songtiBold?.weight).toBe(700);
	});
	it("resolves opaque refs to contained files and refuses escapes", async () => {
		const service = new SystemFontService([dir]);
		const faces = await service.list();
		const face = faces.find((candidate) => candidate.family === "Times New Roman")!;
		const path = await service.resolveFacePath(face.file);
		expect(path).toBe(join(dir, "Times New Roman.ttf"));
		expect(await service.resolveFacePath("1:escape.ttf")).toBe(null);
		expect(await service.resolveFacePath("0:no-such.ttf")).toBe(null);
		expect(await service.resolveFacePath("../outside.ttf")).toBe(null);
	});
	it("serves the bytes of a listed face", async () => {
		const service = new SystemFontService([dir]);
		const faces = await service.list();
		const face = faces.find((candidate) => candidate.family === "宋体-简")!;
		const bytes = await service.readFaceBytes(face.file);
		expect(bytes?.length).toBeGreaterThan(0);
	});
	it("extracts a referenced TTC face as a standalone sfnt", async () => {
		const faceA = buildSfnt([
			{ platform: 3, encoding: 1, language: 0x409, nameId: 1, value: "Songti SC" },
			{ platform: 3, encoding: 1, language: 0x409, nameId: 2, value: "Bold" },
		]);
		const faceB = buildSfnt([
			{ platform: 3, encoding: 1, language: 0x409, nameId: 16, value: "宋体-简" },
			{ platform: 3, encoding: 1, language: 0x409, nameId: 17, value: "Light" },
		]);
		const collection = buildTtc([faceA, faceB]);
		const extracted = buildFaceSfnt(collection, faceA.length + 12 + 8, false);
		expect(parseSfntFaceNames(extracted)).toEqual([{ family: "宋体-简", subfamily: "Light" }]);
	});
	it("extracts faces from Apple-style absolute-offset collections", async () => {
		const faceA = buildSfnt([
			{ platform: 3, encoding: 1, language: 0x409, nameId: 1, value: "Songti SC" },
			{ platform: 3, encoding: 1, language: 0x409, nameId: 2, value: "Regular" },
		]);
		const faceB = buildSfnt([
			{ platform: 3, encoding: 1, language: 0x409, nameId: 1, value: "宋体-简" },
			{ platform: 3, encoding: 1, language: 0x409, nameId: 2, value: "Light" },
		]);
		const collection = buildTtcAbsolute([faceA, faceB]);
		// Face 1 lives right after face 0's block in this layout.
		const faceBOffset = 12 + 8 + faceA.length;
		const extracted = buildFaceSfnt(collection, faceBOffset, true);
		expect(parseSfntFaceNames(extracted)).toEqual([{ family: "宋体-简", subfamily: "Light" }]);
	});
	it("serves per-face bytes for TTC references ending in #index", async () => {
		const service = new SystemFontService([dir]);
		const faces = await service.list();
		const songtiFaces = faces.filter((face) => face.family === "宋体-简" || face.family === "Songti SC");
		expect(songtiFaces.length).toBeGreaterThanOrEqual(2);
		const bytes = await service.readFaceBytes(songtiFaces[0].file);
		expect(bytes).not.toBeNull();
		const parsed = parseSfntFaceNames(bytes!);
		expect(parsed.map((face) => face.family)).toContain(songtiFaces[0].family);
	});
	it("rejects non-font extensions before touching the filesystem", async () => {
		const service = new SystemFontService([dir]);
		expect(await service.resolveFacePath("0:notes.txt")).toBe(null);
		expect(await service.readFaceBytes("0:notes.txt")).toBe(null);
	});
});
