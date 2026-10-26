import { configureDefaultFonts } from "@betteroffice/docx-react";
import type { BundledFontProvider } from "@betteroffice/docx/layout";

/**
 * Real-font layer: the server enumerates the machine's installed fonts so a
 * document asking for 宋体 or Times New Roman renders with the actual system
 * face instead of the bundled metric substitutes. Resolution falls through to
 * the bundled provider for every family the OS does not have.
 */

export interface SystemFontFace {
	family: string;
	weight: number;
	style: "normal" | "italic";
	file: string;
}

/** Word-side names → the family names macOS/Windows/Linux actually ship. */
const SYSTEM_FONT_ALIASES: Record<string, readonly string[]> = {
	"宋体": ["simsun", "songti", "songti sc", "stsong", "宋體-簡", "宋體-繁", "宋體"],
	"simsun": ["songti", "songti sc", "stsong", "宋體-簡"],
	"nsimsun": ["songti", "songti sc"],
	"新宋体": ["songti", "songti sc"],
	"仿宋": ["fangsong", "stfangsong"],
	"fangsong": ["stfangsong"],
	"楷体": ["kaiti", "kaiti sc", "stkaiti"],
	"kaiti": ["kaiti sc", "stkaiti"],
	"楷体_gb2312": ["kaiti", "kaiti sc"],
	"黑体": ["simhei", "heiti", "heiti sc", "stheiti", "黑體-簡", "黑體-繁", "heiti tc"],
	"simhei": ["heiti", "heiti sc", "stheiti", "黑體-簡"],
	"微软雅黑": ["microsoft yahei", "pingfang sc", "pingfang"],
	"microsoft yahei": ["pingfang sc", "pingfang"],
	"msyh": ["microsoft yahei", "pingfang sc"],
	"等线": ["dengxian"],
};

function normalizeFamily(name: string): string {
	return name.trim().toLowerCase();
}

function candidateNames(family: string): string[] {
	const key = normalizeFamily(family);
	return [key, ...(SYSTEM_FONT_ALIASES[key] ?? [])];
}

/** Pick the closest face of one family: exact style first, then regular. */
function selectFace(faces: readonly SystemFontFace[], bold: boolean, italic: boolean, strict: boolean): SystemFontFace | undefined {
	const wantWeight = bold ? 700 : 400;
	const wantStyle = italic ? "italic" : "normal";
	if (strict) return faces.find((face) => face.weight === wantWeight && face.style === wantStyle);
	return faces.find((face) => face.style === wantStyle && face.weight === wantWeight)
		?? faces.find((face) => face.style === wantStyle)
		?? faces.find((face) => face.weight === wantWeight)
		?? faces[0];
}

/**
 * Match a Word family against the machine's font index. Family names compare
 * case-insensitively with the alias table bridging Microsoft names to the
 * Apple/Linux faces that stand in for them on this machine.
 */
export function matchSystemFace(index: readonly SystemFontFace[], family: string, bold: boolean, italic: boolean, strict = false): SystemFontFace | undefined {
	const byFamily = new Map<string, SystemFontFace[]>();
	for (const face of index) {
		const key = normalizeFamily(face.family);
		const bucket = byFamily.get(key);
		if (bucket) bucket.push(face); else byFamily.set(key, [face]);
	}
	// A bold request skips families that only ship light/regular cuts (e.g.
	// STSong) so a later alias can supply a real bold face — and falls through
	// to the bundled bold provider when none does. Rendering bold text with a
	// 400 face is what made 试卷 titles look un-bold.
	const usable = (faces?: SystemFontFace[]): SystemFontFace[] | undefined => {
		if (!faces?.length) return undefined;
		if (bold && !faces.some((face) => face.weight >= 600)) return undefined;
		return faces;
	};
	const bucketsFor = (candidate: string): SystemFontFace[] | undefined => {
		const exact = usable(byFamily.get(candidate));
		if (exact) return exact;
		for (const [key, faces] of byFamily) {
			if (key.startsWith(candidate) || candidate.startsWith(key)) {
				const prefixed = usable(faces);
				if (prefixed) return prefixed;
			}
		}
		return undefined;
	};
	for (const candidate of candidateNames(family)) {
		const faces = bucketsFor(candidate);
		if (faces) return selectFace(faces, bold, italic, strict);
	}
	return undefined;
}

