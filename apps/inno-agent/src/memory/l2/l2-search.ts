/**
 * L2 retrieval: lexical (BM25) candidate ranking, then one-hop graph expansion
 * over the wiki link graph.
 *
 * The graph signals mirror llm_wiki's relevance model, scaled down for a
 * personal-size wiki:
 *   - DIRECT_LINK   — pages connected via `[[wikilinks]]` (out-links + backlinks)
 *   - SOURCE_OVERLAP — pages sharing a raw source (frontmatter source_ids)
 *   - ADAMIC_ADAR   — pages sharing neighbors, weighted toward rare (low-degree) ones
 *   - TYPE_AFFINITY  — small bonus for same page type
 * Two-hop expansion is intentionally avoided (explodes / dilutes on a small graph).
 *
 * Link resolution uses the shared alias index (wiki-links.ts) so retrieval and
 * the graph viz resolve `[[links]]` identically. Everything runs in-memory from
 * the index store; at personal scale (hundreds of short pages) this is cheap
 * and keeps ranking logic out of SQL.
 */

import { buildAliasIndex, extractOutgoingLinks, pageStem } from "./wiki-links.js";
import { OVERVIEW_PATH } from "./wiki-graph.js";
import type { L2IndexStore, L2PageMeta } from "./l2-index-store.js";

/** Rank-decay constant for turning a lexical rank into a base score. */
const RANK_DECAY_K = 60;
const LEX_CANDIDATES = 30;
const GRAPH_SEEDS = 8;
const WEIGHT_DIRECT_LINK = 0.5;
const WEIGHT_SOURCE_OVERLAP = 0.4;
const WEIGHT_ADAMIC_ADAR = 0.3;
const WEIGHT_TYPE_AFFINITY = 0.1;

export type L2SearchSignal = "lexical" | "graph";

export interface L2SearchResult {
	path: string;
	title: string;
	type: string;
	score: number;
	via: L2SearchSignal[];
}

/**
 * Run the search: BM25 lexical candidates seed a one-hop graph expansion.
 */
export async function searchL2(
	store: L2IndexStore,
	query: string,
	opts: { limit?: number } = {},
): Promise<L2SearchResult[]> {
	const q = query.trim();
	if (!q) return [];
	const limit = opts.limit ?? 5;

	const pages = store.getAllPages();
	if (pages.length === 0) return [];
	const byPath = new Map<string, L2PageMeta>(pages.map((p) => [p.path, p]));

	// Undirected resolved-link adjacency, via the shared alias index.
	const alias = buildAliasIndex(pages);
	const adj = new Map<string, Set<string>>();
	for (const p of pages) adj.set(p.path, new Set());
	for (const p of pages) {
		if (p.path === OVERVIEW_PATH) continue; // meta page — keep it out of the link graph
		for (const link of extractOutgoingLinks(p.body)) {
			const target = alias.resolve(link);
			if (!target || target === p.path || !adj.has(target)) continue;
			adj.get(p.path)!.add(target);
			adj.get(target)!.add(p.path);
		}
	}
	const degree = (path: string): number => adj.get(path)?.size ?? 0;

	// ---- 1. lexical candidates → rank-decay base score ----
	const base = new Map<string, number>();
	const via = new Map<string, Set<L2SearchSignal>>();
	const addVia = (path: string, sig: L2SearchSignal) =>
		(via.get(path) ?? via.set(path, new Set()).get(path)!).add(sig);

	store.searchLexical(q, LEX_CANDIDATES).forEach((hit, rank) => {
		base.set(hit.path, (base.get(hit.path) ?? 0) + 1 / (RANK_DECAY_K + rank));
		addVia(hit.path, "lexical");
	});

	// ---- 2. one-hop graph expansion from top lexical seeds ----
	const seeds = [...base.entries()].sort((a, b) => b[1] - a[1]).slice(0, GRAPH_SEEDS);
	const graph = new Map<string, number>();
	const bump = (path: string, amount: number) => {
		graph.set(path, (graph.get(path) ?? 0) + amount);
		addVia(path, "graph");
	};
	for (const [seedPath, seedScore] of seeds) {
		const seed = byPath.get(seedPath);
		if (!seed) continue;
		const seedNeighbors = adj.get(seedPath) ?? new Set();

		// direct-link + type-affinity neighbors
		for (const nb of seedNeighbors) {
			const nbPage = byPath.get(nb);
			if (!nbPage) continue;
			let w = WEIGHT_DIRECT_LINK;
			if (nbPage.type === seed.type) w += WEIGHT_TYPE_AFFINITY;
			bump(nb, seedScore * w);
		}

		// Adamic-Adar: pages sharing neighbors with the seed, weighted toward
		// rare (low-degree) shared neighbors. Σ_{w∈N(seed)∩N(c)} 1/log(1+deg(w)).
		const aa = new Map<string, number>();
		for (const w of seedNeighbors) {
			const wDeg = degree(w);
			if (wDeg < 2) continue; // a neighbor shared by <2 pages carries no AA signal
			const contribution = 1 / Math.log(1 + wDeg);
			for (const c of adj.get(w) ?? []) {
				if (c === seedPath || seedNeighbors.has(c)) continue; // skip seed + direct neighbors
				aa.set(c, (aa.get(c) ?? 0) + contribution);
			}
		}
		for (const [c, score] of aa) bump(c, seedScore * WEIGHT_ADAMIC_ADAR * score);

		// source-overlap neighbors
		if (seed.sourceIds.length > 0) {
			const seedIds = new Set(seed.sourceIds);
			for (const other of pages) {
				if (other.path === seedPath) continue;
				if (other.sourceIds.some((id) => seedIds.has(id))) {
					bump(other.path, seedScore * WEIGHT_SOURCE_OVERLAP);
				}
			}
		}
	}

	// ---- 3. combine + rank ----
	const finalScore = new Map<string, number>();
	for (const [path, s] of base) finalScore.set(path, (finalScore.get(path) ?? 0) + s);
	for (const [path, s] of graph) finalScore.set(path, (finalScore.get(path) ?? 0) + s);

	return [...finalScore.entries()]
		.map(([path, score]) => {
			const p = byPath.get(path);
			return {
				path,
				title: p?.title ?? pageStem(path),
				type: p?.type ?? "",
				score,
				via: [...(via.get(path) ?? [])],
			};
		})
		.filter((r) => byPath.has(r.path))
		.sort((a, b) => b.score - a.score)
		.slice(0, limit);
}
