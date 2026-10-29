import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSystemFontDirs, readFontMetadata, SystemFontService } from "./system-fonts.js";

vi.mock("./engine-locator.js", () => ({ findSoffice: async () => "/opt/inno/Contents/MacOS/soffice" }));

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function temporary() { const root = await mkdtemp(join(tmpdir(), "inno-font-")); roots.push(root); return root; }

/** Minimal sfnt metadata, including a format-1 name table's normal record offset. */
function font(family: string, localized: string, weight = 400, faceOffset = 0) {
	const values = [family, localized, "Regular"].map(s => { const b = Buffer.from(s, "utf16le"); return b.swap16(); });
	const name = Buffer.alloc(6 + 3 * 12 + 2 + values.reduce((n, b) => n + b.length, 0));
	name.writeUInt16BE(1, 0); name.writeUInt16BE(3, 2); name.writeUInt16BE(44, 4);
	let data = 44;
	values.forEach((value, i) => {
		const at = 6 + i * 12; name.writeUInt16BE(3, at); name.writeUInt16BE(i === 1 ? 0x804 : 0x409, at + 4);
		name.writeUInt16BE(i === 2 ? 2 : 1, at + 6); name.writeUInt16BE(value.length, at + 8); name.writeUInt16BE(data - 44, at + 10);
		value.copy(name, data); data += value.length;
	});
	const os2 = Buffer.alloc(64); os2.writeUInt16BE(weight, 4);
	const bytes = Buffer.alloc(44 + name.length + os2.length); bytes.writeUInt32BE(0x10000); bytes.writeUInt16BE(2, 4);
	bytes.write("name", 12); bytes.writeUInt32BE(faceOffset + 44, 20); bytes.writeUInt32BE(name.length, 24);
	bytes.write("OS/2", 28); bytes.writeUInt32BE(faceOffset + 44 + name.length, 36); bytes.writeUInt32BE(os2.length, 40);
	name.copy(bytes, 44); os2.copy(bytes, 44 + name.length); return bytes;
}

describe("system font bytes for DOCX layout", () => {
	it("includes the preview engine's private fonts in the editor catalog", async () => {
		const dirs = await defaultSystemFontDirs();
		expect(dirs).toContain(process.platform === "darwin" ? "/opt/inno/Contents/Resources/fonts" : "/opt/inno/Contents/share/fonts");
	});
	it("retains localized family names and numeric OS/2 weights", async () => {
		const root = await temporary(), path = join(root, "song.ttf");
		await writeFile(path, font("SimSun", "宋体", 700));
		expect(await readFontMetadata(path)).toEqual([{ family: "SimSun", aliases: ["SimSun", "宋体"], weight: 700, style: "normal", faceIndex: 0 }]);
	});
	it("preserves TTC face indices and uses file-absolute table offsets", async () => {
		const root = await temporary(), path = join(root, "collection.ttc");
		const first = font("Songti SC", "宋体-简", 400, 20);
		const second = font("Songti SC", "宋体-简", 700, 20 + first.length);
		const head = Buffer.alloc(20); head.write("ttcf"); head.writeUInt32BE(0x10000, 4); head.writeUInt32BE(2, 8); head.writeUInt32BE(20, 12); head.writeUInt32BE(20 + first.length, 16);
		await writeFile(path, Buffer.concat([head, first, second]));
		expect((await readFontMetadata(path)).map(f => [f.faceIndex, f.weight])).toEqual([[0, 400], [1, 700]]);
	});
	it("serves only catalog ids and rejects symlinks escaping a font root", async () => {
		const root = await temporary(), outside = await temporary();
		const bytes = font("SimSun", "宋体"); await writeFile(join(root, "song.ttf"), bytes);
		await writeFile(join(outside, "secret.ttf"), bytes); await symlink(join(outside, "secret.ttf"), join(root, "escape.ttf"));
		const service = new SystemFontService(async () => [root]);
		const pending = service.list(); expect(service.list()).toBe(pending);
		const faces = await pending; expect(faces).toHaveLength(1); expect(faces[0].id).toMatch(/^[a-f0-9]{64}$/);
		expect(await service.read(faces[0].id)).toEqual(bytes);
		expect(await service.read("../secret.ttf")).toBeNull();
	});
});