export interface SystemFontLayer {
	/** Fetches the index once; failures leave the layer empty (bundled fallback). */
	ready(): Promise<void>;
	resolve(family: string, bold: boolean, italic: boolean): (() => Promise<ArrayBuffer>) | undefined;
	resolveFamily(family: string, bold: boolean, italic: boolean): (() => Promise<ArrayBuffer>) | undefined;
}

/**
 * Client of the server's font endpoints. The engine's provider contract is
 * synchronous, so the index warms through {@link ready} before the provider
 * is built; a failed or empty index (web deployment without the server, IO
 * errors) degrades to "no system faces" and everything falls through to the
 * bundled provider.
 */
export function createSystemFontLayer(indexUrl = "/api/system/fonts", fileUrl: (file: string) => string = (file) => `/api/system/fonts/file?file=${encodeURIComponent(file)}`): SystemFontLayer {
	let faces: SystemFontFace[] = [];
	const loaders = new Map<string, Promise<ArrayBuffer>>();
	const loadBytes = (file: string): Promise<ArrayBuffer> => {
		const pending = loaders.get(file);
		if (pending) return pending;
		const request = fetch(fileUrl(file)).then((response) => {
			if (!response.ok) throw new Error(`font fetch HTTP ${response.status}`);
			return response.arrayBuffer();
		});
		request.catch(() => { if (loaders.get(file) === request) loaders.delete(file); });
		loaders.set(file, request);
		return request;
	};
	return {
		async ready() {
			try {
				const response = await fetch(indexUrl);
				const body = response.ok ? await response.json() as { faces?: SystemFontFace[] } : {};
				faces = body.faces ?? [];
			} catch {
				faces = [];
			}
		},
		resolve(family, bold, italic) {
			const face = matchSystemFace(faces, family, bold, italic);
			return face ? () => loadBytes(face.file) : undefined;
		},
		// Strict per the contract: no style substitution for direct family asks.
		resolveFamily(family, bold, italic) {
			const face = matchSystemFace(faces, family, bold, italic, true);
			return face ? () => loadBytes(face.file) : undefined;
		},
	};
}

/** System faces win; the bundled metric substitutes cover everything else. */
export function composeFontProviders(primary: SystemFontLayer, fallback: BundledFontProvider): BundledFontProvider {
	return {
		resolve(family, bold, italic) { return primary.resolve(family, bold, italic) ?? fallback.resolve(family, bold, italic); },
		resolveFamily(family, bold, italic) { return primary.resolveFamily(family, bold, italic) ?? fallback.resolveFamily?.(family, bold, italic); },
		resolveScriptFallback(script, bold, italic) { return fallback.resolveScriptFallback?.(script, bold, italic); },
		resolveLastResort(family, bold, italic, office) { return fallback.resolveLastResort?.(family, bold, italic, office); },
	};
}

/**
 * Upstream @betteroffice/fonts-cjk 0.4.0 ships the Simplified Chinese faces in
 * Regular only. For a bold run the bundled resolver falls back to that Regular
 * face (the manifest has no 700 entry), so measurement stays Word-accurate but
 * the glyph path paints regular outlines and bold headings render thin — Word
 * itself shows SimSun bold as synthetic emboldening over regular metrics.
 *
 * The two faces here are the same Noto CJK "Subset OTF SC" builds the Regular
 * faces in @betteroffice/fonts-cjk come from (byte-identical family sources,
 * so advances match the measured face), bundled under SIL OFL 1.1 — see the
 * LICENSE next to the .otf files and web/public/fonts/word/README.md.
 */
