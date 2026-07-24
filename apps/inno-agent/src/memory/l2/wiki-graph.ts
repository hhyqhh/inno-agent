/**
 * Wiki link graph builder + graph analysis.
 *
 * Builds the `[[link]]` + tag graph for the `/api/wiki/graph` endpoint, and
 * computes algorithmic graph metrics used for maintenance and the overview:
 *   - link resolution via the shared alias index (fewer phantom nodes)
 *   - node degree (resolved links only)
 *   - Louvain communities + modularity + per-community cohesion
 *   - maintenance signals: missing (dangling) links, orphan pages, possible
 *     duplicate pages, and contested pages
 *
 * The output stays backward-compatible with the previous shape ({nodes, edges}
 * with node {id,title,type,tags} and edge {source,target,type}); new fields are
 * additive so the existing frontend keeps working.
 */

import { readdirSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { UndirectedGraph } from "graphology";
import louvainImport from "graphology-communities-louvain";

// The louvain package's default export is typed awkwardly under Node16 CJS/ESM
// interop; pin the one method we use to a local type.
type LouvainDetailed = (g: unknown) => { communities: Record<string, number>; modularity: number; count: number };
const louvainDetailed = (louvainImport as unknown as { detailed: LouvainDetailed }).detailed;
import { readText, fileExists } from "../../storage/file-store.js";
import { parseFrontmatter } from "./wiki-maintainer.js";
import { buildAliasIndex, extractOutgoingLinks, normalizeWikiLink, stripParenthetical } from "./wiki-links.js";

const WIKI_SUBDIRS = ["sources", "entities", "concepts", "analysis"] as const;

/** Cohesion below this (for communities of at least MIN_COMMUNITY_SIZE) is flagged. */
const LOW_COHESION_THRESHOLD = 0.15;
const MIN_COMMUNITY_SIZE = 3;

/**
 * The generated overview page. It is a meta/summary page (links to the top
 * nodes it was derived from), so including it in the graph would add a
 * "connects everything" super-node AND inflate the degree of exactly the nodes
 * it ranks — a feedback loop. It is therefore excluded from the graph.
 */
export const OVERVIEW_PATH = join("wiki", "analysis", "overview.md");

export interface WikiGraphNode {
	id: string;
	title: string;
	type: string;
	tags: string[];
	/** Resolved-link degree (page nodes only). */
	degree?: number;
	/** Louvain community id (page nodes only). */
	community?: number;
}
export interface WikiGraphEdge {
	source: string;
	target: string;
	type: "link" | "tag";
}
export interface WikiGraphMaintenance {
	/** `[[links]]` that resolve to no page. */
	missing: { from: string; link: string }[];
	/** Page paths with no resolved link in or out. */
	orphans: string[];
	/** Groups of page paths whose titles collapse to the same base (possible dups). */
	duplicates: string[][];
	/** Page paths flagged `contested: true`. */
	contested: string[];
}
export interface WikiGraphCommunities {
	count: number;
	modularity: number;
	lowCohesion: { community: number; cohesion: number; size: number }[];
}
export interface WikiGraph {
	nodes: WikiGraphNode[];
	edges: WikiGraphEdge[];
	maintenance: WikiGraphMaintenance;
	communities: WikiGraphCommunities;
}

interface PageRecord {
	path: string;
	title: string;
	type: string;
	tags: string[];
	body: string;
	contested: boolean;
}

function inferTypeFromPath(wikiPath: string): string {
	if (wikiPath.includes("entities/")) return "entity";
	if (wikiPath.includes("concepts/")) return "concept";
	if (wikiPath.includes("analysis/")) return "analysis";
	return "source-summary";
}

/** Read all wiki pages (excluding the generated overview). */
function readAllPages(l2DataDir: string): PageRecord[] {
	const pages: PageRecord[] = [];
	for (const sub of WIKI_SUBDIRS) {
		const dir = join(l2DataDir, "wiki", sub);
		if (!fileExists(dir)) continue;
		let files: string[];
		try {
			files = readdirSync(dir);
		} catch {
			continue;
		}
		for (const file of files) {
			if (!file.endsWith(".md")) continue;
			const wikiPath = join("wiki", sub, file);
			if (wikiPath === OVERVIEW_PATH) continue;
			const { frontmatter, body } = parseFrontmatter(readText(join(l2DataDir, wikiPath)));
			if (!frontmatter) continue;
			pages.push({
				path: wikiPath,
				title: frontmatter.title || basename(wikiPath, extname(wikiPath)),
				type: frontmatter.type || inferTypeFromPath(wikiPath),
				tags: frontmatter.tags ?? [],
				body,
				contested: frontmatter.contested === true,
			});
		}
	}
	return pages.sort((a, b) => a.path.localeCompare(b.path, "zh-CN"));
}

/**
 * Build the wiki graph plus algorithmic analysis. Node ids are wiki-relative
 * paths; `[[links]]` are resolved to page ids via the shared alias index, and
 * unresolved links become synthetic nodes (and are reported under maintenance).
 */
export function buildWikiGraph(l2DataDir: string): WikiGraph {
	const pages = readAllPages(l2DataDir);
	const alias = buildAliasIndex(pages);
	const pagePaths = new Set(pages.map((p) => p.path));

	const nodes: WikiGraphNode[] = [];
	const edges: WikiGraphEdge[] = [];
	const missing: { from: string; link: string }[] = [];

	// Resolved-link adjacency (undirected, distinct neighbors) for degree/community.
	const neighbors = new Map<string, Set<string>>();
	for (const p of pages) neighbors.set(p.path, new Set());

	const unresolvedNodes = new Set<string>();

	for (const p of pages) {
		nodes.push({ id: p.path, title: p.title, type: p.type, tags: p.tags });
		for (const rawLink of extractOutgoingLinks(p.body)) {
			const target = alias.resolve(rawLink);
			if (target && target !== p.path) {
				edges.push({ source: p.path, target, type: "link" });
				neighbors.get(p.path)!.add(target);
				neighbors.get(target)!.add(p.path);
			} else if (!target) {
				// Dangling link → phantom node (backward compat) + maintenance signal.
				const label = rawLink.split("|")[0].trim();
				edges.push({ source: p.path, target: label, type: "link" });
				unresolvedNodes.add(label);
				missing.push({ from: p.path, link: label });
			}
		}
		for (const tag of p.tags) edges.push({ source: p.path, target: `tag:${tag}`, type: "tag" });
	}

	// Synthetic nodes for tags and unresolved links.
	const tagSeen = new Set<string>();
	for (const e of edges) {
		if (e.type === "tag" && !tagSeen.has(e.target)) {
			tagSeen.add(e.target);
			nodes.push({ id: e.target, title: e.target.replace("tag:", "#"), type: "tag", tags: [] });
		}
	}
	for (const label of unresolvedNodes) {
		if (!pagePaths.has(label)) nodes.push({ id: label, title: label, type: "concept", tags: [] });
	}

	// ---- community detection + degree over the resolved page graph ----
	const g = new UndirectedGraph();
	for (const p of pages) g.addNode(p.path);
	for (const [src, set] of neighbors) {
		for (const dst of set) {
			if (src < dst && !g.hasEdge(src, dst)) g.addEdge(src, dst);
		}
	}

	let community = new Map<string, number>();
	let modularity = 0;
	if (g.order > 0 && g.size > 0) {
		try {
			const detailed = louvainDetailed(g);
			community = new Map(Object.entries(detailed.communities));
			modularity = typeof detailed.modularity === "number" ? detailed.modularity : 0;
		} catch {
			community = new Map();
		}
	}

	const degreeByPath = new Map<string, number>();
	for (const [path, set] of neighbors) degreeByPath.set(path, set.size);

	for (const node of nodes) {
		if (pagePaths.has(node.id)) {
			node.degree = degreeByPath.get(node.id) ?? 0;
			const c = community.get(node.id);
			if (c !== undefined) node.community = c;
		}
	}

	// ---- maintenance signals ----
	const orphans = pages.filter((p) => (degreeByPath.get(p.path) ?? 0) === 0).map((p) => p.path);
	const contested = pages.filter((p) => p.contested).map((p) => p.path);

	const baseGroups = new Map<string, string[]>();
	for (const p of pages) {
		const key = normalizeWikiLink(stripParenthetical(p.title));
		if (!key) continue;
		(baseGroups.get(key) ?? baseGroups.set(key, []).get(key)!).push(p.path);
	}
	const duplicates = [...baseGroups.values()].filter((g2) => g2.length > 1);

	// ---- per-community cohesion ----
	const commMembers = new Map<number, Set<string>>();
	for (const [path, c] of community) {
		(commMembers.get(c) ?? commMembers.set(c, new Set()).get(c)!).add(path);
	}
	const lowCohesion: { community: number; cohesion: number; size: number }[] = [];
	for (const [c, members] of commMembers) {
		if (members.size < MIN_COMMUNITY_SIZE) continue;
		let intra = 0;
		let incident = 0;
		for (const path of members) {
			for (const nb of neighbors.get(path) ?? []) {
				incident++;
				if (members.has(nb)) intra++;
			}
		}
		const cohesion = incident > 0 ? intra / incident : 0;
		if (cohesion < LOW_COHESION_THRESHOLD) {
			lowCohesion.push({ community: c, cohesion: Number(cohesion.toFixed(3)), size: members.size });
		}
	}

	return {
		nodes,
		edges,
		maintenance: { missing, orphans, duplicates, contested },
		communities: { count: commMembers.size, modularity: Number(modularity.toFixed(4)), lowCohesion },
	};
}

export interface WikiGraphStats {
	totalPages: number;
	typeCounts: Record<string, number>;
	topByDegree: { title: string; type: string; degree: number }[];
	maintenance: WikiGraphMaintenance;
	communities: WikiGraphCommunities;
}

/**
 * Per-type counts + degree ranking over the real page nodes, plus the graph's
 * maintenance/community analysis. Used by the overview generator.
 */
export function computeWikiGraphStats(graph: WikiGraph, topN = 15): WikiGraphStats {
	const pageNodes = graph.nodes.filter((n) => n.type !== "tag" && n.id.startsWith("wiki/"));

	const typeCounts: Record<string, number> = {};
	for (const n of pageNodes) typeCounts[n.type] = (typeCounts[n.type] ?? 0) + 1;

	const topByDegree = pageNodes
		.map((n) => ({ title: n.title, type: n.type, degree: n.degree ?? 0 }))
		.sort((a, b) => b.degree - a.degree || a.title.localeCompare(b.title, "zh-CN"))
		.slice(0, topN);

	return {
		totalPages: pageNodes.length,
		typeCounts,
		topByDegree,
		maintenance: graph.maintenance,
		communities: graph.communities,
	};
}
