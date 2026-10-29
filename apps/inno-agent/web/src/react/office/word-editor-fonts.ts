import { composeFontConfiguration, createFontSource, defineFontResolver, type FontConfigurationFragment, type FontResolutionRequest } from "@docx-editor.dev/core/editor";
import { packagedFonts } from "@docx-editor.dev/fonts";
import { cjkFonts } from "@docx-editor.dev/fonts-cjk/browser";
import type { FontSource } from "@docx-editor.dev/core/contracts/editor";

export interface LocalFontFace {
	family: string;
	aliases: string[];
	weight: number;
	style: "normal" | "italic";
	id: string;
	faceIndex: number;
}

const normalize = (name: string) => name.trim().toLowerCase();
const faceBytes = new Map<string, Promise<Uint8Array>>();
function readFace(face: LocalFontFace): Promise<Uint8Array> {
	let pending = faceBytes.get(face.id);
	if (!pending) {
		pending = fetch(`/api/settings/fonts/${encodeURIComponent(face.id)}`).then(async response => {
			if (!response.ok) throw new Error("Local font unavailable");
			return new Uint8Array(await response.arrayBuffer());
		}).catch(error => { faceBytes.delete(face.id); throw error; });
		faceBytes.set(face.id, pending);
	}
	return pending;
}

/** Localized names are metadata aliases, not permission to fetch arbitrary URLs. */
export async function resolveLocalFonts(request: FontResolutionRequest, catalog: readonly LocalFontFace[], read = readFace): Promise<FontConfigurationFragment> {
	const sources: FontSource[] = [];
	const physicalSources = new Map<string, FontSource>();
	const substitutions: NonNullable<FontConfigurationFragment["substitutions"]>[number][] = [];
	for (const family of new Set([...request.families, request.defaultFamily])) {
		const candidates = catalog.filter(face => [face.family, ...face.aliases].some(name => normalize(name) === normalize(family)));
		const admitted: { face: LocalFontFace; source: Pick<FontSource, "request"> }[] = [];
		const seen = new Set<string>();
		// Only regular/bold upright/italic cuts are requested by this editor.
		// Loading every installed CJK weight exhausts its aggregate byte budget.
		const selected = new Set([400, 700].flatMap(weight => ["normal", "italic"].map(style =>
			[...candidates].sort((a, b) => (Number(a.style !== style) * 1000 + Math.abs(a.weight - weight)) - (Number(b.style !== style) * 1000 + Math.abs(b.weight - weight)))[0],
		)).filter(Boolean));
		for (const face of selected) {
			const key = `${face.weight}:${face.style}`;
			if (seen.has(key)) continue;
			// A later picker request may use 微软雅黑 after the document loaded
			// Microsoft YaHei. Those names share one physical face. Re-admitting
			// its large TTC under another name overflowed the aggregate budget.
			const resolved = request.resolvedFaces?.find(requested => requested.weight === face.weight && requested.style === face.style &&
				[face.family, ...face.aliases].some(name => normalize(name) === normalize(requested.family)));
			if (resolved) {
				admitted.push({ face, source: { request: resolved } }); seen.add(key);
				continue;
			}
			try {
				const sourceKey = `${face.id}:${key}`;
				const existing = physicalSources.get(sourceKey);
				// Keep the document's own spelling on the first source. Renaming
				// 宋体 to its metadata alias SimSun triggered a false substitution
				// notice even though the exact installed glyphs were admitted.
				const result = existing ? { source: existing } : createFontSource(await read(face), { family, weight: face.weight, style: face.style, faceIndex: face.faceIndex }, { id: `local:${face.id}` });
				if ("source" in result) {
					if (!existing) { sources.push(result.source); physicalSources.set(sourceKey, result.source); }
					admitted.push({ face, source: result.source }); seen.add(key);
				}
			} catch { /* An unreadable local face leaves the packaged resolver available. */ }
		}
		// Chinese families often have only one upright face. Prefer that family's
		// installed glyphs for missing cuts over changing 宋体 into Japanese sans.
		for (const weight of [400, 700]) for (const style of ["normal", "italic"] as const) {
			if (seen.has(`${weight}:${style}`) && admitted.some(a => a.source.request.family === family)) continue;
			const closest = [...admitted].sort((a, b) => (Number(a.face.style !== style) * 1000 + Math.abs(a.face.weight - weight)) - (Number(b.face.style !== style) * 1000 + Math.abs(b.face.weight - weight)))[0];
			if (closest) substitutions.push({ from: { family, weight, style }, to: closest.source.request });
		}
	}
	return { sources, substitutions };
}

