import { apiFetch } from "./client.js";
import type { NoteAttachment, SaveRawNoteResponse, SourceSummary, SourcesListResponse, OrphanRawFile } from "../types/sources.js";

export async function listSources(): Promise<SourcesListResponse> {
	return apiFetch<SourcesListResponse>("/api/l2/sources");
}

export async function getSource(id: string): Promise<SourceSummary> {
	return apiFetch<SourceSummary>(`/api/l2/sources/${encodeURIComponent(id)}`);
}

export function l2RawUrl(rawPath: string, options?: { download?: boolean }): string {
	const params = new URLSearchParams({ path: rawPath });
	if (options?.download) {
		params.set("download", "1");
	}
	return `/api/l2/raw?${params.toString()}`;
}

export async function fetchRawFile(rawPath: string): Promise<string> {
	const res = await fetch(l2RawUrl(rawPath));
	if (!res.ok) throw new Error("Failed to load raw file");
	return res.text();
}

export async function createRawNote(content: string, fileName: string): Promise<OrphanRawFile> {
	return apiFetch<OrphanRawFile>("/api/l2/raw/note", {
		method: "POST",
		body: JSON.stringify({ content, fileName }),
	});
}

export async function updateRawFile(rawPath: string, content: string): Promise<SaveRawNoteResponse> {
	return apiFetch<SaveRawNoteResponse>(`/api/l2/raw?path=${encodeURIComponent(rawPath)}`, {
		method: "PUT",
		body: JSON.stringify({ content }),
	});
}

export async function deleteRawFile(rawPath: string): Promise<void> {
	await apiFetch(`/api/l2/raw?path=${encodeURIComponent(rawPath)}`, { method: "DELETE" });
}

export async function listNoteAttachments(noteRawPath: string): Promise<NoteAttachment[]> {
	const data = await apiFetch<{ attachments: NoteAttachment[] }>(
		`/api/l2/raw/note/attachments?path=${encodeURIComponent(noteRawPath)}`,
	);
	return data.attachments;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
	let binary = "";
	const bytes = new Uint8Array(buffer);
	const chunkSize = 0x8000;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		const chunk = bytes.subarray(i, i + chunkSize);
		binary += String.fromCharCode(...chunk);
	}
	return btoa(binary);
}

export async function uploadNoteAttachment(noteRawPath: string, file: File): Promise<NoteAttachment> {
	const dataBase64 = arrayBufferToBase64(await file.arrayBuffer());
	return apiFetch<NoteAttachment>(`/api/l2/raw/note/attachments?path=${encodeURIComponent(noteRawPath)}`, {
		method: "POST",
		body: JSON.stringify({
			fileName: file.name,
			dataBase64,
		}),
	});
}
