import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveContainedPathAsync } from "../utils/path-safety.js";

/**
 * Read-only access to the operating system's installed fonts so the DOCX
 * editor can draw text with the fonts a document actually names (SimSun,
 * Times New Roman, …) instead of the bundled substitutes. The server only
 * enumerates and serves bytes from well-known font directories; it never
 * writes there.
 * @packageDocumentation
 */

export interface SystemFontFace {
	/** Family name from the font's own `name` table (typographic family preferred). */
	family: string;
	/** CSS weight: 400 regular, 700 bold, 300 light, … */
	weight: number;
	style: "normal" | "italic";
	/**
	 * Opaque file reference handed back to the service, `${dirIndex}:${relative
	 * path}#${faceIndex}` — never an absolute host path, which would leak the
	 * user's directory layout to the renderer.
	 */
	file: string;
	/** For TTC faces: the face's sfnt header offset inside the collection. */
	ttcFaceOffset?: number;
	/** For TTC faces: whether table offsets are file-absolute (Apple quirk). */
	ttcAbsoluteOffsets?: boolean;
}

export function defaultSystemFontDirs(platform: string, home: string): string[] {
	if (platform === "darwin") {
		return ["/System/Library/Fonts", "/System/Library/Fonts/Supplemental", "/Library/Fonts", join(home, "Library", "Fonts")];
	}
	if (platform === "win32") return ["C:\\Windows\\Fonts"];
	// Linux and everything else: the freedesktop font directories.
	return ["/usr/share/fonts", "/usr/local/share/fonts", join(home, ".fonts"), join(home, ".local", "share", "fonts")];
}

const FONT_EXTENSIONS = new Set([".ttf", ".otf", ".ttc"]);

function readU16(buffer: Buffer, offset: number): number { return buffer.readUInt16BE(offset); }
function readU32(buffer: Buffer, offset: number): number { return buffer.readUInt32BE(offset); }

function decodeNameRecord(buffer: Buffer, storageOffset: number, platformId: number, offset: number, length: number): string {
	const start = storageOffset + offset;
	const raw = buffer.subarray(start, start + length);
	if (platformId === 1) return raw.toString("latin1").replace(/\0+$/, "").trim();
	// Windows/Unicode records are UTF-16BE; records can be odd-length (a
	// truncated final code unit), which swap16 would reject — decode by pair.
	let text = "";
	for (let i = 0; i + 1 < raw.length; i += 2) text += String.fromCharCode((raw[i] << 8) | raw[i + 1]);
	return text.replace(/\0+$/, "").trim();
}

interface NamePick { preferred?: string; fallback?: string }

function pickName(buffer: Buffer, storageOffset: number, count: number, recordsStart: number, nameId: number): NamePick {
	const pick: NamePick = {};
	for (let i = 0; i < count; i += 1) {
		const base = recordsStart + i * 12;
		if (readU16(buffer, base + 6) !== nameId) continue;
		const platformId = readU16(buffer, base);
		const languageId = readU16(buffer, base + 4);
		const value = decodeNameRecord(buffer, storageOffset, platformId, readU16(buffer, base + 10), readU16(buffer, base + 8));
		if (!value) continue;
		// Windows English first, then anything readable as a fallback.
		if (platformId === 3 && (languageId === 0x409 || languageId === 0)) pick.preferred ??= value;
		else if (platformId === 3 || platformId === 0) pick.preferred ??= value;
		else pick.fallback ??= value;
	}
	return pick;
}

interface FaceNames { family: string; subfamily: string }

function parseNameTable(buffer: Buffer): FaceNames | null {
	const format = readU16(buffer, 0);
	if (format > 1) return null;
	const count = readU16(buffer, 2);
	const storageOffset = readU16(buffer, 4);
	// Format 1 inserts a language-tag count + tag records before the names.
	const langTagCount = format === 1 ? readU16(buffer, 6) : 0;
	const recordsStart = 6 + (format === 1 ? 2 + langTagCount * 6 : 0);
	// Typographic family/subfamily (16/17) win; legacy family/subfamily (1/2)
	// back them up. Localized Windows-English records decode first.
	const family16 = pickName(buffer, storageOffset, count, recordsStart, 16);
	const family1 = pickName(buffer, storageOffset, count, recordsStart, 1);
	const familyValue = family16.preferred ?? family16.fallback ?? family1.preferred ?? family1.fallback;
	if (!familyValue) return null;
	const subfamily17 = pickName(buffer, storageOffset, count, recordsStart, 17);
	const subfamily2 = pickName(buffer, storageOffset, count, recordsStart, 2);
	const subfamilyValue = subfamily17.preferred ?? subfamily17.fallback ?? subfamily2.preferred ?? subfamily2.fallback ?? "Regular";
	return { family: familyValue, subfamily: subfamilyValue || "Regular" };
}

