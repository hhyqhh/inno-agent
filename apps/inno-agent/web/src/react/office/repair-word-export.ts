import { unzipSync, zipSync, type Zippable } from "fflate";

const MC_NAMESPACE = "http://schemas.openxmlformats.org/markup-compatibility/2006";

/**
 * BetterOffice 0.4.3 re-declares the markup-compatibility namespace under an
 * auto-generated prefix (e.g. `xmlns:ns1`) on the same element that already
 * carries `mc:Ignorable`, so the exported root element holds two attributes
 * that both expand to `{markup-compatibility}Ignorable`. Strict XML parsers
 * reject that as a duplicate attribute, while the engine's own lenient
 * importer reopens the file happily — a successful editor round trip proves
 * nothing. Upstream fix pending (see docs/features/word-editor.md); until it
 * ships, drop the non-canonical duplicates here, before the export validator
 * runs. Only exact same-URI duplicates on one start tag are touched, and only
 * when both prefixes are declared on that tag (the shape the engine emits);
 * anything else is left for the validator to reject.
 */

interface TagRange {
	start: number;
	end: number;
}

/** Walk XML start tags honouring quoted attribute values; `>` may appear raw inside them. */
function forEachStartTag(xml: string, visit: (tag: string) => string): string {
	let out = "";
	let cursor = 0;
	while (cursor < xml.length) {
		const lt = xml.indexOf("<", cursor);
		if (lt < 0) { out += xml.slice(cursor); break; }
		out += xml.slice(cursor, lt);
		const next = xml[lt + 1];
		if (!next || !/[A-Za-z_]/.test(next)) {
			// Comment, CDATA, PI, doctype or end tag — copy through to its ">".
			const gt = xml.indexOf(">", lt);
			const through = gt < 0 ? xml.length : gt + 1;
			out += xml.slice(lt, through);
			cursor = through;
			continue;
		}
		let end = lt + 1;
		let quote = "";
		while (end < xml.length) {
			const ch = xml[end];
			if (quote) { if (ch === quote) quote = ""; }
			else if (ch === '"' || ch === "'") quote = ch;
			else if (ch === ">") break;
			end += 1;
		}
		end = Math.min(end + 1, xml.length);
		out += visit(xml.slice(lt, end));
		cursor = end;
	}
	return out;
}

/** Remove same-namespace duplicate `*:Ignorable` attributes from one start tag. */
export function dedupeIgnorableAttributes(tag: string): string {
	const ignorable = [...tag.matchAll(/\s([\w.-]+):Ignorable="[^"]*"/g)];
	if (ignorable.length < 2) return tag;
	const bindings = new Map<string, string>();
	for (const binding of tag.matchAll(/\sxmlns:([\w.-]+)="([^"]*)"/g)) bindings.set(binding[1], binding[2]);
	// Only prefixes declared on this tag can be resolved safely; `mc` is the
	// canonical binding even when declared on an ancestor.
	const resolve = (prefix: string): string | null => {
		if (prefix === "mc") return MC_NAMESPACE;
		return bindings.get(prefix) ?? null;
	};
	const groups = new Map<string, Array<{ match: RegExpExecArray; prefix: string }>>();
	for (const match of ignorable) {
		const prefix = match[1];
		const uri = resolve(prefix);
		if (uri === null) return tag; // unresolvable — leave the tag untouched
		const group = groups.get(uri) ?? [];
		group.push({ match, prefix });
		groups.set(uri, group);
	}
	let repaired = tag;
	for (const group of groups.values()) {
		if (group.length < 2) continue;
		const keep = group.find((entry) => entry.prefix === "mc") ?? group[0];
		for (const entry of group) {
			if (entry === keep) continue;
			repaired = repaired.replace(entry.match[0], "");
		}
	}
	return repaired;
}

/** True when the tag carries two same-URI `*:Ignorable` attributes. */
export function hasDuplicateIgnorable(tag: string): boolean {
	return dedupeIgnorableAttributes(tag) !== tag;
}

/**
 * Repair an engine-exported DOCX in place (returns a new buffer when anything
 * changed, the original buffer otherwise). Every part is re-emitted unchanged
 * except `.xml` ones that carried duplicates — dropping the filter would strip
 * [Content_Types].xml and media from the repacked archive.
 */
export function repairWordExport(buffer: ArrayBuffer): ArrayBuffer {
	let parts: ReturnType<typeof unzipSync>;
	try {
		parts = unzipSync(new Uint8Array(buffer));
	} catch {
		return buffer; // not a readable zip — leave it for the validator
	}
	const repaired: Zippable = {};
	let changed = false;
	for (const [name, bytes] of Object.entries(parts)) {
		let xml: string;
		try {
			xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			repaired[name] = bytes; // non-UTF-8 part — validator's business
			continue;
		}
		let touched = false;
		const next = forEachStartTag(xml, (tag) => {
			const fixed = dedupeIgnorableAttributes(tag);
			if (fixed !== tag) touched = true;
			return fixed;
		});
		if (touched) {
			changed = true;
			repaired[name] = new TextEncoder().encode(next);
		} else {
			repaired[name] = bytes;
		}
	}
	if (!changed) return buffer;
	return zipSync(repaired).slice().buffer;
}