const SERIF_BOLD_FAMILIES = new Set([
	// The serif group of the upstream WORD_FAMILY_ALIASES table, which all
	// resolve to the SimSun-metric Noto Serif SC face.
	"simsun",
	"nsimsun",
	"fangsong",
	"kaiti",
	"宋体",
	"新宋体",
	"仿宋",
	"楷体",
	"仿宋_gb2312",
	"楷体_gb2312",
]);
const SANS_BOLD_FAMILIES = new Set([
	// The sans group, which resolves to the Microsoft YaHei-metric Noto Sans SC.
	"simhei",
	"dengxian",
	"microsoft yahei",
	"msyh",
	"黑体",
	"微软雅黑",
	"等线",
]);
// Families under their resolved bundled names (resolveFamily receives those).
const BUNDLED_BOLD_FAMILIES: Record<string, "serif" | "sans"> = {
	"noto serif sc": "serif",
	"noto sans sc": "sans",
};

type FaceLoader = () => Promise<ArrayBuffer>;

const boldBytes = new Map<"serif" | "sans", Promise<ArrayBuffer>>();
function loadBoldBytes(face: "serif" | "sans"): Promise<ArrayBuffer> {
	const cached = boldBytes.get(face);
	if (cached) return cached;
	const file = face === "serif" ? "NotoSerifSC-Bold.otf" : "NotoSansSC-Bold.otf";
	const promise = (async () => {
		const response = await fetch(new URL(`./fonts/${file}`, import.meta.url), { credentials: "same-origin" });
		if (!response.ok) throw new Error(`Failed to fetch bundled CJK bold face ${file}: HTTP ${response.status}`);
		return response.arrayBuffer();
	})();
	promise.catch(() => {
		if (boldBytes.get(face) === promise) boldBytes.delete(face);
	});
	boldBytes.set(face, promise);
	return promise;
}

/**
 * Wrap the bundled provider so bold requests for the Chinese alias families
 * get real Bold outlines instead of the Regular fallback. Measurement is not
 * affected: Noto SC Bold shares the Regular's advances, and the engine keeps
 * applying Word's own SimSun/YaHei vertical metrics on top.
 */
export function wrapCjkBoldProvider(
	base: BundledFontProvider,
	loadBytes: (face: "serif" | "sans") => Promise<ArrayBuffer> = loadBoldBytes,
): BundledFontProvider {
	const boldFace = (family: string): "serif" | "sans" | undefined => {
		const key = family.trim().toLowerCase();
		if (SERIF_BOLD_FAMILIES.has(key) || BUNDLED_BOLD_FAMILIES[key] === "serif") return "serif";
		if (SANS_BOLD_FAMILIES.has(key) || BUNDLED_BOLD_FAMILIES[key] === "sans") return "sans";
		return undefined;
	};
	return {
		resolve(family, bold, italic) {
			if (bold) {
				const face = boldFace(family);
				if (face) return () => loadBytes(face);
			}
			return base.resolve(family, bold, italic);
		},
		resolveFamily(family, bold, italic) {
			if (bold) {
				const face = boldFace(family);
				if (face) return () => loadBytes(face);
			}
			return base.resolveFamily?.(family, bold, italic);
		},
		// The upstream fallback prefers the sans face within the cjk-sc bucket.
		resolveScriptFallback(script, bold, italic) {
			if (bold && script === "cjk-sc") return () => loadBytes("sans");
			return base.resolveScriptFallback?.(script, bold, italic);
		},
		resolveLastResort(family, bold, italic, office) {
			return base.resolveLastResort?.(family, bold, italic, office);
		},
	};
}

let configured = false;
/** Idempotent; swaps WordEditor's plain font source for system-first resolution with the CJK-bold-aware bundled fallback. */
export function configureWordFonts(): void {
	if (configured) return;
	configured = true;
	// The engine consumes the loader result structurally (createFontProvider),
	// so a shim module wrapping the real provider needs no other surface.
	configureDefaultFonts({
		load: async () => {
			const fonts = await import("@betteroffice/fonts");
			// Warm the system font index before the provider exists: resolution is synchronous.
			const system = createSystemFontLayer();
			await system.ready();
			return {
				createFontProvider: (options?: { baseUrl?: string | URL }) =>
					composeFontProviders(system, wrapCjkBoldProvider(fonts.createFontProvider(options))),
			};
		},
	});
}
