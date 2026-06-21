import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { InnoContentHubConfig } from "../config.js";
import { ensureDir } from "../storage/file-store.js";
import { logger } from "../logger.js";
import {
	isSafeItemName,
	type ContentCategory,
	type ListOpts,
	type RemoteContentSource,
	type RemoteItem,
} from "./types.js";

/**
 * index.json shape served by a bundle service:
 *   {
 *     "skills":  [{ "id": "...", "name": "...", "description": "...", ... }],
 *     "presets": [{ "id": "...", "name": "...", "description": "...", "icon": "..." }]
 *   }
 * `id` is the directory name (used for routing/download); `name` is the display
 * name. For backward compatibility, `name` is used as the id when `id` is absent.
 * Each listed item's files are fetched as a single tarball from
 *   GET {baseUrl}/{skills|presets}/{id}.tar.gz
 */
interface BundleIndex {
	skills?: Array<{ id?: unknown; name?: unknown } & Record<string, unknown>>;
	presets?: Array<{ id?: unknown; name?: unknown } & Record<string, unknown>>;
}

const INDEX_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Fetch content from a self-hosted bundle service. Designed for private
 * deployments: one request returns the whole catalog (no GitHub rate limits),
 * and each item ships as a single tarball — far simpler and more robust than
 * re-implementing a per-file tree walk. The service is expected to be built
 * from a private git repo by an out-of-band job (the git repo holds content;
 * the service just packages + serves it).
 */
export class BundleServiceSource implements RemoteContentSource {
	private indexCache: { index: BundleIndex; fetchedAt: number } | null = null;

	constructor(private readonly hub: InnoContentHubConfig) {
		if (!hub.baseUrl?.trim()) {
			throw new Error("Content Hub type is 'bundle' but baseUrl is not set");
		}
	}

	private get base(): string {
		return this.hub.baseUrl.replace(/\/+$/, "");
	}

	private headers(): Record<string, string> {
		const headers: Record<string, string> = { "User-Agent": "inno-agent" };
		const token = this.hub.token?.trim();
		if (token) headers.Authorization = `Bearer ${token}`;
		return headers;
	}

	private async getIndex(forceRefresh = false): Promise<BundleIndex> {
		const now = Date.now();
		if (!forceRefresh && this.indexCache && now - this.indexCache.fetchedAt < INDEX_CACHE_TTL_MS) {
			return this.indexCache.index;
		}
		const res = await fetch(`${this.base}/index.json`, { headers: this.headers() });
		if (!res.ok) {
			throw new Error(`Bundle service index request failed (${res.status} ${res.statusText})`);
		}
		const index = (await res.json()) as BundleIndex;
		this.indexCache = { index, fetchedAt: now };
		return index;
	}

	async listItems(category: ContentCategory, opts: ListOpts = {}): Promise<RemoteItem[]> {
		const index = await this.getIndex(opts.forceRefresh);
		const raw = (category === "skills" ? index.skills : index.presets) ?? [];
		const items: RemoteItem[] = [];
		for (const entry of raw) {
			// `id` is the directory name (routing/download key). Fall back to
			// `name` for older services that didn't distinguish the two.
			const id = typeof entry.id === "string" && entry.id.trim()
				? entry.id.trim()
				: typeof entry.name === "string" ? entry.name.trim() : "";
			if (!id || !isSafeItemName(id)) continue;
			items.push({ name: id, meta: entry });
		}
		return items.sort((a, b) => a.name.localeCompare(b.name));
	}

	async readItemTextFile(category: ContentCategory, name: string, _relPath: string): Promise<string | null> {
		// The bundle service ships metadata inline in index.json, so callers
		// should read RemoteItem.meta. We don't fetch individual files here —
		// returning null lets callers fall back to meta gracefully.
		void category; void name; void _relPath;
		return null;
	}

	async downloadItem(category: ContentCategory, name: string, targetDir: string): Promise<void> {
		if (!isSafeItemName(name)) throw new Error(`Invalid item name: ${name}`);
		const url = `${this.base}/${category}/${encodeURIComponent(name)}.tar.gz`;
		const res = await fetch(url, { headers: this.headers() });
		if (!res.ok) {
			throw new Error(`Failed to download ${category}/${name} (${res.status} ${res.statusText})`);
		}
		const buf = Buffer.from(await res.arrayBuffer());
		const tmpRoot = join(tmpdir(), `inno-bundle-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const tarPath = join(tmpRoot, "item.tar.gz");
		ensureDir(tmpRoot);
		ensureDir(targetDir);
		try {
			writeFileSync(tarPath, buf);
			// Extract with system tar (available on macOS/Linux/Win10+), stripping
			// the leading <name>/ component so files land directly in targetDir.
			const result = spawnSync("tar", ["-xzf", tarPath, "-C", targetDir, "--strip-components=1"], { encoding: "utf-8" });
			if (result.status !== 0) {
				throw new Error((result.stderr || "").trim() || "Unable to extract bundle tarball");
			}
		} finally {
			rmSync(tmpRoot, { recursive: true, force: true });
		}
		logger.info({ category, name, targetDir }, "content-source: extracted bundle item");
	}

	invalidate(): void {
		this.indexCache = null;
	}
}
