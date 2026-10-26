import { createServer, type Server } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SystemFontService } from "../../office/system-fonts.js";
import { handleSystemFontRoutes } from "./system.js";

function u16(value: number): Buffer { const b = Buffer.alloc(2); b.writeUInt16BE(value); return b; }
function u32(value: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b; }
function buildSfnt(family: string): Buffer {
	const familyBytes = Buffer.from(family, "utf16le").swap16();
	const regular = Buffer.from("Regular", "utf16le").swap16();
	const storage = Buffer.concat([familyBytes, regular]);
	const records = [
		[3, 1, 0x409, 1, familyBytes.length, 0],
		[3, 1, 0x409, 2, regular.length, familyBytes.length],
	].map(([platform, encoding, language, nameId, length, offset]) => Buffer.concat([u16(platform), u16(encoding), u16(language), u16(nameId), u16(length), u16(offset)]));
	const nameTable = Buffer.concat([u16(0), u16(records.length), u16(6 + records.length * 12), ...records, storage]);
	const tableDirectory = Buffer.concat([Buffer.from("name", "latin1"), u32(0), u32(28), u32(nameTable.length)]);
	return Buffer.concat([u32(0x00010000), u16(1), u16(16), u16(0), u16(0), tableDirectory, nameTable]);
}

let dir: string;
let service: SystemFontService;
let server: Server;
let base: string;
beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "inno-font-routes-"));
	await writeFile(join(dir, "TestFont.ttf"), buildSfnt("TestFont"));
	service = new SystemFontService([dir]);
	server = createServer(async (req, res) => { if (!await handleSystemFontRoutes(req, res, req.method!, req.url!, service)) { res.writeHead(404); res.end(); } });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });

describe("system font routes", () => {
	it("lists scanned faces", async () => {
		const response = await fetch(`${base}/api/system/fonts`);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		const body = await response.json() as { faces: Array<{ family: string; file: string }> };
		expect(body.faces.map((face) => face.family)).toEqual(["TestFont"]);
	});
	it("serves face bytes for a listed file reference", async () => {
		const { faces } = await (await fetch(`${base}/api/system/fonts`)).json() as { faces: Array<{ file: string }> };
		const response = await fetch(`${base}/api/system/fonts/file?file=${encodeURIComponent(faces[0].file)}`);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("font/octet-stream");
		expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
	});
	it("rejects unknown files, bad refs and non-GET methods", async () => {
		expect((await fetch(`${base}/api/system/fonts/file?file=0:nope.ttf`)).status).toBe(404);
		expect((await fetch(`${base}/api/system/fonts/file?file=../etc/passwd`)).status).toBe(404);
		expect((await fetch(`${base}/api/system/fonts/file?file=0:notes.txt`)).status).toBe(404);
		expect((await fetch(`${base}/api/system/fonts`, { method: "PUT" })).status).toBe(405);
		expect((await fetch(`${base}/api/system/other`)).status).toBe(404);
	});
});
