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
	capture_mode?: ConversationCaptureMode;
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

// ============================================================================
// Document parsing
// ============================================================================

export interface ParsedDocumentResult {
	text: string;
	pageCount: number;
	pages: Array<{ pageNumber: number; text: string }>;
}

// ============================================================================
// Notes and attachments
// ============================================================================

export type NoteStatus = "draft" | "indexed" | "outdated" | "error";
export type ConversationCaptureMode = "transcript" | "summary";

export type MeetingStatus =
	| "connecting"
	| "recording"
	| "paused"
	| "finishing"
	| "summarizing"
	| "completed"
	| "no_speech"
	| "failed"
	| "interrupted";

export interface NoteFrontmatter {
	note_id: string;
	title: string;
	tags: string[];
	record_date: string;
	status: NoteStatus;
	meeting_id?: string;
	meeting_status?: MeetingStatus;
	source_session_id?: string;
	capture_mode?: ConversationCaptureMode;
	source_id?: string;
	created: string;
	updated: string;
}

export type NoteAttachmentStatus = "uploaded" | "extracting" | "extracted" | "indexed" | "error";

export interface NoteAttachmentRecord {
	id: string;
	noteRawPath: string;
	noteId: string;
	fileName: string;
	mimeType: string;
	size: number;
	filePath: string;
	status: NoteAttachmentStatus;
	createdAt: string;
	updatedAt: string;
}

export interface NoteTemplateDefinition {
	id: string;
	label: string;
	labelEn: string;
	description: string;
	descriptionEn: string;
	tags: string[];
	tagsEn: string[];
	body: string;
	defaultTitle: string;
	defaultTitleEn: string;
	hidden: boolean;
	source: "system" | "custom";
	editable: boolean;
}

export interface NoteTemplateInput {
	id: string;
	label: string;
	labelEn?: string;
	description?: string;
	descriptionEn?: string;
	tags?: string[];
	tagsEn?: string[];
	body: string;
	defaultTitle?: string;
	defaultTitleEn?: string;
	hidden?: boolean;
}

export type NotebookItemKind = "markdown" | "orphan" | "archived";
export type NotebookType = "conversation" | "file" | "note";
export type NotebookItemStatus = NoteStatus | ManifestStatus | "uploaded";

export interface NoteSummaryDto {
	noteId: string;
	rawPath: string;
	title: string;
	tags: string[];
	notebookType: NotebookType;
	contentType: RawSourceType;
	status: NotebookItemStatus;
	kind: NotebookItemKind;
	wikiPagePath?: string;
	wikiPages?: string[];
	origin?: ManifestEntry["source"]["origin"];
	extractedPath?: string;
	size?: number;
	createdAt: string;
	updatedAt: string;
	meetingId?: string;
	meetingStatus?: MeetingStatus;
	sourceSessionId?: string;
	captureMode?: ConversationCaptureMode;
}

export interface NoteContentDto {
	rawPath: string;
	noteId: string;
	title: string;
	tags: string[];
	recordDate: string;
	status: NoteStatus;
	sourceId?: string;
	content: string;
	attachments: NoteAttachmentRecord[];
	createdAt: string;
	updatedAt: string;
	meetingId?: string;
	meetingStatus?: MeetingStatus;
	sourceSessionId?: string;
	captureMode?: ConversationCaptureMode;
}

export interface NotesListResponse {
	notes: NoteSummaryDto[];
}

export interface DeleteNotebookItemResult {
	rawPath: string;
	title: string;
}

export interface SaveRawMarkdownResult {
	rawPath: string;
	status: ManifestStatus | "uploaded";
}

export interface UnarchiveResult {
	rawPath: string;
	title: string;
	removedWikiPages: string[];
	status: "draft" | "uploaded";
}

// ============================================================================
// Sources
// ============================================================================

export interface SourceSummaryDto {
	sourceId: string;
	title: string;
	notebookType: NotebookType;
	sourceType: RawSourceType;
	rawPath: string;
	extractedPath?: string;
	primaryWikiPath?: string;
	wikiPages: string[];
	tags: string[];
	status: ManifestStatus;
	origin: ManifestEntry["source"]["origin"];
	originUrl?: string;
	sessionId?: string;
	selectedScope?: SelectedScope;
	createdAt: string;
	updatedAt: string;
}

export interface OrphanRawFileDto {
	rawPath: string;
	fileName: string;
	sourceType: RawSourceType;
	size: number;
	modifiedAt: string;
	isMarkdown: boolean;
	pipelineStatus: "uploaded";
}

export interface SourcesListResponse {
	sources: SourceSummaryDto[];
	orphans: OrphanRawFileDto[];
}

export interface ArchiveRawResult {
	noteId: string;
	sourceId: string;
	title: string;
	rawPath: string;
	wikiPagePath: string;
	wikiPages: string[];
	status: "indexed";
}

export type StageL2FileResult =
	| { duplicate: true; existing: ManifestEntry }
	| {
		duplicate: false;
		sourceId: string;
		title: string;
		rawPath: string;
		status: "uploaded";
	};

export interface ExtractRawFileResult {
	sourceId: string;
	rawPath: string;
	extractedPath: string;
	pageCount?: number;
	textLength: number;
	status: "extracted";
}

export interface RegenerateSourceResult {
	sourceId: string;
	title: string;
	rawPath: string;
	wikiPagePath: string;
	wikiPages: string[];
	status: "indexed";
	updatedAt: string;
}

export interface AddSourceRelationResult {
	sourceId: string;
	title: string;
	rawPath: string;
	sourcePagePath: string;
	relationPagePath: string;
	relationTitle: string;
	relationType: Extract<WikiPageType, "concept" | "entity">;
	wikiPages: string[];
	status: "indexed";
	updatedAt: string;
}

export interface RemoveSourceRelationResult {
	sourceId: string;
	title: string;
	rawPath: string;
	sourcePagePath: string;
	relationPagePath: string;
	relationTitle: string;
	relationType: Extract<WikiPageType, "concept" | "entity">;
	wikiPages: string[];
	status: "indexed";
	deletedOrphanPage: boolean;
	updatedAt: string;
}

// ============================================================================
// Tags
// ============================================================================

export interface L2TagRecord {
	id: string;
	canonicalKey: string;
	displayName: string;
	usageCount: number;
	createdAt: string;
	updatedAt: string;
}

export interface L2PageTagRecord {
	wikiPath: string;
	tagId: string;
	sourceId?: string;
	createdAt: string;
}

export interface L2TagIndexFile {
	tags: L2TagRecord[];
	pageTags: L2PageTagRecord[];
	updatedAt: string;
}

export interface WikiPageTagSource {
	wikiPath: string;
	tags: string[];
	sourceIds: string[];
}

// ============================================================================
// Wiki links
// ============================================================================

export type LinkablePageType = Extract<WikiPageType, "entity" | "concept">;

export interface LinkedItem {
	title: string;
	type: LinkablePageType;
	description: string;
}

export interface WikiLinkMaintenanceResult {
	created: string[];
	updated: string[];
	unchanged: string[];
	pages: string[];
}

export interface WikiLinkMaintenanceOptions {
	createMissing?: boolean;
	currentRelations?: string;
	signal?: AbortSignal;
}
