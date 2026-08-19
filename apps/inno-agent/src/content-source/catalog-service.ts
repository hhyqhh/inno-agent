import { existsSync, readdirSync } from "node:fs";
import { normalizeContentHubConfig, type InnoConfig, type InnoContentHubConfig } from "../config.js";
import { logger } from "../logger.js";
import { listBundledPresets, listRemotePresets, type PresetMeta } from "../presets/preset-store.js";
import { slugifySkillName } from "../server/file-helpers.js";
import { extractFrontmatterFields } from "../server/skill-frontmatter.js";
import type { RuntimePaths } from "../runtime.js";
import { CatalogSnapshotCache } from "./catalog-cache.js";
import { createContentSource, type RemoteContentSource } from "./index.js";
import {
	mapWithConcurrency,
	type ContentCategory,
	type SkillLibraryItem,
} from "./types.js";

export interface ContentHubCatalogOptions {
	dataDir: string;
	paths: RuntimePaths;
	skillsDir: string;
	getConfig: () => InnoConfig;
}

/**
 * Owns remote catalog lifecycle: source reuse, persistent snapshots, and
 * background warming. The HTTP server only wires these methods to routes, so
 * catalog behavior stays out of the request dispatcher.
 */
export class ContentHubCatalog {
	private readonly cache: CatalogSnapshotCache;
	private source: RemoteContentSource | null = null;
	private sourceHubKey = "";
	private readonly loads = new Map<ContentCategory, Promise<unknown>>();

	constructor(private readonly options: ContentHubCatalogOptions) {
		this.cache = new CatalogSnapshotCache(options.dataDir, () => this.hubKey(this.currentHub()));
	}

	getSource(): RemoteContentSource {
		const hub = this.currentHub();
		const key = this.hubKey(hub);
		if (!this.source || key !== this.sourceHubKey) {
			this.source = createContentSource(hub);
			this.sourceHubKey = key;
		}
		return this.source;
	}

	/** Return whether the last successful remote preset snapshot contains an id. */
	getCachedPresetAvailability(id: string): boolean | null {
		const cached = this.cachedItems<PresetMeta>("presets");
		if (!cached) return null;
		return cached.some((preset) => preset.id === id);
	}

	invalidate(): void {
		this.source?.invalidate();
		this.source = null;
		this.sourceHubKey = "";
		this.cache.invalidate();
		this.loads.clear();
	}

	async listSkillLibrary(forceRefresh = false): Promise<SkillLibraryItem[]> {
		const remote = await this.loadCatalog(
			"skills",
			forceRefresh,
			() => this.fetchSkillLibrary(forceRefresh),
		);
		return this.withCurrentInstallState(remote);
	}

	async listPresetLibrary(forceRefresh = false): Promise<PresetMeta[]> {
		const remote = await this.loadCatalog(
			"presets",
			forceRefresh,
			() => listRemotePresets(this.getSource(), forceRefresh),
		);
		// A successful remote snapshot is authoritative. Only bundled presets are
		// merged here; downloaded cache entries omitted by the hub must disappear
		// from the online catalog instead of resurrecting as stale cards.
		const merged = new Map(listBundledPresets(this.options.paths).map((preset) => [preset.id, preset]));
		for (const preset of remote) merged.set(preset.id, preset);
		return Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name));
	}

	async warm(): Promise<void> {
		if (this.options.getConfig().simpleMode?.enabled !== true) return;
		for (const [category, load] of [
			["presets", () => this.listPresetLibrary()] as const,
			["skills", () => this.listSkillLibrary()] as const,
		]) {
			if (this.cachedItems(category)) continue;
			try {
				await load();
				logger.info({ category }, "content-source: catalog preloaded");
			} catch (err) {
				logger.warn({ err, category }, "content-source: catalog preload failed");
			}
		}
	}

	private currentHub() {
		const config = this.options.getConfig();
		return config.contentHub ?? normalizeContentHubConfig(undefined, config.github?.token);
	}

	private hubKey(hub: InnoContentHubConfig): string {
		return JSON.stringify(hub);
	}

	private cachedItems<T>(category: ContentCategory): T[] | null {
		return this.cache.getItems<T>(category);
	}

	private saveEntry(category: ContentCategory, items: unknown[], key: string): void {
		this.cache.save(category, items, key);
	}

	private async loadCatalog<T>(
		category: ContentCategory,
		forceRefresh: boolean,
		loader: () => Promise<T[]>,
	): Promise<T[]> {
		const cached = this.cachedItems<T>(category);
		if (!forceRefresh && cached) return cached;

		const existing = this.loads.get(category);
		if (existing) return await existing as T[];

		const key = this.hubKey(this.currentHub());
		const task = (async () => {
			const items = await loader();
			this.saveEntry(category, items, key);
			return items;
		})();
		this.loads.set(category, task);
		try {
			return await task;
		} finally {
			if (this.loads.get(category) === task) this.loads.delete(category);
		}
	}

	private async fetchSkillLibrary(forceRefresh: boolean): Promise<SkillLibraryItem[]> {
		const source = this.getSource();
		const items = await source.listItems("skills", { forceRefresh });
		const localNames = this.currentInstalledSkillNames();
		const result = await mapWithConcurrency(items, 5, async (item): Promise<SkillLibraryItem> => {
			let description = typeof item.meta?.description === "string" ? item.meta.description : "";
			let category = typeof item.meta?.category === "string" ? item.meta.category.trim() : "";
			if (!description || !category) {
				const md = await source.readItemTextFile("skills", item.name, "SKILL.md");
				if (md) {
					const fields = extractFrontmatterFields(md);
					if (!description) description = fields.description;
					if (!category) category = fields.category;
				}
			}
			return {
				name: item.name,
				description,
				category: category || undefined,
				installed: localNames.has(slugifySkillName(item.name)),
			};
		});
		return result.sort((a, b) => a.name.localeCompare(b.name));
	}

	private currentInstalledSkillNames(): Set<string> {
		return new Set(
			existsSync(this.options.skillsDir)
				? readdirSync(this.options.skillsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
				: [],
		);
	}

	private withCurrentInstallState(items: SkillLibraryItem[]): SkillLibraryItem[] {
		const localNames = this.currentInstalledSkillNames();
		return items.map((item) => ({
			...item,
			installed: localNames.has(slugifySkillName(item.name)),
		}));
	}
}
