/**
 * L2 hybrid retrieval: lexical (BM25) + vector (cosine) fused via Reciprocal
 * Rank Fusion, then one-hop graph expansion over the wiki link graph.
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
 * the index store (getAllPages / getEmbeddings); at personal scale (hundreds of
 * short pages) this is cheap and keeps ranking logic out of SQL.
 */

import { buildAliasIndex, extractOutgoingLinks, pageStem } from "./wiki-links.js";
import { OVERVIEW_PATH } from "./wiki-graph.js";
import type { Embedder } from "./embeddings-client.js";
import type { L2IndexStore, L2PageMeta } from "./l2-index-store.js";

const RRF_K = 60;
const LEX_CANDIDATES = 30;
const VEC_CANDIDATES = 30;
const GRAPH_SEEDS = 8;
const WEIGHT_DIRECT_LINK = 0.5;
const WEIGHT_SOURCE_OVERLAP = 0.4;
const WEIGHT_ADAMIC_ADAR = 0.3;
const WEIGHT_TYPE_AFFINITY = 0.1;

export type L2SearchSignal = "lexical" | "vector" | "graph";

export interface L2SearchResult {
	path: string;
	title: string;
	type: string;
	score: number;
	via: L2SearchSignal[];
}

function cosine(a: Float32Array, b: Float32Array): number {
	// Both vectors are L2-normalized at store time / query time → dot product.
	const n = Math.min(a.length, b.length);
	let dot = 0;
	for (let i = 0; i < n; i++) dot += a[i] * b[i];
	return dot;
}

/**
 * Run the hybrid search. `embedder` is optional — when absent (or it fails),
 * vector recall is skipped and results come from lexical + graph only.
 */
export async function searchL2(
	store: L2IndexStore,
	query: string,
	opts: { embedder?: Embedder | null; limit?: number } = {},
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

	// ---- 1. lexical ----
	const lex = store.searchLexical(q, LEX_CANDIDATES);

	// ---- 2. vector ----
	let vec: { path: string; score: number }[] = [];
	if (opts.embedder) {
		const qv = await opts.embedder.embed([q]);
		if (qv.length === 1 && qv[0].length > 0) {
			const qvec = qv[0];
			vec = store
				.getEmbeddings()
				.map((e) => ({ path: e.path, score: cosine(qvec, e.vec) }))
				.sort((a, b) => b.score - a.score)
				.slice(0, VEC_CANDIDATES);
		}
	}

	// ---- 3. RRF fusion ----
	const rrf = new Map<string, number>();
	const via = new Map<string, Set<L2SearchSignal>>();
	const addVia = (path: string, sig: L2SearchSignal) =>
		(via.get(path) ?? via.set(path, new Set()).get(path)!).add(sig);

	lex.forEach((hit, rank) => {
		rrf.set(hit.path, (rrf.get(hit.path) ?? 0) + 1 / (RRF_K + rank));
		addVia(hit.path, "lexical");
	});
	vec.forEach((hit, rank) => {
		rrf.set(hit.path, (rrf.get(hit.path) ?? 0) + 1 / (RRF_K + rank));
		addVia(hit.path, "vector");
	});

	// ---- 4. one-hop graph expansion from top fused seeds ----
	const seeds = [...rrf.entries()].sort((a, b) => b[1] - a[1]).slice(0, GRAPH_SEEDS);
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

	// ---- 5. combine + rank ----
	const finalScore = new Map<string, number>();
	for (const [path, s] of rrf) finalScore.set(path, (finalScore.get(path) ?? 0) + s);
	for (const [path, s] of graph) finalScore.set(path, (finalScore.get(path) ?? 0) + s);

	const results: L2SearchResult[] = [...finalScore.entries()]
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

	return results;
}
