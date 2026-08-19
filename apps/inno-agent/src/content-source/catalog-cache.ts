import { join } from "node:path";
import { readJson, writeJson } from "../storage/file-store.js";
import type { ContentCatalogStatus, ContentCategory } from "./types.js";

type CatalogCacheEntry = {
	items: unknown[];
	revision: string | null;
	fetchedAt: string;
};

type CatalogCacheFile = {
	version: 1;
	hubKey: string;
	entries: Partial<Record<ContentCategory, CatalogCacheEntry>>;
};

/** Persistent stale-while-revalidate snapshots for the remote content hub. */
export class CatalogSnapshotCache {
	private readonly cachePath: string;
	private cacheHubKey = "";
	private entries: Partial<Record<ContentCategory, CatalogCacheEntry>> = {};

	constructor(dataDir: string, private readonly getHubKey: () => string) {
		this.cachePath = join(dataDir, "content-hub", "catalog.json");
	}

	getItems<T>(category: ContentCategory): T[] | null {
		this.ensureLoaded();
		const entry = this.entries[category];
		return entry ? entry.items as T[] : null;
	}

	save(category: ContentCategory, items: unknown[], revision: string | null, key: string): void {
		if (this.getHubKey() !== key) return;
		this.ensureLoaded(key);
		this.entries[category] = {
			items,
			revision,
			fetchedAt: new Date().toISOString(),
		};
		writeJson<CatalogCacheFile>(this.cachePath, {
			version: 1,
			hubKey: key,
			entries: this.entries,
		}, { mode: 0o600 });
	}

	status(category: ContentCategory, remoteRevision: string | null, checkedAt: string): ContentCatalogStatus {
		this.ensureLoaded();
		const entry = this.entries[category];
		return {
			hasUpdate: Boolean(entry?.revision && remoteRevision && entry.revision !== remoteRevision),
			cachedRevision: entry?.revision ?? null,
			remoteRevision,
			checkedAt,
		};
	}

	invalidate(): void {
		this.cacheHubKey = "";
		this.entries = {};
	}

	private ensureLoaded(key = this.getHubKey()): void {
		if (this.cacheHubKey === key) return;
		this.cacheHubKey = key;
		this.entries = {};
		const persisted = readJson<CatalogCacheFile | null>(this.cachePath, null);
		if (persisted?.version !== 1 || persisted.hubKey !== key || !persisted.entries) return;
		for (const category of ["skills", "presets"] as const) {
			const entry = persisted.entries[category];
			if (entry && Array.isArray(entry.items)) this.entries[category] = entry;
		}
	}
}
