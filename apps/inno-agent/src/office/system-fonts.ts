import { createHash } from "node:crypto";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { findSoffice } from "./engine-locator.js";
import { resolveContainedPathAsync } from "../utils/path-safety.js";

export interface SystemFontFace {
	family: string;
	aliases: string[];
	weight: number;
	style: "normal" | "italic";
	id: string;
	faceIndex: number;
}

interface FontMetadata extends Omit<SystemFontFace, "id"> {}
const MAX_FONT_BYTES = 64 * 1024 * 1024;
const FONT_EXTENSION = /\.(ttf|otf|ttc)$/i;

/** Read only the sfnt directory and metadata tables, rather than every CJK glyph. */
export async function readFontMetadata(path: string): Promise<FontMetadata[]> {
	const file = await open(path, "r");
	const read = async (offset: number, length: number) => {
		if (length < 0 || length > 1024 * 1024) throw new Error("Invalid font metadata size");
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await file.read(buffer, 0, length, offset);
		if (bytesRead !== length) throw new Error("Truncated font metadata");
		return buffer;
	};
	try {
		const head = await read(0, 12);
		const collection = head.toString("ascii", 0, 4) === "ttcf";
		const count = collection ? Math.min(head.readUInt32BE(8), 64) : 1;
		const offsets = collection ? await read(12, count * 4) : Buffer.alloc(4);
		const faces: FontMetadata[] = [];
		for (let faceIndex = 0; faceIndex < count; faceIndex++) {
			const offset = collection ? offsets.readUInt32BE(faceIndex * 4) : 0;
			const header = await read(offset, 12);
			const signature = header.toString("ascii", 0, 4);
			if (header.readUInt32BE(0) !== 0x10000 && signature !== "OTTO" && signature !== "true") continue;
			const tables = await read(offset + 12, header.readUInt16BE(4) * 16);
			const table = async (tag: string) => {
				for (let at = 0; at < tables.length; at += 16) {
					if (tables.toString("ascii", at, at + 4) === tag) {
						// OpenType table offsets in a TTC are file-absolute, including Apple collections.
						return read(tables.readUInt32BE(at + 8), tables.readUInt32BE(at + 12));
					}
				}
				return null;
			};
			const names = await table("name");
			if (!names || names.length < 6) continue;
			const records: { id: number; value: string; english: boolean }[] = [];
			const storage = names.readUInt16BE(4);
			for (let i = 0; i < names.readUInt16BE(2); i++) {
				const at = 6 + i * 12;
				if (at + 12 > names.length) break;
				const platform = names.readUInt16BE(at);
				const id = names.readUInt16BE(at + 6);
				if (![1, 2, 16, 17].includes(id) || ![0, 3].includes(platform)) continue;
				const start = storage + names.readUInt16BE(at + 10);
				const end = start + names.readUInt16BE(at + 8);
				if (end > names.length) continue;
				let value = "";
				for (let j = start; j + 1 < end; j += 2) value += String.fromCharCode(names.readUInt16BE(j));
				value = value.replace(/\0/g, "").trim();
				if (value) records.push({ id, value, english: names.readUInt16BE(at + 4) === 0x409 });
			}
			const pick = (ids: number[]) => ids.flatMap(id => records.filter(r => r.id === id).sort((a, b) => Number(b.english) - Number(a.english)))[0]?.value;
			const family = pick([16, 1]);
			if (!family) continue;
			const subfamily = pick([17, 2]) ?? "Regular";
			const os2 = await table("OS/2");
			const weight = os2 && os2.length >= 6 ? os2.readUInt16BE(4) : /bold|黑體|粗體/i.test(subfamily) ? 700 : 400;
			const italic = os2 && os2.length >= 64 ? (os2.readUInt16BE(62) & 1) !== 0 : /italic|oblique/i.test(subfamily);
			faces.push({ family, aliases: [...new Set(records.filter(r => r.id === 1 || r.id === 16).map(r => r.value))], weight, style: italic ? "italic" : "normal", faceIndex });
		}
		return faces;
	} finally { await file.close(); }
}

export async function defaultSystemFontDirs(platform = process.platform, home = homedir()): Promise<string[]> {
	// The PDF engine bundles Noto Serif SC/Liberation fonts outside OS font
	// directories. Expose those same bytes to the editor to avoid a false
	// missing-font warning and different browser/PDF line measurements.
	const soffice = platform === process.platform ? await findSoffice().catch(() => null) : null;
	const officeFonts = soffice ? [platform === "darwin" ? join(dirname(soffice), "../Resources/fonts") : join(dirname(soffice), "../share/fonts")] : [];
	if (platform === "win32") return ["C:\\Windows\\Fonts", ...officeFonts];
	if (platform !== "darwin") return ["/usr/share/fonts", "/usr/local/share/fonts", join(home, ".fonts"), join(home, ".local/share/fonts"), ...officeFonts];
	const downloaded = "/System/Library/AssetsV2/com_apple_MobileAsset_Font8";
	const assets = await readdir(downloaded).catch(() => []);
	return [
		"/Library/Fonts", join(home, "Library/Fonts"), "/System/Library/Fonts", "/System/Library/Fonts/Supplemental",
		...assets.filter(name => name.endsWith(".asset")).map(name => join(downloaded, name, "AssetData")),
		// Office's installed font files are absent from the normal macOS font folders.
		...["Word", "Excel", "PowerPoint"].map(app => `/Applications/Microsoft ${app}.app/Contents/Resources/DFonts`),
		...officeFonts,
	];
}

/** One read-only catalog; opaque ids can only resolve to enumerated font files. */
export class SystemFontService {
	private pending?: Promise<SystemFontFace[]>;
	private files = new Map<string, { root: string; relative: string }>();
	constructor(private readonly roots: () => Promise<string[]> = defaultSystemFontDirs) {}
	list(): Promise<SystemFontFace[]> {
		return this.pending ??= this.scan();
	}
	private async scan(): Promise<SystemFontFace[]> {
		const result: SystemFontFace[] = [];
		const visit = async (root: string, relative = "", depth = 0): Promise<void> => {
			const path = await resolveContainedPathAsync(root, relative || ".");
			if (!path) return;
			for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
				const child = join(relative, entry.name);
				if (entry.isDirectory() && depth < 4) { await visit(root, child, depth + 1); continue; }
				if (!entry.isFile() || !FONT_EXTENSION.test(entry.name)) continue;
				const filePath = await resolveContainedPathAsync(root, child);
				if (!filePath) continue;
				const info = await stat(filePath).catch(() => null);
				if (!info || info.size > MAX_FONT_BYTES) continue;
				const metadata = await readFontMetadata(filePath).catch(() => []);
				for (const face of metadata) {
					const id = createHash("sha256").update(`${filePath}\0${info.mtimeMs}\0${face.faceIndex}`).digest("hex");
					if (this.files.has(id)) continue;
					this.files.set(id, { root, relative: child });
					result.push({ ...face, id });
				}
			}
		};
		for (const root of await this.roots()) await visit(root);
		return result;
	}
	async read(id: string): Promise<Buffer | null> {
		await this.list();
		const file = this.files.get(id);
		if (!file) return null;
		const path = await resolveContainedPathAsync(file.root, file.relative);
		if (!path) return null;
		const info = await stat(path).catch(() => null);
		if (!info?.isFile() || info.size > MAX_FONT_BYTES) return null;
		return readFile(path).catch(() => null);
	}
}

export const systemFonts = new SystemFontService();
