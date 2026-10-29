import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";
import { readdir, realpath, stat } from "node:fs/promises";
import { basename, relative } from "node:path";
import type { RuntimePaths } from "../../runtime.js";
import { parseFrontmatter } from "../../memory/l2/wiki-maintainer.js";
import { listWikiPagePathsAsync } from "../../memory/l2/wiki-page-files.js";
import { readJsonAsync, readTextAsync } from "../../storage/file-store.js";
import { resolveContainedPathAsync } from "../../utils/path-safety.js";
import { WORKSPACE_IGNORES } from "../file-helpers.js";
import type { SearchCategory, SearchResponse, SearchResult, SearchResultCategory } from "../../shared/search.js";
import type { WorkspaceRegistry } from "../../workspace/workspace-registry.js";
import { json } from "../http-helpers.js";
import { parseSessionFileAsync } from "../session-parser.js";

const CATEGORY_ORDER = ["conversation", "workspace", "file", "knowledge"] as const;
const RESULTS_PER_CATEGORY = 12;

export interface SearchRouteContext {
	dataDir: string;
	paths: RuntimePaths;
	workspaceRegistry: WorkspaceRegistry;
}

function normalized(value: string): string {
	return value.toLocaleLowerCase();
}

function excerpt(text: string, query: string, maxLength = 180): string {
	const content = text.replace(/\s+/g, " ").trim();
	if (content.length <= maxLength) return content;
	const lower = normalized(content);
	const terms = query.trim().split(/\s+/).filter(Boolean);
	const index = terms.map((term) => lower.indexOf(normalized(term))).filter((at) => at >= 0).sort((a, b) => a - b)[0] ?? -1;
	if (index < 0) return `${content.slice(0, maxLength).trimEnd()}…`;
	const start = Math.max(0, index - Math.floor(maxLength / 3));
	const end = Math.min(content.length, start + maxLength);
	return `${start > 0 ? "…" : ""}${content.slice(start, end).trim()}${end < content.length ? "…" : ""}`;
}

function includesQuery(value: string, query: string): boolean {
	return normalized(value).includes(normalized(query));
}

function rankText(value: string, query: string): number {
	const target = normalized(value);
	const needle = normalized(query);
	if (target === needle) return 3;
	if (target.startsWith(needle)) return 2;
	return target.includes(needle) ? 1 : 0;
}

async function searchWorkspaces(ctx: SearchRouteContext, query: string): Promise<SearchResult[]> {
	return (await ctx.workspaceRegistry.listWorkspacesAsync())
		.filter((workspace) => includesQuery(workspace.name, query))
		.sort((a, b) => rankText(b.name, query) - rankText(a.name, query) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id))
		.map((workspace) => ({
			id: `workspace:${workspace.id}`,
			category: "workspace",
			title: workspace.name,
			subtitle: workspace.relPath,
			snippet: workspace.isTemp ? "临时工作区" : workspace.relPath,
			updatedAt: workspace.updatedAt,
			workspaceId: workspace.id,
		}));
}

