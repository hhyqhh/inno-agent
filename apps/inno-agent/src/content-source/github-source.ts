import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { InnoContentHubConfig } from "../config.js";
import { ensureDir } from "../storage/file-store.js";
import { logger } from "../logger.js";
import {
	CATEGORY_MARKER,
	isSafeItemName,
	type ContentCategory,
	type ListOpts,
	type RemoteContentSource,
	type RemoteItem,
} from "./types.js";

interface GitTreeEntry {
	path: string;
	type: "blob" | "tree";
	url: string;
}

interface GitTreeResponse {
	tree: GitTreeEntry[];
	truncated: boolean;
}

/** Directories that are never installable items (assets, macOS cruft). */
const IGNORE_DIRS = new Set(["assets", "__MACOSX"]);

const TREE_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Fetch content from a GitHub repo. Lifts the battle-tested approach the skill
 * library already used:
 *   - ONE Git Trees API call (`recursive=1`) gets the whole repo tree, cached
 *     for a few minutes, instead of a per-directory `contents` walk that
 *     quickly exhausts the unauthenticated 60/hour budget.
 *   - File bytes come from raw.githubusercontent.com (a CDN that does NOT count
 *     against the API rate limit, but has its own per-IP anonymous throttle —
 *     so raw fetches are authenticated + retried with backoff, see rawHeaders /
 *     fetchWithRetry).
 */
export class GitHubContentSource implements RemoteContentSource {
	private treeCache: { entries: GitTreeEntry[]; fetchedAt: number } | null = null;

	constructor(private readonly hub: InnoContentHubConfig) {}

	private prefixFor(category: ContentCategory): string {
		const dir = category === "skills" ? this.hub.skillsPath : this.hub.presetsPath;
		return `${dir}/`;
	}

	private headers(): Record<string, string> {
		const headers: Record<string, string> = {
			Accept: "application/vnd.github+json",
			"User-Agent": "inno-agent",
		};
		const token = this.hub.token?.trim() || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
		if (token) headers.Authorization = `Bearer ${token}`;
		return headers;
	}

