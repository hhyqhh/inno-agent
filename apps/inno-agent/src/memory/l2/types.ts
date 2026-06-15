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
export type ManifestStatus = "pending" | "extracted" | "indexed" | "error";

/** Extracted content from a note attachment, merged into the parent note wiki. */
export interface NoteAttachmentExtract {
	rawPath: string;
	fileName: string;
	extractedPath: string;
	contentHash: string;
	sourceType: RawSourceType;
	updatedAt: string;
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
	source: {
		origin: "user_upload" | "conversation" | "web" | "research" | "agent_inferred";
		url?: string;
		sessionId?: string;
	};
	/** Legacy: separate manifest rows for attachments. Prefer attachmentExtracts. */
	parentSourceId?: string;
	/** Parsed attachment texts merged into this note's wiki page. */
	attachmentExtracts?: NoteAttachmentExtract[];
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
