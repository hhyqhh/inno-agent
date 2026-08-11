import { join } from "node:path";
import { readText, fileExists } from "../../storage/file-store.js";
import { readManifest } from "./manifest-store.js";
import type { ManifestEntry } from "./types.js";
import type { L2Memory } from "./l2-memory.js";
import type { L2SearchResult } from "./l2-search.js";
import { normalizeL2Path } from "./l2-path.js";

export interface WikiQueryHit {
	path: string;
	title: string;
	score: number | null;
	via: string[];
	sourceIds: string[];
}

export interface WikiQueryDetailedResult {
	text: string;
	mode: "indexed" | "substring";
	hits: WikiQueryHit[];
}

/**
 * Read the wiki index.
 */
export function readIndex(l2DataDir: string): string {
	const indexPath = join(l2DataDir, "wiki", "index.md");
	if (!fileExists(indexPath)) return "L2 Wiki 尚未初始化，暂无索引。";
	return readText(indexPath);
}

/**
 * Read a specific wiki page by relative path.
 */
export function readWikiPage(l2DataDir: string, relativePath: string): string | null {
	const absPath = join(l2DataDir, normalizeL2Path(relativePath));
	if (!fileExists(absPath)) return null;
	return readText(absPath);
}

/**
 * Search manifest entries by keyword.
 * Searches title, tags, AND wiki page body content for full recall.
 */
export function searchEntries(l2DataDir: string, query: string): ManifestEntry[] {
	const entries = readManifest(l2DataDir);
	const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);
	return entries.filter((entry) => {
		// Search title + tags first (fast path)
		const metaText = [entry.title, ...entry.tags].join(" ").toLowerCase();
		if (keywords.some((kw) => metaText.includes(kw))) return true;
		// Fall back to searching wiki page body content
		for (const wikiPath of entry.wikiPages) {
			const content = readWikiPage(l2DataDir, wikiPath);
			if (content && keywords.some((kw) => content.toLowerCase().includes(kw))) return true;
		}
		return false;
	});
}

/**
 * Query wiki: return index + matched page contents.
 */
export function queryWiki(l2DataDir: string, query: string): string {
	const index = readIndex(l2DataDir);
	const trimmed = (query ?? "").trim();

	// Empty query → just return the index overview.
	if (!trimmed) {
		return `## Wiki 索引\n\n${index}\n\n---\n\n提示：传入 query 参数（如「Python async」）可定位并返回相关页面内容。`;
	}

	const matches = searchEntries(l2DataDir, trimmed);

	if (matches.length === 0) {
		return `## Wiki 索引\n\n${index}\n\n---\n\n未找到与「${trimmed}」相关的内容。`;
	}

	const sections: string[] = [
		`## Wiki 索引\n\n${index}`,
		"---",
		`## 查询结果: "${trimmed}" (${matches.length} 条匹配)`,
		"",
	];

	for (const entry of matches.slice(0, 5)) {
		for (const wikiPath of entry.wikiPages) {
			const content = readWikiPage(l2DataDir, wikiPath);
			if (content) {
				sections.push(`### [[${entry.title}]]\n`);
				sections.push(content);
				sections.push("---\n");
			}
		}
	}

	return sections.join("\n");
}

/**
 * Query wiki via indexed retrieval (BM25 + graph), falling back to
 * the substring {@link queryWiki} when the index store is unavailable.
 */
export async function queryWikiHybridDetailed(l2Memory: L2Memory, query: string): Promise<WikiQueryDetailedResult> {
	const l2DataDir = l2Memory.dataDir;
	const index = readIndex(l2DataDir);
	const trimmed = (query ?? "").trim();

	if (!trimmed) {
		return {
			text: `## Wiki 索引\n\n${index}\n\n---\n\n提示：传入 query 参数（如「Python async」）可定位并返回相关页面内容。`,
			mode: "indexed",
			hits: [],
		};
	}

	const results = await l2Memory.search(trimmed, 5);
	if (results === null) {
		const matches = searchEntries(l2DataDir, trimmed);
		return {
			text: queryWiki(l2DataDir, query),
			mode: "substring",
			hits: matches.slice(0, 5).flatMap((entry) => entry.wikiPages.map((path) => ({
				path,
				title: entry.title,
				score: null,
				via: ["substring"],
				sourceIds: [entry.id],
			}))),
		};
	}
	if (results.length === 0) {
		return {
			text: `## Wiki 索引\n\n${index}\n\n---\n\n未找到与「${trimmed}」相关的内容。`,
			mode: "indexed",
			hits: [],
		};
	}

	const sections: string[] = [
		`## Wiki 索引\n\n${index}`,
		"---",
		`## 查询结果: "${trimmed}" (${results.length} 条匹配)`,
		"",
	];
	for (const r of results) {
		const content = readWikiPage(l2DataDir, r.path);
		if (content) {
			sections.push(`### [[${r.title}]]  \`${r.path}\`  (${r.via.join("+")})\n`);
			sections.push(content);
			sections.push("---\n");
		}
	}
	return {
		text: sections.join("\n"),
		mode: "indexed",
		hits: results.map((result: L2SearchResult) => ({
			path: result.path,
			title: result.title,
			score: result.score,
			via: result.via,
			sourceIds: result.sourceIds,
		})),
	};
}

export async function queryWikiHybrid(l2Memory: L2Memory, query: string): Promise<string> {
	return (await queryWikiHybridDetailed(l2Memory, query)).text;
}
