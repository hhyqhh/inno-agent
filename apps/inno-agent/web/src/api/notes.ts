import { apiFetch } from "./client.js";
import type {
	ArchiveNoteResult,
	CreateNoteResult,
	DeleteNoteItemResult,
	NoteAttachment,
	NoteContent,
	NotesListResponse,
	PolishAnalysisResult,
	PolishNoteResult,
	SaveNoteResult,
	SaveRawMarkdownResult,
	NoteVersion,
	NoteVersionSummary,
	UnarchiveNoteResult,
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

export async function fetchRawContent(rawPath: string, options: { full?: boolean } = {}): Promise<string> {
	const params = new URLSearchParams({ path: rawPath });
	if (options.full) params.set("full", "1");
	const data = await apiFetch<{ path: string; content: string }>(
		`/api/l2/raw/content?${params.toString()}`,
	);
	return data.content;
}

export async function saveRawMarkdownContent(options: {
	rawPath: string;
	content: string;
}): Promise<SaveRawMarkdownResult> {
	return apiFetch<SaveRawMarkdownResult>("/api/l2/raw/content", {
		method: "PUT",
		body: JSON.stringify(options),
	});
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
	saveReason?: "autosave" | "manual" | "restore";
}): Promise<SaveNoteResult> {
	return apiFetch<SaveNoteResult>("/api/l2/notes/content", {
		method: "PUT",
		body: JSON.stringify(options),
	});
}

export async function polishNote(options: {
	rawPath: string;
	title: string;
	tags: string[];
	content: string;
	templateId?: string;
	suggestedTags?: string[];
}, signal?: AbortSignal): Promise<PolishNoteResult> {
	return apiFetch<PolishNoteResult>("/api/l2/notes/polish", {
		method: "POST",
		body: JSON.stringify(options),
		signal,
	});
}

export async function archiveNote(
	rawPath: string,
	options: { title?: string; tags?: string[] } = {},
	signal?: AbortSignal,
): Promise<ArchiveNoteResult> {
	return apiFetch<ArchiveNoteResult>("/api/l2/notes/archive", {
		method: "POST",
		body: JSON.stringify({ rawPath, ...options }),
		signal,
	});
}

export async function analyzeNotePolish(options: {
	rawPath: string;
	title: string;
	tags: string[];
	content: string;
}, signal?: AbortSignal): Promise<PolishAnalysisResult> {
	return apiFetch<PolishAnalysisResult>("/api/l2/notes/polish", {
		method: "POST",
		body: JSON.stringify({ ...options, analyzeOnly: true }),
		signal,
	});
}

export async function deleteNoteItem(rawPath: string): Promise<DeleteNoteItemResult> {
	return apiFetch<DeleteNoteItemResult>(`/api/l2/notes?path=${encodeURIComponent(rawPath)}`, {
		method: "DELETE",
	});
}

export async function listNoteVersions(rawPath: string): Promise<NoteVersionSummary[]> {
	const data = await apiFetch<{ versions: NoteVersionSummary[] }>(
		`/api/l2/notes/versions?path=${encodeURIComponent(rawPath)}`,
	);
	return data.versions;
}

export async function fetchNoteVersion(rawPath: string, versionId: string): Promise<NoteVersion> {
	return apiFetch<NoteVersion>(
		`/api/l2/notes/version?path=${encodeURIComponent(rawPath)}&versionId=${encodeURIComponent(versionId)}`,
	);
}

export async function restoreNoteVersion(rawPath: string, versionId: string): Promise<SaveNoteResult> {
	return apiFetch<SaveNoteResult>("/api/l2/notes/versions/restore", {
		method: "POST",
		body: JSON.stringify({ rawPath, versionId }),
	});
}

export async function unarchiveNote(rawPath: string): Promise<UnarchiveNoteResult> {
	return apiFetch<UnarchiveNoteResult>("/api/l2/notes/unarchive", {
		method: "POST",
		body: JSON.stringify({ rawPath }),
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

export async function uploadNoteAttachment(
	rawPath: string,
	file: File,
	options: { placement?: "attachment" | "inline" } = {},
): Promise<UploadNoteAttachmentResult> {
	const dataBase64 = arrayBufferToBase64(await file.arrayBuffer());
	return apiFetch<UploadNoteAttachmentResult>("/api/l2/notes/attachments", {
		method: "POST",
		body: JSON.stringify({
			noteRawPath: rawPath,
			fileName: file.name,
			mimeType: file.type || "application/octet-stream",
			dataBase64,
			placement: options.placement ?? "attachment",
		}),
	});
}

export async function deleteNoteAttachment(attachmentId: string): Promise<{ attachmentId: string }> {
	return apiFetch<{ attachmentId: string }>(`/api/l2/notes/attachments/${encodeURIComponent(attachmentId)}`, {
		method: "DELETE",
	});
}