/** Locate the `name` table entry inside one sfnt table directory. */
function findNameTable(buffer: Buffer): { offset: number; length: number } | null {
	const numTables = readU16(buffer, 4);
	for (let i = 0; i < numTables; i += 1) {
		const base = 12 + i * 16;
		if (base + 16 > buffer.length) return null;
		if (buffer.toString("latin1", base, base + 4) === "name") {
			return { offset: readU32(buffer, base + 8), length: readU32(buffer, base + 12) };
		}
	}
	return null;
}

export function subfamilyToWeightStyle(subfamily: string): { weight: number; style: "normal" | "italic" } {
	const value = subfamily.toLowerCase();
	const italic = value.includes("italic") || value.includes("oblique");
	let weight = 400;
	// Apple's Chinese faces name subfamilies in Chinese: 黑體 is the bold cut
	// of Songti/Heiti, 粗體 bold, 細體 light, 中黑 semibold, 標準體/标准体
	// regular. Without these the bold cut of Songti.ttc parses as "regular"
	// and body text renders thick like a heiti face.
	if (value.includes("thin")) weight = 100;
	else if (value.includes("extralight") || value.includes("ultralight")) weight = 200;
	else if (value.includes("light") || value.includes("細體") || value.includes("细体")) weight = 300;
	else if (value.includes("medium")) weight = 500;
	else if (value.includes("semibold") || value.includes("demibold") || value.includes("中黑")) weight = 600;
	else if (value.includes("black") || value.includes("heavy")) weight = 900;
	else if (value.includes("extrabold") || value.includes("ultrabold")) weight = 800;
	else if (value.includes("bold") || value.includes("黑體") || value.includes("黑体") || value.includes("粗體") || value.includes("粗体")) weight = 700;
	return { weight, style: italic ? "italic" : "normal" };
}

/** Parse every face's family/subfamily out of one TTF/OTF/TTC buffer. */
export function parseSfntFaceNames(buffer: Buffer, depth = 0): FaceNames[] {
	try {
		const tag = buffer.toString("latin1", 0, 4);
		if (tag === "ttcf" && depth < 4) {
			const numFonts = readU32(buffer, 8);
			const faces: FaceNames[] = [];
			for (let i = 0; i < Math.min(numFonts, 16); i += 1) {
				// A zero or self-referential offset would loop forever; real
				// collections point past the header.
				const faceOffset = readU32(buffer, 12 + i * 4);
				if (faceOffset <= 0 || faceOffset >= buffer.length) continue;
				try {
					const faceBuffer = buffer.subarray(faceOffset);
					const name = findNameTable(faceBuffer);
					if (!name) continue;
					// Spec says face-relative; some Apple collections use absolute
					// file offsets — accept whichever one parses. A face whose
					// records overflow its table is skipped, not fatal: real
					// collections mix well-formed and stub faces.
					const parsed = parseNameTable(faceBuffer.subarray(name.offset, Math.min(faceBuffer.length, name.offset + name.length)))
						?? parseNameTable(buffer.subarray(name.offset, Math.min(buffer.length, name.offset + name.length)));
					if (parsed) faces.push(parsed);
				} catch {
					continue;
				}
			}
			return faces;
		}
		const magic = readU32(buffer, 0);
		if (magic !== 0x00010000 && tag !== "OTTO" && tag !== "true") return [];
		const name = findNameTable(buffer);
		if (!name) return [];
		// Name tables live in the first megabyte of every practical font.
		const chunk = buffer.subarray(name.offset, Math.min(buffer.length, name.offset + Math.max(name.length, 1)));
		const parsed = parseNameTable(chunk);
		return parsed ? [parsed] : [];
	} catch {
		return [];
	}
}

