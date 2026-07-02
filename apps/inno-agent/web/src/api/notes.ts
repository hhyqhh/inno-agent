import { apiFetch } from "./client.js";
import type {
	ArchiveNoteResult,
	CreateNoteResult,
	NoteAttachment,
	NoteContent,
	NotesListResponse,
	SaveNoteResult,
	UploadNoteAttachmentResult,
	UploadNoteFileResult,
} from "../types/notes.js";
import { arrayBufferToBase64 } from "./uploads.js";

export function l2RawFileUrl(rawPath: string): string {
	return `/api/l2/raw/file?path=${encodeURIComponent(rawPath)}`;
}

export async function listNotes(options?: {
	status?: string;
	notebookType?: string;
}): Promise<NotesListResponse> {
	const params = new URLSearchParams();
	if (options?.status) params.set("status", options.status);
	if (options?.notebookType) params.set("notebookType", options.notebookType);
	const query = params.toString();
	return apiFetch<NotesListResponse>(`/api/l2/notes${query ? `?${query}` : ""}`);
}

export async function fetchNoteContent(rawPath: string): Promise<NoteContent> {
	return apiFetch<NoteContent>(`/api/l2/notes/content?path=${encodeURIComponent(rawPath)}`);
}

export async function fetchRawContent(rawPath: string): Promise<string> {
	const data = await apiFetch<{ path: string; content: string }>(
		`/api/l2/raw/content?path=${encodeURIComponent(rawPath)}`,
	);
	return data.content;
}

export async function createNote(options: {
	title?: string;
	templateId?: string;
	tags?: string[];
	content?: string;
}): Promise<CreateNoteResult> {
	const result = await apiFetch<CreateNoteResult>("/api/l2/notes", {
		method: "POST",
		body: JSON.stringify(options),
	});
	return { ...result, notebookType: "note" };
}

export async function saveNoteContent(options: {
	rawPath: string;
	title: string;
	tags?: string[];
	recordDate?: string;
	content: string;
}): Promise<SaveNoteResult> {
	return apiFetch<SaveNoteResult>("/api/l2/notes/content", {
		method: "PUT",
		body: JSON.stringify(options),
	});
}

export async function archiveNote(
	rawPath: string,
	options: { title?: string; tags?: string[] } = {},
): Promise<ArchiveNoteResult> {
	return apiFetch<ArchiveNoteResult>("/api/l2/notes/archive", {
		method: "POST",
		body: JSON.stringify({ rawPath, ...options }),
	});
}

export async function uploadNoteFile(file: File): Promise<UploadNoteFileResult> {
	const dataBase64 = arrayBufferToBase64(await file.arrayBuffer());
	return apiFetch<UploadNoteFileResult>("/api/l2/notes/upload", {
		method: "POST",
		body: JSON.stringify({
			fileName: file.name,
			mimeType: file.type || "application/octet-stream",
			dataBase64,
		}),
	});
}

export async function listNoteAttachments(rawPath: string): Promise<NoteAttachment[]> {
	const data = await apiFetch<{ attachments: NoteAttachment[] }>(
		`/api/l2/notes/attachments?path=${encodeURIComponent(rawPath)}`,
	);
	return data.attachments;
}

export async function uploadNoteAttachment(rawPath: string, file: File): Promise<UploadNoteAttachmentResult> {
	const dataBase64 = arrayBufferToBase64(await file.arrayBuffer());
	return apiFetch<UploadNoteAttachmentResult>("/api/l2/notes/attachments", {
		method: "POST",
		body: JSON.stringify({
			noteRawPath: rawPath,
			fileName: file.name,
			mimeType: file.type || "application/octet-stream",
			dataBase64,
		}),
	});
}

export async function deleteNoteAttachment(attachmentId: string): Promise<{ attachmentId: string }> {
	return apiFetch<{ attachmentId: string }>(`/api/l2/notes/attachments/${encodeURIComponent(attachmentId)}`, {
		method: "DELETE",
	});
}
