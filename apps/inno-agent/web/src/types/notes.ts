export type NoteStatus = "draft" | "indexed" | "outdated" | "error";
export type ManifestStatus = "pending" | "uploaded" | "extracting" | "extracted" | "indexing" | "indexed" | "outdated" | "error";
export type RawSourceType = "text" | "markdown" | "conversation" | "pdf" | "word" | "image";
export type NotebookType = "conversation" | "file" | "note";
export type NotebookItemKind = "markdown" | "orphan" | "archived";
export type NotebookItemStatus = NoteStatus | ManifestStatus | "uploaded";
export type MeetingStatus = "connecting" | "recording" | "paused" | "finishing" | "summarizing" | "completed" | "no_speech" | "failed" | "interrupted";

export interface NoteSummary {
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
	origin?: "user_upload" | "conversation" | "web" | "research" | "agent_inferred";
	extractedPath?: string;
	size?: number;
	createdAt: string;
	updatedAt: string;
	meetingId?: string;
	meetingStatus?: MeetingStatus;
}

export interface NoteContent {
	rawPath: string;
	noteId: string;
	title: string;
	tags: string[];
	recordDate: string;
	status: NoteStatus;
	sourceId?: string;
	content: string;
	attachments: NoteAttachment[];
	createdAt: string;
	updatedAt: string;
	meetingId?: string;
	meetingStatus?: MeetingStatus;
}

export type NoteAttachmentStatus = "uploaded" | "extracting" | "extracted" | "indexed" | "error";

export interface NoteAttachment {
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

export interface UploadNoteAttachmentResult {
	attachmentId: string;
	filePath: string;
	status: NoteAttachmentStatus;
	attachment: NoteAttachment;
}

export interface NotesListResponse {
	notes: NoteSummary[];
}

export interface CreateNoteResult {
	rawPath: string;
	status: NoteStatus;
	noteId: string;
	title: string;
	notebookType: "note";
}

export interface SaveNoteResult {
	rawPath: string;
	status: NoteStatus;
}

export interface SaveRawMarkdownResult {
	rawPath: string;
	status: ManifestStatus | "uploaded";
}

export interface UploadNoteFileResult {
	fileName: string;
	mimeType: string;
	size: number;
	rawPath: string;
	notebookType: "file";
	status: "uploaded";
}

export interface ArchiveNoteResult {
	noteId: string;
	sourceId?: string;
	title: string;
	rawPath: string;
	wikiPagePath: string;
	wikiPages: string[];
	status: "indexed";
}

export interface DeleteNoteItemResult {
	rawPath: string;
	title: string;
}

export interface UnarchiveNoteResult {
	rawPath: string;
	title: string;
	removedWikiPages: string[];
	status: "draft" | "uploaded";
}

export interface PolishNoteResult {
	content: string;
	templateId: string | null;
	templateLabel: string | null;
	suggestedTags: string[];
}

export type NoteListBox = "drafts" | "archived";
