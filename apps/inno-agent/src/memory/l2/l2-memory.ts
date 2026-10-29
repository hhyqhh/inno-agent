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

import { logger } from "../../logger.js";
import { openL2IndexStore, type L2IndexStore } from "./l2-index-store.js";
import { indexAllPages, indexPage, removePageFromIndex } from "./l2-indexer.js";
import { searchL2, type L2SearchResult } from "./l2-search.js";

export class L2Memory {
	private store: L2IndexStore | null = null;
	private opening: Promise<L2IndexStore | null> | null = null;
	private indexQueue: Promise<unknown> = Promise.resolve();
	private backfilled = false;
	private backfillPromise: Promise<void> | null = null;

	constructor(private readonly l2DataDir: string) {}

	private async ensureStore(): Promise<L2IndexStore | null> {
		// Concurrent searches must await the same open, rather than observe a temporary null.
		this.opening ??= openL2IndexStore(this.l2DataDir).then((store) => {
			this.store = store;
			if (!store) logger.warn("[L2] node:sqlite unavailable; index-backed retrieval disabled.");
			return store;
		});
		return this.opening;
	}

	private enqueueIndex<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.indexQueue.then(operation);
		this.indexQueue = result.catch(() => {});
		return result;
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
	 * Backfill is index-only: ingestion reads an existing overview during ingest
	 * but does not create aggregate model-visible context as a startup side effect.
	 */
	async backfill(): Promise<void> {
		if (this.backfilled) return;
		if (this.backfillPromise) return this.backfillPromise;

		const run = this.runBackfill();
		this.backfillPromise = run;
		try {
			await run;
		} finally {
			if (this.backfillPromise === run) this.backfillPromise = null;
		}
	}

	private async runBackfill(): Promise<void> {
		const store = await this.ensureStore();
		if (!store) return;
		try {
			const { indexed, pruned } = await this.enqueueIndex(() => indexAllPages(store, this.l2DataDir));
			this.backfilled = true;
			if (indexed > 0 || pruned > 0) logger.info(`[L2] backfill indexed ${indexed} page(s), pruned ${pruned}.`);
		} catch (err) {
			logger.warn({ err }, `[L2] backfill failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** Reconcile every page after an incremental update failed in this process. */
	async reconcile(): Promise<boolean> {
		const store = await this.ensureStore();
		if (!store) return false;
		try {
			await this.enqueueIndex(() => indexAllPages(store, this.l2DataDir));
			return true;
		} catch (err) {
			logger.warn({ err }, `[L2] reconciliation failed: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	}

	/** Incrementally (re)index a single wiki page by its wiki-relative path. */
	async indexPageByPath(wikiPath: string): Promise<void> {
		if (!wikiPath) return;
		const store = await this.ensureStore();
		if (!store) return;
		await this.enqueueIndex(() => indexPage(store, this.l2DataDir, wikiPath));
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
			// Deletions must follow pending reads/upserts so an older backfill
			// cannot recreate a page after its removal.
			await this.enqueueIndex(async () => removePageFromIndex(store, wikiPath));
		} catch (err) {
			logger.warn({ err }, `[L2] remove ${wikiPath} failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/**
	 * Close the index store and reset the lazy-init flags so the holder can be
	 * reused. Mainly needed by tests: on Windows an open sqlite handle keeps
	 * index.db locked and temp-dir cleanup fails with EBUSY.
	 */
	close(): void {
		this.store?.close();
		this.store = null;
		this.opening = null;
		this.indexQueue = Promise.resolve();
		this.backfilled = false;
		this.backfillPromise = null;
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

/**
 * Close and drop the per-dir singleton. Tests must call this before deleting
 * their temp data dir, otherwise the open sqlite handle keeps index.db locked
 * on Windows and cleanup fails with EBUSY.
 */
export function closeL2Memory(l2DataDir: string): void {
	const mem = registry.get(l2DataDir);
	if (!mem) return;
	mem.close();
	registry.delete(l2DataDir);
}
