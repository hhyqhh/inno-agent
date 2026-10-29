/**
 * L2 page indexer.
 *
 * Reads wiki pages from `wiki/{sources,entities,concepts,analysis}/`, parses
 * their frontmatter, and upserts them into the L2 index store. Indexing is
 * incremental by content hash: a page is re-indexed only when its bytes change.
 * `indexAllPages` also prunes index rows whose file no longer exists, so it
 * doubles as an idempotent backfill.
 */

import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { resolveContainedPathAsync } from "../../utils/path-safety.js";
import { readTextAsync } from "../../storage/file-store.js";
import { parseFrontmatter } from "./wiki-maintainer.js";
import type { L2IndexStore, L2PageDoc } from "./l2-index-store.js";
import { listWikiPagePathsAsync } from "./wiki-page-files.js";

function contentHashOf(s: string): string {
	return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function inferTypeFromPath(wikiPath: string): string {
	if (wikiPath.includes("entities/")) return "entity";
	if (wikiPath.includes("concepts/")) return "concept";
	if (wikiPath.includes("queries/")) return "query";
	if (wikiPath.includes("comparisons/")) return "comparison";
	if (wikiPath.includes("synthesis/")) return "synthesis";
	if (wikiPath.includes("analysis/")) return "analysis";
	return "source-summary";
}

/**
 * Index one wiki page by its wiki-relative path. Returns true if the store was
 * written (false when the file is missing/empty or unchanged since last index).
 */
export async function indexPage(store: L2IndexStore, l2DataDir: string, wikiPath: string): Promise<boolean> {
	const abs = await resolveContainedPathAsync(l2DataDir, wikiPath);
	if (!abs) return false;
	const content = await readTextAsync(abs);
	if (!content.trim()) return false;

	const hash = contentHashOf(content);
	const prev = store.getIndexState(wikiPath);
	if (prev && prev.contentHash === hash) return false; // unchanged

	const { frontmatter, body } = parseFrontmatter(content);
	let mtimeMs = 0;
	try {
		mtimeMs = Math.floor((await stat(abs)).mtimeMs);
	} catch {
		mtimeMs = 0;
	}

	const doc: L2PageDoc = {
		path: wikiPath,
		title: frontmatter?.title || wikiPath.split("/").pop()?.replace(/\.md$/, "") || wikiPath,
		type: frontmatter?.type || inferTypeFromPath(wikiPath),
		tags: frontmatter?.tags ?? [],
		sourceIds: frontmatter?.source_ids ?? [],
		body,
		contentHash: hash,
		mtimeMs,
	};
	store.upsertPage(doc);
	store.setIndexState(wikiPath, hash, mtimeMs);
	return true;
}

/**
 * Index every wiki page, pruning index rows for files that no longer exist.
 * Idempotent — unchanged pages are skipped, so re-runs are cheap.
 */
export async function indexAllPages(store: L2IndexStore, l2DataDir: string): Promise<{ indexed: number; pruned: number }> {
	const present = new Set<string>();
	let indexed = 0;
	for (const wikiPath of await listWikiPagePathsAsync(l2DataDir)) {
		present.add(wikiPath);
		if (await indexPage(store, l2DataDir, wikiPath)) indexed++;
	}
	let pruned = 0;
	for (const p of store.listIndexedPaths()) {
		if (!present.has(p)) {
			store.deletePage(p);
			pruned++;
		}
	}
	return { indexed, pruned };
}

export function removePageFromIndex(store: L2IndexStore, wikiPath: string): void {
	store.deletePage(wikiPath);
}