/**
 * Rebuild one collection face as a standalone sfnt binary. Font engines
 * register whole buffers, and a raw TTC's first face would shadow every
 * other face in the file — extraction is what makes 宋体 and 黑体 (faces of
 * the same Apple collections) render as different fonts.
 */
export function buildFaceSfnt(collection: Buffer, faceOffset: number, absoluteOffsets: boolean): Buffer {
	const version = readU32(collection, faceOffset);
	const numTables = readU16(collection, faceOffset + 4);
	interface Entry { tag: Buffer; checksum: number; length: number; sourceOffset: number }
	const entries: Entry[] = [];
	for (let i = 0; i < numTables; i += 1) {
		const base = faceOffset + 12 + i * 16;
		if (base + 16 > collection.length) break;
		const rawOffset = readU32(collection, base + 8);
		const length = readU32(collection, base + 12);
		const sourceOffset = absoluteOffsets ? rawOffset : faceOffset + rawOffset;
		if (sourceOffset < 0 || sourceOffset + length > collection.length) continue;
		entries.push({ tag: collection.subarray(base, base + 4), checksum: readU32(collection, base + 4), length, sourceOffset });
	}
	const directorySize = 12 + entries.length * 16;
	let dataOffset = directorySize;
	const placed: Array<Entry & { outOffset: number }> = [];
	for (const entry of entries) {
		placed.push({ ...entry, outOffset: dataOffset });
		dataOffset += (entry.length + 3) & ~3;
	}
	const out = Buffer.alloc(dataOffset);
	out.writeUInt32BE(version, 0);
	out.writeUInt16BE(entries.length, 4);
	let cursor = directorySize;
	for (let i = 0; i < placed.length; i += 1) {
		const entry = placed[i];
		const base = 12 + i * 16;
		entry.tag.copy(out, base);
		out.writeUInt32BE(entry.checksum, base + 4);
		out.writeUInt32BE(entry.outOffset, base + 8);
		out.writeUInt32BE(entry.length, base + 12);
		collection.copy(out, cursor, entry.sourceOffset, entry.sourceOffset + entry.length);
		cursor += (entry.length + 3) & ~3;
	}
	return out;
}

interface LocatedFace extends FaceNames {
	/** null for single-file fonts; the sfnt header offset inside a TTC. */
	faceOffset: number | null;
	/** Whether this TTC's table offsets are file-absolute. */
	absoluteOffsets: boolean;
}

/** Read just the header and `name` table of a font file, without loading megabytes. */
async function readFaceNames(path: string): Promise<LocatedFace[]> {
	const handle = await open(path, "r");
	try {
		const head = Buffer.alloc(4096);
		const headRead = await handle.read(head, 0, head.length, 0);
		const headBuffer = head.subarray(0, headRead.bytesRead);
		const tag = headBuffer.toString("latin1", 0, 4);
		if (tag !== "ttcf") {
			const name = findNameTable(headBuffer);
			if (!name) return [];
			const chunk = Buffer.alloc(Math.min(name.length, 1 << 20));
			const read = await handle.read(chunk, 0, chunk.length, name.offset);
			const parsed = parseNameTable(chunk.subarray(0, read.bytesRead));
			return parsed ? [{ ...parsed, faceOffset: null, absoluteOffsets: false }] : [];
		}
		const numFonts = readU32(headBuffer, 8);
		const faces: LocatedFace[] = [];
		for (let i = 0; i < Math.min(numFonts, 16); i += 1) {
			if (12 + i * 4 + 4 > headBuffer.length) break;
			const faceOffset = readU32(headBuffer, 12 + i * 4);
			try {
				const faceHead = Buffer.alloc(4096);
				const faceRead = await handle.read(faceHead, 0, faceHead.length, faceOffset);
				const faceBuffer = faceHead.subarray(0, faceRead.bytesRead);
				const name = findNameTable(faceBuffer);
				if (!name) continue;
				// Face-relative first; some Apple collections store absolute
				// offsets. Overflowing record counts skip the face, not the scan.
				const chunk = Buffer.alloc(Math.min(name.length, 1 << 20));
				const relative = await handle.read(chunk, 0, chunk.length, faceOffset + name.offset);
				let parsed = parseNameTable(chunk.subarray(0, relative.bytesRead));
				let absoluteOffsets = false;
				if (!parsed) {
					const absolute = await handle.read(chunk, 0, chunk.length, name.offset);
					parsed = parseNameTable(chunk.subarray(0, absolute.bytesRead));
					absoluteOffsets = true;
				}
				if (parsed) faces.push({ ...parsed, faceOffset, absoluteOffsets });
			} catch {
				continue;
			}
		}
		return faces;
	} catch {
		return [];
	} finally {
		await handle.close();
	}
}

