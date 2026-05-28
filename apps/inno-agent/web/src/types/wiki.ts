export type WikiPageType = "source-summary" | "entity" | "concept" | "analysis";
export type WikiPageStatus = "draft" | "reviewed" | "outdated";
export type ConfidenceLevel = "low" | "medium" | "high";

export interface WikiPageFrontmatter {
	title: string;
	created: string;
	type: WikiPageType;
	tags: string[];
	sources: string[];
	source_ids: string[];
	updated: string;
	status: WikiPageStatus;
	confidence: ConfidenceLevel;
	contested?: boolean;
	contradictions?: string[];
}

export interface WikiPageSummary {
	path: string;
	frontmatter: WikiPageFrontmatter | null;
	bodyPreview: string;
	sourceId: string;
}

export interface WikiPageDetail {
	path: string;
	content: string;
}

export interface WikiGraphData {
	nodes: WikiGraphNode[];
	edges: WikiGraphEdge[];
}

export interface WikiGraphNode {
	id: string;
	title: string;
	type: WikiPageType | "tag";
	tags: string[];
}

export interface WikiGraphEdge {
	source: string;
	target: string;
	type: "link" | "tag";
}

export interface WikiStats {
	pageCount: number;
	totalSize: number;
	entryCount: number;
}
