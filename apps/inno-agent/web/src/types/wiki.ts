export type WikiPageType = "source-summary" | "entity" | "concept" | "analysis";
export type WikiPageStatus = "draft" | "reviewed" | "outdated";
export type ConfidenceLevel = "low" | "medium" | "high";
export type RawSourceType = "text" | "markdown" | "conversation" | "pdf" | "word" | "image";
export type RawKind = "uploaded-original" | "archived-text";
export type SourceOrigin = "user_upload" | "conversation" | "web" | "research" | "agent_inferred";

export type EvidenceLocator =
	| { kind: "pdf-page"; page: number; block_id: string }
	| { kind: "markdown-block"; block_id: string; heading?: string; paragraph: number }
	| { kind: "docx-paragraph"; block_id: string; heading?: string; paragraph: number };

export interface EvidenceBlock {
	id: string;
	kind: "pdf" | "markdown" | "docx";
	text: string;
	page?: number;
	heading?: string;
	paragraph?: number;
}

export type PositionReasonCode =
	| "missing-source"
	| "missing-file"
	| "stale-source"
	| "missing-index"
	| "corrupt-index"
	| "index-version-mismatch"
	| "stale-page"
	| "locator-invalid"
	| "quote-mismatch"
	| "drifted";

export interface ResolvedEvidenceReference {
	quote: string;
	locator: EvidenceLocator;
	selectedBy: "model" | "user";
	positionStatus: "verified" | PositionReasonCode;
	reasonCodes: PositionReasonCode[];
	/** Inline citation number matching a `[n]` marker in the page body, if any. */
	marker?: number;
}

interface SourceProvenanceMetadata {
	sourceId: string;
	title: string;
	sourceType: RawSourceType;
	origin: SourceOrigin;
	rawKind?: RawKind;
	references: ResolvedEvidenceReference[];
}

export type SourceProvenanceGroup =
	| (SourceProvenanceMetadata & {
		availability: "ready";
		rawRelativePath: string;
		sourceRevision: string;
	})
	| (SourceProvenanceMetadata & {
		availability: "missing-file";
		rawRelativePath?: string;
		lastKnownSourceRevision?: string;
	})
	| {
		availability: "missing-source";
		sourceId: string;
		references: ResolvedEvidenceReference[];
	};

export interface EvidenceReferenceIssue {
	ordinal: number;
	sourceId?: string;
	code:
		| "not-object"
		| "invalid-source-id"
		| "source-id-not-declared"
		| "invalid-quote"
		| "invalid-revision"
		| "invalid-selected-by"
		| "invalid-locator"
		| "invalid-marker";
}

export interface ProvenancePayload {
	sourceGroups: SourceProvenanceGroup[];
	legacyPaths: string[];
	referenceIssues: EvidenceReferenceIssue[];
}

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
	evidence_refs?: unknown[];
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
	/** Optional while the UI can still be paired with a pre-provenance backend. */
	pageRevision?: string;
	fileRevision?: string;
	provenance?: ProvenancePayload;
}

export interface EvidenceSliceResponse {
	sourceId: string;
	sourceRevision: string;
	indexVersion: 1;
	target: EvidenceBlock;
	neighbors: EvidenceBlock[];
	/** Number of entries in `neighbors` that precede `target` in source order. */
	precedingNeighborCount?: number;
}

export interface LocateRequest {
	quote: string;
	sourceRevision: string;
	indexVersion: 1;
}

export interface LocateMatch {
	locator: EvidenceLocator;
	occurrence?: number;
	occurrenceCount?: number;
}

export interface LocateResponse {
	matches: LocateMatch[];
	fallbackLocator?: EvidenceLocator;
}

export interface EvidenceMutationRequest {
	path: string;
	expectedPageRevision: string;
	expectedFileRevision: string;
}

export type SourceViewerTarget =
	| {
		mode: "exact";
		sourceId: string;
		title: string;
		sourceType: RawSourceType;
		rawKind?: RawKind;
		sourceRevision: string;
		quote: string;
		locator: EvidenceLocator;
		positionStatus: "verified" | PositionReasonCode;
		indexVersion: 1;
	}
	| {
		mode: "file";
		sourceId: string;
		title: string;
		sourceType: RawSourceType;
		rawKind?: RawKind;
		sourceRevision: string;
	};

export interface WikiGraphData {
	nodes: WikiGraphNode[];
	edges: WikiGraphEdge[];
	communities?: WikiGraphCommunities;
}

export interface WikiGraphNode {
	id: string;
	title: string;
	type: WikiPageType | "tag";
	tags: string[];
	degree?: number;
	community?: number;
}

export interface WikiGraphEdge {
	source: string;
	target: string;
	type: "link" | "tag";
	weight?: number;
}

export interface WikiGraphCommunities {
	count: number;
	modularity: number;
	lowCohesion: { community: number; cohesion: number; size: number }[];
}

export interface WikiStats {
	pageCount: number;
	totalSize: number;
	entryCount: number;
}
