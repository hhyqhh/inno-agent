import { apiFetch } from "./client.js";
import type { WikiPageSummary, WikiPageDetail, WikiGraphData, WikiStats } from "../types/wiki.js";

export async function listWikiPages(): Promise<WikiPageSummary[]> {
	return apiFetch<WikiPageSummary[]>("/api/wiki/pages");
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

export async function deleteWikiPage(path: string): Promise<void> {
	await apiFetch(`/api/wiki/page?path=${encodeURIComponent(path)}`, {
		method: "DELETE",
	});
}

export async function getWikiGraph(): Promise<WikiGraphData> {
	return apiFetch<WikiGraphData>("/api/wiki/graph");
}

export async function getWikiStats(): Promise<WikiStats> {
	return apiFetch<WikiStats>("/api/wiki/stats");
}