/** Scan the given directories; unreadable directories and files are skipped. */
export async function scanSystemFontFaces(dirs: string[]): Promise<SystemFontFace[]> {
	const faces: SystemFontFace[] = [];
	const seen = new Set<string>();
	for (let dirIndex = 0; dirIndex < dirs.length; dirIndex += 1) {
		const dir = dirs[dirIndex];
		const entries = await readdir(dir).catch(() => []);
		for (const entry of entries) {
			if (!FONT_EXTENSIONS.has(entry.slice(entry.lastIndexOf(".")).toLowerCase())) continue;
			const fullPath = join(dir, entry);
			const info = await stat(fullPath).catch(() => null);
			if (!info?.isFile()) continue;
			const located = await readFaceNames(fullPath);
			for (let faceIndex = 0; faceIndex < located.length; faceIndex += 1) {
				const names = located[faceIndex];
				const { weight, style } = subfamilyToWeightStyle(names.subfamily);
				const faceSuffix = names.faceOffset === null ? "" : `#${faceIndex}`;
				const file = `${dirIndex}:${entry}${faceSuffix}`;
				const key = `${names.family}|${weight}|${style}|${file}`;
				if (seen.has(key)) continue;
				seen.add(key);
				faces.push({
					family: names.family, weight, style, file,
					ttcFaceOffset: names.faceOffset ?? undefined,
					ttcAbsoluteOffsets: names.faceOffset === null ? undefined : names.absoluteOffsets,
				});
			}
		}
	}
	return faces;
}

/** Read-only accessor over the machine's font directories. */
export class SystemFontService {
	private faces: Promise<SystemFontFace[]> | null = null;
	constructor(private readonly dirs: string[]) {}

	/** Enumerated faces; scanned once and memoized for the process lifetime. */
	list(): Promise<SystemFontFace[]> {
		this.faces ??= scanSystemFontFaces(this.dirs).catch(() => []);
		return this.faces;
	}

	/** Resolve a face's opaque file reference to a contained, existing path. */
	async resolveFacePath(file: string): Promise<string | null> {
		const separator = file.indexOf(":");
		if (separator <= 0) return null;
		const dirIndex = Number(file.slice(0, separator));
		const relative = file.slice(separator + 1);
		if (!Number.isInteger(dirIndex) || dirIndex < 0 || dirIndex >= this.dirs.length) return null;
		const dir = this.dirs[dirIndex];
		if (!FONT_EXTENSIONS.has(relative.slice(relative.lastIndexOf(".")).toLowerCase())) return null;
		const path = await resolveContainedPathAsync(dir, relative);
		if (!path) return null;
		// The canonical base exists, but the referenced file may not: fail closed.
		const info = await stat(path).catch(() => null);
		return info?.isFile() ? path : null;
	}

	async readFaceBytes(file: string): Promise<Buffer | null> {
		const hash = file.lastIndexOf("#");
		const fileRef = hash === -1 ? file : file.slice(0, hash);
		const faceIndex = hash === -1 ? null : Number(file.slice(hash + 1));
		const path = await this.resolveFacePath(fileRef);
		if (!path) return null;
		const { readFile } = await import("node:fs/promises");
		const bytes = await readFile(path).catch(() => null);
		if (!bytes) return null;
		if (faceIndex === null) return bytes;
		const faces = await this.list();
		const face = faces.find((candidate) => candidate.file === file);
		if (!face || face.ttcFaceOffset === undefined) return null;
		return buildFaceSfnt(bytes, face.ttcFaceOffset, face.ttcAbsoluteOffsets ?? false);
	}
}

export function createSystemFontService(platform: string = process.platform, home: string = homedir(), dirs?: string[]): SystemFontService {
	return new SystemFontService(dirs ?? defaultSystemFontDirs(platform, home));
}
