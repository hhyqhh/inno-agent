export type RawSourceType = "text" | "markdown" | "conversation" | "pdf" | "word" | "image";
export type SourceDraftFilter = "all" | "draft" | "archived";

export interface WikiPageRef {
	path: string;
	title: string;
}

export interface SourceSummary {
	id: string;
	title: string;
	sourceType: RawSourceType;
	rawPath: string;
	fileName: string;
	size: number;
	tags: string[];
	wikiPages: WikiPageRef[];
	origin: string;
	url?: string;
	createdAt: string;
	updatedAt: string;
}

export interface OrphanRawFile {
	rawPath: string;
	fileName: string;
	size: number;
	updatedAt: string;
}

export interface NoteAttachment {
	rawPath: string;
	fileName: string;
	size: number;
	updatedAt: string;
}

export interface SaveRawNoteResponse {
	archived: boolean;
	source?: SourceSummary;
	orphan?: OrphanRawFile;
}

export interface SourcesListResponse {
	sources: SourceSummary[];
	orphans: OrphanRawFile[];
}