	private async getJson<T>(url: string): Promise<T> {
		const res = await fetch(url, { headers: this.headers() });
		if (!res.ok) {
			// Surface rate-limit exhaustion with a clearer hint than a raw 403.
			if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
				const reset = Number(res.headers.get("x-ratelimit-reset"));
				const when = Number.isFinite(reset) ? new Date(reset * 1000).toLocaleTimeString() : "later";
				throw new Error(
					`GitHub API rate limit reached (unauthenticated is 60/hour). Try again after ${when}, ` +
					`or set a Content Hub token to raise the limit.`,
				);
			}
			throw new Error(`GitHub request failed (${res.status} ${res.statusText}) for ${url}`);
		}
		return (await res.json()) as T;
	}

	private rawUrl(repoPath: string): string {
		const encoded = repoPath.split("/").map(encodeURIComponent).join("/");
		return `https://raw.githubusercontent.com/${this.hub.owner}/${this.hub.repo}/${this.hub.ref}/${encoded}`;
	}

	/**
	 * Headers for raw.githubusercontent.com. Unlike {@link headers}, this omits
	 * the JSON `Accept` (raw returns file bytes) but MUST still carry the token:
	 * anonymous raw requests share a per-IP budget that a burst of preset.json
	 * reads exhausts, returning 429. Authenticating ties them to the account's
	 * far larger limit.
	 */
	private rawHeaders(): Record<string, string> {
		const headers: Record<string, string> = { "User-Agent": "inno-agent" };
		const token = this.hub.token?.trim() || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
		if (token) headers.Authorization = `Bearer ${token}`;
		return headers;
	}

	/**
	 * Fetch with bounded exponential backoff on transient throttling (429) and
	 * server errors (5xx). Honors `Retry-After` when present. Returns the final
	 * Response (which may still be non-ok) so callers decide how to treat it.
	 */
	private async fetchWithRetry(url: string, headers: Record<string, string>, attempts = 4): Promise<Response> {
		let lastErr: unknown;
		for (let attempt = 0; attempt < attempts; attempt++) {
			try {
				const res = await fetch(url, { headers });
				if (res.status !== 429 && res.status < 500) return res;
				if (attempt === attempts - 1) return res;
				const retryAfter = Number(res.headers.get("retry-after"));
				const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
					? retryAfter * 1000
					: Math.min(2000, 250 * 2 ** attempt);
				logger.warn({ url, status: res.status, attempt, delayMs }, "content-source: retrying throttled raw fetch");
				await new Promise((resolve) => setTimeout(resolve, delayMs));
			} catch (err) {
				lastErr = err;
				if (attempt === attempts - 1) throw err;
				await new Promise((resolve) => setTimeout(resolve, Math.min(2000, 250 * 2 ** attempt)));
			}
		}
		// Unreachable: the loop either returns or throws on the last attempt.
		throw lastErr ?? new Error(`fetch failed for ${url}`);
	}

	private async getTree(forceRefresh = false): Promise<GitTreeEntry[]> {
		const now = Date.now();
		if (!forceRefresh && this.treeCache && now - this.treeCache.fetchedAt < TREE_CACHE_TTL_MS) {
			return this.treeCache.entries;
		}
		const url =
			`https://api.github.com/repos/${this.hub.owner}/${this.hub.repo}` +
			`/git/trees/${this.hub.ref}?recursive=1`;
		const data = await this.getJson<GitTreeResponse>(url);
		this.treeCache = { entries: data.tree, fetchedAt: now };
		return data.tree;
	}

	async listItems(category: ContentCategory, opts: ListOpts = {}): Promise<RemoteItem[]> {
		const tree = await this.getTree(opts.forceRefresh);
		const prefix = this.prefixFor(category);
		const marker = CATEGORY_MARKER[category];
		// A directory is an installable item if it directly contains the marker.
		// Dirs starting with "_" or "." are skeletons/drafts (e.g. _template) and
		// are not surfaced as usable items.
		const names = new Set<string>();
		for (const entry of tree) {
			if (entry.type !== "blob") continue;
			if (!entry.path.startsWith(prefix)) continue;
			const rel = entry.path.slice(prefix.length); // e.g. "my-skill/SKILL.md"
			const parts = rel.split("/");
			const dir = parts[0];
			if (parts.length === 2 && parts[1] === marker && !IGNORE_DIRS.has(dir) && !dir.startsWith("_") && !dir.startsWith(".")) {
				names.add(dir);
			}
		}
		return Array.from(names).map((name) => ({ name })).sort((a, b) => a.name.localeCompare(b.name));
	}

	async readItemTextFile(category: ContentCategory, name: string, relPath: string): Promise<string | null> {
		if (!isSafeItemName(name)) throw new Error(`Invalid item name: ${name}`);
		const repoPath = `${this.prefixFor(category)}${name}/${relPath}`;
		try {
			const res = await this.fetchWithRetry(this.rawUrl(repoPath), this.rawHeaders());
			if (!res.ok) {
				logger.warn({ repoPath, status: res.status }, "content-source: raw file fetch not ok");
				return null;
			}
			return await res.text();
		} catch (err) {
			logger.warn({ err, repoPath }, "content-source: failed to read item text file");
			return null;
		}
	}

	async downloadItem(category: ContentCategory, name: string, targetDir: string): Promise<void> {
		if (!isSafeItemName(name)) throw new Error(`Invalid item name: ${name}`);
		const tree = await this.getTree();
		const dirPrefix = `${this.prefixFor(category)}${name}/`;
		const blobs = tree.filter((e) => e.type === "blob" && e.path.startsWith(dirPrefix));
		if (blobs.length === 0) {
			throw new Error(`"${name}" not found in the ${category} library`);
		}
		ensureDir(targetDir);
		for (const blob of blobs) {
			const rel = blob.path.slice(dirPrefix.length);
			if (!rel || rel.includes("..")) continue;
			const localPath = join(targetDir, rel);
			const res = await this.fetchWithRetry(this.rawUrl(blob.path), this.rawHeaders());
			if (!res.ok) throw new Error(`Failed to download ${blob.path} (${res.status})`);
			const buf = Buffer.from(await res.arrayBuffer());
			ensureDir(dirname(localPath));
			writeFileSync(localPath, buf);
		}
	}

	invalidate(): void {
		this.treeCache = null;
	}
}
