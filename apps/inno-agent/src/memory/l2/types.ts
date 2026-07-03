// ============================================================================
// L2 Wiki Memory — Type Definitions
// ============================================================================

/** Raw source types. MVP supports text, markdown, conversation. */
export type RawSourceType = "text" | "markdown" | "conversation" | "pdf" | "word" | "image";

/** Wiki page types. */
export type WikiPageType = "source-summary" | "entity" | "concept" | "analysis";

/** Page review status. */
export type WikiPageStatus = "draft" | "reviewed" | "outdated";

/** Confidence level for wiki content. */
export type ConfidenceLevel = "low" | "medium" | "high";

/** Processing status for manifest entries. */
export type ManifestStatus = "pending" | "uploaded" | "extracting" | "extracted" | "indexing" | "indexed" | "outdated" | "error";

export interface SelectedScope {
	pages?: number[];
	chapters?: string[];
	range?: string;
}

/**
 * Manifest entry — one per ingested source.
 * Stored as a line in data/l2/manifest.jsonl (append-only).
 */
export interface ManifestEntry {
	id: string;
	title: string;
	sourceType: RawSourceType;
	rawPath: string;
	extractedPath?: string;
	wikiPages: string[];
	tags: string[];
	contentHash: string;
	status: ManifestStatus;
	notebook_type?: "conversation" | "file" | "note";
	primary_wiki_path?: string;
	selected_scope?: SelectedScope;
	error_message?: string | null;
	archived_at?: string | null;
	message_ids?: string[];
	source: {
		origin: "user_upload" | "conversation" | "web" | "research" | "agent_inferred";
		url?: string;
		sessionId?: string;
	};
	createdAt: string;
	updatedAt: string;
}

/**
 * YAML frontmatter for wiki pages.
 */
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

/**
 * Result returned from an ingest operation.
 */
export interface IngestResult {
	id: string;
	title: string;
	rawPath: string;
	extractedPath: string;
	wikiPagePath: string;
	message: string;
}
