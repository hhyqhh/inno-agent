export interface NoteDraftSummary {
	noteId: string;
	rawPath: string;
	title: string;
	status: "draft";
	createdAt: string;
	updatedAt: string;
}

export interface NoteDraft extends NoteDraftSummary {
	content: string;
}

export interface NoteDraftListResponse {
	notes: NoteDraftSummary[];
}

export interface DeleteNoteItemResult {
	rawPath: string;
	title: string;
}
