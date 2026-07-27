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

export interface WikiTagSummary {
	id: string;
	canonicalKey: string;
	displayName: string;
	usageCount: number;
	updatedAt: string;
}

export interface WikiRelatedSource {
	id: string;
	title: string;
	rawPath: string;
	primaryWikiPath: string;
	wikiPages: string[];
	tags: string[];
	status: string;
	notebookType: string;
	updatedAt: string;
}

export interface WikiGraphNodeDetail {
	nodeId: string;
	title: string;
	type: WikiPageType | "tag";
	relatedPages: WikiPageSummary[];
	relatedSources: WikiRelatedSource[];
	bodyPreview?: string;
}

export interface WikiStats {
	pageCount: number;
	totalSize: number;
	entryCount: number;
}

export interface RegenerateSourceResult {
	sourceId: string;
	wikiPagePath: string;
	wikiPages: string[];
	status: "indexed";
	updatedAt: string;
}
