/**
 * L2 wiki memory holder.
 *
 * Owns the lazily-opened {@link L2IndexStore} singleton for a data dir and keeps
 * the index in sync with the wiki pages on disk. Retrieval (lexical + graph) is
 * layered on in l2-search.ts and exposed via {@link L2Memory.search}.
 *
 * Everything degrades to a no-op when node:sqlite is unavailable so the agent
 * keeps working on older runtimes (the query tool falls back to substring
 * search in that case).
 *
 * Use {@link getL2Memory} to obtain a per-dir singleton so the agent extension
 * and the HTTP server share ONE handle within a process.
 */

import { join } from "node:path";
import { logger } from "../../logger.js";
import { fileExists } from "../../storage/file-store.js";
import { openL2IndexStore, type L2IndexStore } from "./l2-index-store.js";
import { indexAllPages, indexPage, removePageFromIndex } from "./l2-indexer.js";
import { searchL2, type L2SearchResult } from "./l2-search.js";
import { regenerateOverview, OVERVIEW_PATH } from "./overview.js";

export class L2Memory {
	private store: L2IndexStore | null = null;
	private opened = false;
	private backfilled = false;

	constructor(private readonly l2DataDir: string) {}

	private async ensureStore(): Promise<L2IndexStore | null> {
		if (this.opened) return this.store;
		this.opened = true;
		this.store = await openL2IndexStore(this.l2DataDir);
		if (!this.store) {
			logger.warn("[L2] node:sqlite unavailable — index-backed retrieval disabled (falling back to substring).");
		}
		return this.store;
	}

	/** Expose the store for the search layer; null when sqlite is unavailable. */
	async getStore(): Promise<L2IndexStore | null> {
		return this.ensureStore();
	}

	get dataDir(): string {
		return this.l2DataDir;
	}

	/**
	 * One-time backfill of all existing wiki pages (cheap: skips unchanged
	 * files). Index sync always runs — even when L2 is disabled — so the
	 * layer can be re-enabled without a backfill gap (same philosophy as L3).
	 * `generateOverview` gates the visible side effect (bootstrapping
	 * `wiki/analysis/overview.md`); pass false when L2 is disabled.
	 */
	async backfill(options: { generateOverview?: boolean } = {}): Promise<void> {
		if (this.backfilled) return;
		const store = await this.ensureStore();
		if (!store) return;
		this.backfilled = true;
		try {
			const { indexed, pruned } = indexAllPages(store, this.l2DataDir);
			if (indexed > 0 || pruned > 0) logger.info(`[L2] backfill indexed ${indexed} page(s), pruned ${pruned}.`);
		} catch (err) {
			logger.warn({ err }, `[L2] backfill failed: ${err instanceof Error ? err.message : String(err)}`);
		}

		if (options.generateOverview === false) return;

		// Ensure an overview page exists (deterministic core; an LLM narrative is
		// added on the next archive, which has a model available).
		try {
			if (!fileExists(join(this.l2DataDir, OVERVIEW_PATH))) {
				const rel = await regenerateOverview(this.l2DataDir);
				if (rel) await this.indexPageByPath(rel);
			}
		} catch (err) {
			logger.warn({ err }, "[L2] overview bootstrap failed");
		}
	}

	/** Incrementally (re)index a single wiki page by its wiki-relative path. */
	async indexPageByPath(wikiPath: string): Promise<void> {
		if (!wikiPath) return;
		const store = await this.ensureStore();
		if (!store) return;
		try {
			indexPage(store, this.l2DataDir, wikiPath);
		} catch (err) {
			logger.warn({ err }, `[L2] index ${wikiPath} failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/**
	 * Search indexed pages (lexical BM25 + graph expansion). Returns null when
	 * the index store is unavailable, so callers can fall back to the legacy
	 * substring search.
	 */
	async search(query: string, limit = 5): Promise<L2SearchResult[] | null> {
		const store = await this.ensureStore();
		if (!store) return null;
		try {
			return await searchL2(store, query, { limit });
		} catch (err) {
			logger.warn({ err }, `[L2] search failed: ${err instanceof Error ? err.message : String(err)}`);
			return null;
		}
	}

	/** Remove a page from the index (after the page file is deleted). */
	async removePage(wikiPath: string): Promise<void> {
		if (!wikiPath) return;
		const store = await this.ensureStore();
		if (!store) return;
		try {
			removePageFromIndex(store, wikiPath);
		} catch (err) {
			logger.warn({ err }, `[L2] remove ${wikiPath} failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}

const registry = new Map<string, L2Memory>();

/** Per-dir singleton so the agent extension and HTTP server share one handle. */
export function getL2Memory(l2DataDir: string): L2Memory {
	let mem = registry.get(l2DataDir);
	if (!mem) {
		mem = new L2Memory(l2DataDir);
		registry.set(l2DataDir, mem);
	}
	return mem;
}