async function searchWorkspaceFiles(ctx: SearchRouteContext, query: string): Promise<SearchResult[]> {
	const matches: Array<SearchResult & { rank: number }> = [];
	for (const workspace of await ctx.workspaceRegistry.listWorkspacesAsync()) {
		const root = await ctx.workspaceRegistry.resolveWorkspaceDirAsync(workspace);
		if (!root) continue;
		let realRoot: string;
		try {
			realRoot = await realpath(root);
		} catch {
			continue;
		}
		const visited = new Set<string>([realRoot]);
		// Search is not limited by the file tree's display depth; containment
		// checks and the visited set still stop escapes and symlink cycles.
		const walk = async (dir: string): Promise<void> => {
			let entries;
			try {
				entries = await readdir(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				if (WORKSPACE_IGNORES.has(entry.name)) continue;
				const fullPath = await resolveContainedPathAsync(root, `${relative(root, dir)}/${entry.name}`.replace(/^\//, ""));
				if (!fullPath) continue;
				let info: Awaited<ReturnType<typeof stat>>;
				let realPath: string;
				try {
					info = await stat(fullPath);
					realPath = await realpath(fullPath);
				} catch {
					continue;
				}
				if (info.isDirectory()) {
					if (visited.has(realPath)) continue;
					visited.add(realPath);
					await walk(fullPath);
					continue;
				}
				if (!info.isFile()) continue;
				const path = relative(root, fullPath).replaceAll("\\", "/");
				if (!includesQuery(path, query)) continue;
				matches.push({
					id: `file:${workspace.id}:${path}`,
					category: "file",
					title: basename(path),
					subtitle: `${workspace.name} · ${path}`,
					snippet: path,
					updatedAt: info.mtime.toISOString(),
					workspaceId: workspace.id,
					path,
					rank: rankText(basename(path), query),
				});
			}
		};
		await walk(root);
	}
	return matches
		.sort((a, b) => b.rank - a.rank || Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? "") || a.id.localeCompare(b.id))
		.map(({ rank: _rank, ...result }) => result);
}

async function searchKnowledge(ctx: SearchRouteContext, query: string): Promise<SearchResult[]> {
	// Read the current pages so edits, short words and literal punctuation use
	// the same matching rules as conversations, rather than recall tokenization.
	const results: SearchResult[] = [];
	for (const path of await listWikiPagePathsAsync(ctx.paths.l2DataDir)) {
		try {
			const filePath = await resolveContainedPathAsync(ctx.paths.l2DataDir, path);
			if (!filePath) continue;
			const content = await readTextAsync(filePath);
			const { frontmatter, body } = parseFrontmatter(content);
			const title = frontmatter?.title?.trim() || basename(path, ".md");
			const tags = frontmatter?.tags ?? [];
			if (!includesQuery(`${path} ${title} ${tags.join(" ")} ${body}`, query)) continue;
			results.push({
				id: `knowledge:${path}`,
				category: "knowledge",
				title,
				subtitle: path,
				snippet: excerpt(body || title, query),
				path,
			});
		} catch {
			// Ignore an unavailable or concurrently removed page.
		}
	}
	return results.sort((a, b) => rankText(b.title, query) - rankText(a.title, query) || a.id.localeCompare(b.id));
}

async function searchConversations(ctx: SearchRouteContext, query: string): Promise<SearchResult[]> {
	// UI keyword search needs complete, current, literal matches. The recall
	// index ranks token overlaps and refreshes at turn end; its candidate cap
	// and stale chunks omitted visible messages (including the query "你好").
	const sessionDir = ctx.paths.sessionDir;
	const archivePath = await resolveContainedPathAsync(sessionDir, "archives.json");
	const archived = archivePath ? await readJsonAsync<Record<string, boolean>>(archivePath, {}) : {};
	let files: string[];
	try {
		files = (await readdir(sessionDir)).filter((file) => file.endsWith(".jsonl"));
	} catch {
		return [];
	}
	const results: Array<SearchResult & { rank: number }> = [];
	for (const file of files) {
		const path = await resolveContainedPathAsync(sessionDir, file);
		const parsed = path ? await parseSessionFileAsync(ctx.dataDir, path) : null;
		if (!parsed) continue;
		for (const [index, message] of parsed.messages.entries()) {
			if (!includesQuery(message.content, query)) continue;
			results.push({
				id: `conversation:${parsed.summary.id}:${message.entryId ?? index}`,
				category: "conversation",
				title: parsed.summary.name,
				subtitle: new Date(message.timestamp).toISOString(),
				snippet: excerpt(message.content, query),
				updatedAt: parsed.summary.updatedAt,
				archived: archived[parsed.summary.id] === true,
				role: message.role,
				sessionId: parsed.summary.id,
				entryId: message.entryId,
				rank: rankText(message.content, query),
			});
		}
	}
	return results
		.sort((a, b) => b.rank - a.rank || Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? "") || a.id.localeCompare(b.id))
		.map(({ rank: _rank, ...result }) => result);
}

async function searchCategory(ctx: SearchRouteContext, query: string, category: SearchResultCategory): Promise<SearchResult[]> {
	switch (category) {
		case "conversation": return searchConversations(ctx, query);
		case "workspace": return searchWorkspaces(ctx, query);
		case "file": return searchWorkspaceFiles(ctx, query);
		case "knowledge": return searchKnowledge(ctx, query);
	}
}

export async function handleSearchRoutes(
	_req: HttpReq,
	res: ServerResponse,
	method: string,
	url: string,
	ctx: SearchRouteContext,
): Promise<boolean> {
	if (method !== "GET" || url.split("?")[0] !== "/api/search") return false;
	const params = new URL(url, "http://localhost").searchParams;
	const query = (params.get("query") ?? "").trim().slice(0, 200);
	const requestedCategory = params.get("category") ?? "all";
	const category: SearchCategory = ["all", ...CATEGORY_ORDER].includes(requestedCategory as SearchCategory)
		? requestedCategory as SearchCategory
		: "all";
	const requestedOffset = Number(params.get("offset") ?? 0);
	const offset = category !== "all" && Number.isSafeInteger(requestedOffset) && requestedOffset > 0 ? requestedOffset : 0;
	if (!query) {
		json(res, 200, { results: [], total: 0, counts: {} } satisfies SearchResponse);
		return true;
	}
	try {
		const categories = category === "all" ? CATEGORY_ORDER : [category];
		const groups = await Promise.all(categories.map(async (item) => ({ category: item, results: await searchCategory(ctx, query, item) })));
		const total = groups.reduce((sum, group) => sum + group.results.length, 0);
		json(res, 200, {
			results: groups.flatMap((group) => group.results.slice(offset, offset + RESULTS_PER_CATEGORY)),
			total,
			counts: Object.fromEntries(groups.map((group) => [group.category, group.results.length])),
			nextOffset: category !== "all" && offset + RESULTS_PER_CATEGORY < total ? offset + RESULTS_PER_CATEGORY : undefined,
		} satisfies SearchResponse);
	} catch (err) {
		json(res, 500, { error: err instanceof Error ? err.message : "Search failed" });
	}
	return true;
}
