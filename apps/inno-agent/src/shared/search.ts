export type SearchCategory = "all" | "conversation" | "workspace" | "file" | "knowledge";
export type SearchResultCategory = Exclude<SearchCategory, "all">;

export interface SearchResult {
	id: string;
	category: SearchResultCategory;
	title: string;
	subtitle: string;
	snippet: string;
	updatedAt?: string;
	archived?: boolean;
	role?: "user" | "assistant";
	sessionId?: string;
	entryId?: string;
	workspaceId?: string;
	path?: string;
}

export interface SearchResponse {
	results: SearchResult[];
	total: number;
	counts: Partial<Record<SearchResultCategory, number>>;
	/** Offset of the next page within a single category. */
	nextOffset?: number;
}
