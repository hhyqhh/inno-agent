import type { SearchCategory, SearchResponse } from "../../../src/shared/search.js";
import { apiFetch } from "./client.js";

export async function searchInnoAgent(
	query: string,
	category: SearchCategory,
	signal?: AbortSignal,
	offset = 0,
): Promise<SearchResponse> {
	const params = new URLSearchParams({ query, category });
	if (offset > 0) params.set("offset", String(offset));
	return apiFetch<SearchResponse>(`/api/search?${params.toString()}`, { signal });
}
