import { apiFetch } from "./client.js";
import type {
	RegenerateSourceResult,
	WikiPageSummary,
	WikiPageDetail,
	WikiGraphData,
	WikiStats,
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
	const result = await apiFetch<{ tags: string[] }>("/api/wiki/page/tags", {
		method: "PATCH",
		body: JSON.stringify({ path, tags }),
	});
	return result.tags;
}

export async function deleteWikiPage(path: string): Promise<void> {
	await apiFetch(`/api/wiki/page?path=${encodeURIComponent(path)}`, {
		method: "DELETE",
	});
}

export async function getWikiGraph(): Promise<WikiGraphData> {
	return apiFetch<WikiGraphData>("/api/wiki/graph");
}

export async function listWikiTags(): Promise<WikiTagSummary[]> {
	const result = await apiFetch<{ tags: WikiTagSummary[] }>("/api/l2/tags");
	return result.tags;
}

export async function regenerateSource(sourceId: string): Promise<RegenerateSourceResult> {
	return apiFetch<RegenerateSourceResult>("/api/l2/sources/regenerate", {
		method: "POST",
		body: JSON.stringify({ sourceId }),
	});
}

export async function getWikiStats(): Promise<WikiStats> {
	return apiFetch<WikiStats>("/api/wiki/stats");
}