// KaTeX_Size1–4 carry the progressively larger delimiter glyphs ( ) [ ] { }
// drawn with math-appropriate stroke weights. The word editor's OMML layout
// (see word-editor-math-compat.ts) renders equation delimiters from these
// faces instead of scaling up a body-font glyph, whose strokes fatten with
// the multiplier. Same fonts the chat math renderer already ships.
const MATH_DELIM_FAMILIES = ["InnoMathDelim1", "InnoMathDelim2", "InnoMathDelim3", "InnoMathDelim4"];
let mathDelimFaces: Promise<FontSource[] | null> | undefined;
function loadMathDelimiterFaces(): Promise<FontSource[] | null> {
	return mathDelimFaces ??= (async () => {
		try {
			const sources: FontSource[] = [];
			for (const [index, family] of MATH_DELIM_FAMILIES.entries()) {
				const response = await fetch(`/fonts/math/KaTeX_Size${index + 1}-Regular.ttf`);
				if (!response.ok) return null;
				const created = createFontSource(
					new Uint8Array(await response.arrayBuffer()),
					{ family, weight: 400, style: "normal" },
					{ id: `math-delims-${index + 1}` },
				);
				if (!("source" in created)) {
					return null;
				}
				sources.push(created.source);
			}
			(globalThis as { __innoMathDelimFamilies?: readonly string[] }).__innoMathDelimFamilies = MATH_DELIM_FAMILIES;
			return sources;
		} catch {
			return null;
		}
	})();
}

async function loadFonts() {
	let degraded = false;
	const onFailure = () => { degraded = true; pending = undefined; };
	const western = packagedFonts({ onFailure });
	const catalog = await fetch("/api/settings/fonts").then(async response => {
			if (!response.ok) return [] as LocalFontFace[];
			return (await response.json() as { faces: LocalFontFace[] }).faces;
		}).catch(() => [] as LocalFontFace[]);
	const cjk = cjkFonts({ onFailure });
	const configuration = defineFontResolver(async request => {
		const local = await resolveLocalFonts(request, catalog);
		const covered = (fragment: FontConfigurationFragment) => [...(fragment.sources ?? []).map(source => source.request), ...(fragment.substitutions ?? []).map(substitution => substitution.from)];
		const packaged = await western({ ...request, resolvedFaces: [...request.resolvedFaces ?? [], ...covered(local)] });
		const resolved = composeFontConfiguration(local, packaged);
		const fallback = await cjk({ ...request, resolvedFaces: [
			...request.resolvedFaces ?? [],
			...resolved.sources.map(source => source.request),
			...(resolved.substitutions ?? []).map(substitution => substitution.from),
		] });
		// Real face bytes win over stand-ins; layout and browser paint receive
		// the SAME face, including the selected face of a TTC collection.
		const result = composeFontConfiguration(local, packaged, fallback);
		const delimiters = await loadMathDelimiterFaces();
		const configured = delimiters ? { ...result, sources: [...result.sources, ...delimiters] } : result;
		return configured;
	});
	return { configuration, get degraded() { return degraded; } };
}

let pending: ReturnType<typeof loadFonts> | undefined;

export function loadWordEditorFonts(): ReturnType<typeof loadFonts> {
	return pending ??= loadFonts().then((result) => {
		// A later open/retry should be able to recover from a transient fetch error.
		if (result.degraded) pending = undefined;
		return result;
	}, (error: unknown) => {
		pending = undefined;
		throw error;
	});
}
