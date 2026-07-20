/**
 * L2 wiki memory holder.
 *
 * Owns the lazily-opened {@link L2IndexStore} singleton for a data dir and keeps
 * the index in sync with the wiki pages on disk. Retrieval (lexical + vector +
 * graph) is layered on in l2-search.ts and exposed via {@link L2Memory.search}.
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
import type { Embedder } from "./embeddings-client.js";

/** Max chars of (title + body) fed to the embedder per page. */
const EMBED_MAX_CHARS = 8000;

function embedText(title: string, body: string): string {
	const t = `${title}\n\n${body}`.trim();
	return t.length > EMBED_MAX_CHARS ? t.slice(0, EMBED_MAX_CHARS) : t;
}

export class L2Memory {
	private store: L2IndexStore | null = null;
	private opened = false;
	private backfilled = false;
	private embedderFactory: (() => Embedder | null) | null = null;

	constructor(private readonly l2DataDir: string) {}

	/**
	 * Provide a factory that builds the current embedder from config (called by
	 * the agent extension, which owns the config holder). Vector search is off
	 * until this is set and the factory returns a non-null embedder.
	 */
	setEmbedderFactory(fn: () => Embedder | null): void {
		this.embedderFactory = fn;
	}

	getEmbedder(): Embedder | null {
		return this.embedderFactory ? this.embedderFactory() : null;
	}

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

	/** One-time backfill of all existing wiki pages (cheap: skips unchanged files). */
	async backfill(): Promise<void> {
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
		await this.embedBackfill();

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

	/**
	 * Embed any pages missing a current-hash vector for the active model.
	 * No-op when no embedder is configured or on any embedding failure.
	 */
	async embedBackfill(): Promise<void> {
		const store = await this.ensureStore();
		if (!store) return;
		const embedder = this.getEmbedder();
		if (!embedder) return;
		try {
			const missing = store.getPagesMissingEmbedding(embedder.model);
			if (missing.length === 0) return;
			const vecs = await embedder.embed(missing.map((p) => embedText(p.title, p.body)));
			if (vecs.length !== missing.length) return; // embedding failed → leave as-is
			for (let i = 0; i < missing.length; i++) {
				store.upsertEmbedding(missing[i].path, vecs[i].length, vecs[i], embedder.model, missing[i].contentHash);
			}
			logger.info(`[L2] embedded ${missing.length} page(s).`);
		} catch (err) {
			logger.warn({ err }, `[L2] embed backfill failed: ${err instanceof Error ? err.message : String(err)}`);
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
	 * Hybrid search over indexed pages (lexical + vector + graph). Returns null
	 * when the index store is unavailable, so callers can fall back to the
	 * legacy substring search.
	 */
	async search(query: string, limit = 5): Promise<L2SearchResult[] | null> {
		const store = await this.ensureStore();
		if (!store) return null;
		try {
			return await searchL2(store, query, { embedder: this.getEmbedder(), limit });
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
