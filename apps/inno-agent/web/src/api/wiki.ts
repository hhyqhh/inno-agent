import { apiFetch } from "./client.js";
import type {
	WikiPageSummary,
	WikiPageDetail,
	WikiGraphData,
	WikiStats,
	RegenerateSourceResult,
	WikiGraphNodeDetail,
	WikiTagSummary,
} from "../types/wiki.js";

export async function listWikiPages(tag?: string): Promise<WikiPageSummary[]> {
	const query = tag ? `?tag=${encodeURIComponent(tag)}` : "";
	return apiFetch<WikiPageSummary[]>(`/api/wiki/pages${query}`);
}

export async function getWikiPage(path: string): Promise<WikiPageDetail> {
	return apiFetch<WikiPageDetail>(`/api/wiki/page?path=${encodeURIComponent(path)}`);
}

export async function updateWikiPage(path: string, content: string): Promise<void> {
	await apiFetch("/api/wiki/page", {
		method: "PUT",
		body: JSON.stringify({ path, content }),
	});
}

export async function updateWikiPageTags(path: string, tags: string[]): Promise<string[]> {
	const result = await apiFetch<{ tags?: string[]; Tags?: string[] }>("/api/wiki/page/tags", {
		method: "PATCH",
		body: JSON.stringify({ path, tags }),
	});
	return result.tags ?? result.Tags ?? [];
}

export async function deleteWikiPage(path: string): Promise<void> {
	await apiFetch(`/api/wiki/page?path=${encodeURIComponent(path)}`, {
		method: "DELETE",
	});
}

export async function getWikiGraph(): Promise<WikiGraphData> {
	return apiFetch<WikiGraphData>("/api/wiki/graph");
}

export async function getWikiGraphNode(nodeId: string): Promise<WikiGraphNodeDetail> {
	return apiFetch<WikiGraphNodeDetail>(`/api/wiki/graph/node?nodeId=${encodeURIComponent(nodeId)}`);
}

export async function listWikiTags(): Promise<WikiTagSummary[]> {
	const result = await apiFetch<{
		tags?: WikiTagSummary[];
		Tags?: Array<{ TagID: string; CanonicalKey: string; DisplayName: string; UsageCount: number; UpdatedAt: string }>;
	}>("/api/l2/tags");
	if (result.tags) return result.tags;
	return (result.Tags ?? []).map((tag) => ({
		id: tag.TagID,
		canonicalKey: tag.CanonicalKey,
		displayName: tag.DisplayName,
		usageCount: tag.UsageCount,
		updatedAt: tag.UpdatedAt,
	}));
}

export async function getWikiStats(): Promise<WikiStats> {
	return apiFetch<WikiStats>("/api/wiki/stats");
}

export async function regenerateSource(sourceId: string): Promise<RegenerateSourceResult> {
	return apiFetch<RegenerateSourceResult>("/api/l2/sources/regenerate", {
		method: "POST",
		body: JSON.stringify({
			Action: "RegenerateSource",
			SourceID: sourceId,
			RegenerateTags: true,
			RegenerateLinks: true,
		}),
	});
}
