/**
 * Wiki link resolution — the single source of truth for turning a `[[link]]`
 * into a page path. Shared by the graph builder (visualization) and the search
 * layer (retrieval graph expansion) so the two never drift.
 *
 * Resolution is alias-based and tolerant of the mismatches seen in real data:
 * full-width/half-width, case, whitespace, and — most importantly — trailing
 * parenthetical suffixes, e.g. a body link `[[GRPO（Group Relative Policy
 * Optimization）]]` resolving to a page titled `GRPO`. Ambiguous bases (two
 * different pages normalizing to the same key) are recorded as unresolvable
 * rather than mis-merged.
 */

/** Normalize a link/title: strip alias part, lowercase, full-width→half-width, collapse spaces. */
export function normalizeWikiLink(s: string): string {
	return s
		.split("|")[0]
		.trim()
		.toLowerCase()
		.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)) // full-width ASCII
		.replace(/　/g, " ") // ideographic space
		.replace(/\s+/g, " ")
		.trim();
}

/** Strip a single trailing parenthetical suffix: `GRPO（Group…）` / `X (full name)` → base. */
export function stripParenthetical(s: string): string {
	return s.replace(/[（(][^（()）]*[)）]\s*$/, "").trim();
}

/** Filename stem of a wiki-relative path (no dir, no `.md`). */
export function pageStem(path: string): string {
	return (path.split("/").pop() ?? path).replace(/\.md$/, "");
}

/** Extract raw `[[link]]` targets (alias part stripped) from a page body. */
export function extractOutgoingLinks(body: string): string[] {
	const out: string[] = [];
	const re = /\[\[([^\]]+)\]\]/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(body)) !== null) {
		const t = m[1].split("|")[0].trim();
		if (t) out.push(t);
	}
	return out;
}

export interface AliasIndex {
	/** Resolve a link to a page path, or null when unresolved/ambiguous. */
	resolve(link: string): string | null;
}

/**
 * Build an alias index over pages. `primary` holds exact-ish keys (normalized
 * title, stem, path); `base` holds parenthetical-stripped titles with a null
 * sentinel when two pages collide (so we never mis-merge distinct pages).
 */
export function buildAliasIndex(pages: { path: string; title: string }[]): AliasIndex {
	const primary = new Map<string, string>();
	const base = new Map<string, string | null>();

	const addBase = (key: string, path: string) => {
		if (!key) return;
		if (base.has(key)) {
			if (base.get(key) !== path) base.set(key, null); // ambiguous
		} else {
			base.set(key, path);
		}
	};

	for (const p of pages) {
		const nTitle = normalizeWikiLink(p.title);
		if (nTitle) primary.set(nTitle, p.path);
		const nStem = normalizeWikiLink(pageStem(p.path));
		if (nStem && !primary.has(nStem)) primary.set(nStem, p.path);
		primary.set(p.path.toLowerCase(), p.path);
		addBase(normalizeWikiLink(stripParenthetical(p.title)), p.path);
	}

	return {
		resolve(link: string): string | null {
			const n = normalizeWikiLink(link);
			if (primary.has(n)) return primary.get(n)!;
			const linkBase = normalizeWikiLink(stripParenthetical(link));
			if (linkBase !== n && primary.has(linkBase)) return primary.get(linkBase)!;
			// Match a (possibly-fuller) link against the parenthetical-stripped page index.
			const b = base.get(n);
			if (b) return b;
			const bb = base.get(linkBase);
			if (bb) return bb;
			return null;
		},
	};
}
