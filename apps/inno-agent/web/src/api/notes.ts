import { apiFetch } from "./client.js";
import type { DeleteNoteItemResult, NoteDraft, NoteDraftListResponse } from "../types/notes.js";

export function listNoteDrafts(): Promise<NoteDraftListResponse> {
	return apiFetch<NoteDraftListResponse>("/api/l2/notes");
}

export function fetchNoteDraft(rawPath: string): Promise<NoteDraft> {
	return apiFetch<NoteDraft>(`/api/l2/notes/content?path=${encodeURIComponent(rawPath)}`);
}

export function createNoteDraft(options: { title?: string; content?: string } = {}): Promise<NoteDraft> {
	return apiFetch<NoteDraft>("/api/l2/notes", {
		method: "POST",
		body: JSON.stringify(options),
	});
}

export function saveNoteDraft(options: { rawPath: string; title: string; content: string }): Promise<NoteDraft> {
	return apiFetch<NoteDraft>("/api/l2/notes/content", {
		method: "PUT",
		body: JSON.stringify(options),
	});
}

export function deleteNoteItem(rawPath: string): Promise<DeleteNoteItemResult> {
	return apiFetch<DeleteNoteItemResult>(`/api/l2/notes?path=${encodeURIComponent(rawPath)}`, {
		method: "DELETE",
	});
}
