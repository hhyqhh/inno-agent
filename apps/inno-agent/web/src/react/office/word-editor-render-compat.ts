/** Narrow fixes for the pinned 2.32.0 adapter; never rewrite the DOCX package. */
const CHUNK = "/@docx-editor.dev/core/dist/chunk-GDS24SZN.js";
const FONT_LIMIT_CHUNK = "/@docx-editor.dev/core/dist/chunk-DDFHKQFU.js";
const MARK = "innoStyleForFontSlot";

export function patchWordEditorRendering(code: string, id: string): string | null {
	const path = id.replace(/\\/g, "/").split("?", 1)[0];
	if (path.endsWith(FONT_LIMIT_CHUNK)) {
		// A real CJK report already uses 94 MiB. Choosing YaHei adds 35 MiB,
		// exceeding the Western-oriented 128 MiB aggregate limit even after
		// alias deduplication. Keep the 64 MiB per-face limit and a bounded
		// 256 MiB aggregate, shared by admission, composition and HarfBuzz.
		if (code.includes("/* inno CJK aggregate */")) return code;
		if (code.split("xp=128*1024*1024").length !== 2) throw new Error("EigenPal 2.32.0 font budget patch no longer matches; review before upgrading.");
		return code.replace("xp=128*1024*1024", "xp=256*1024*1024/* inno CJK aggregate */");
	}
	if (!path.endsWith(CHUNK)) return null;
	if (code.includes(MARK)) return code;
	const replacements: [string, string][] = [
		// A TTC can contain several unrelated faces. The browser adapter already
		// extracts N1 for paint, but shaping retained the entire collection per
		// face (YaHei regular + bold alone cost 36 MB). Admit the selected SFNT
		// once, using the SAME validated extractor for measurement and paint.
		["let a=t.faceIndex??0,s=l(e,a);return s.valid?", "let a=t.faceIndex??0,s=l(e,a);if(s.valid&&e[0]===116&&e[1]===116&&e[2]===99&&e[3]===102){try{e=N1(e,a);a=0;s=l(e,a)}catch(error){s={valid:false,diagnostic:error instanceof Error?error.message:String(error)}}}return s.valid?"],
		// The family picker applies to the selected text, including Chinese.
		// Upstream writes only Western slots, leaving inherited eastAsia/cs in
		// effect even after the toolbar says the new font was applied.
		["attributes:{ascii:n,hAnsi:n}", "attributes:{ascii:n,hAnsi:n,eastAsia:n,cs:n}"],
		// documentFonts includes latent styles. Loading four cuts of each unused
		// CJK family overflowed the engine's 128 MB aggregate budget (169 MB in
		// green_island_report), dropping required faces later in the request.
		["...e.documentFonts()", "...e.renderedFontFamilies()"],
		// Layout spans retain both authored font slots. Read the SAME effective
		// face as measurement/paint: Chinese must not report the ASCII face,
		// and a range crossing different faces must retain the upstream null.
		["g=_=>_.style.fontFamily??n?.(_.range.paragraphId,_.props).fontFamily??null", "g=_=>innoStyleForFontSlot(_.style,_.fontSlot).fontFamily??n?.(_.range.paragraphId,_.props).fontFamily??null"],
	];
	for (const [before, after] of replacements) {
		if (code.split(before).length !== 2) throw new Error("EigenPal 2.32.0 rendering patch no longer matches; review before upgrading.");
		code = code.replace(before, after);
	}
	return 'import {xa as innoStyleForFontSlot} from "./chunk-DDFHKQFU.js";\n' + code;
}
