import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";

import { readJson, writeJson, readText } from "../../storage/file-store.js";
import { parseNoteFrontmatter } from "./note-frontmatter.js";

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

const INDEX_FILE = "note-attachments.json";

function attachmentsIndexPath(l2DataDir: string): string {
	return join(l2DataDir, INDEX_FILE);
}

function readAttachmentIndex(l2DataDir: string): NoteAttachmentRecord[] {
	return readJson<NoteAttachmentRecord[]>(attachmentsIndexPath(l2DataDir), []);
}

function writeAttachmentIndex(l2DataDir: string, records: NoteAttachmentRecord[]): void {
	writeJson(attachmentsIndexPath(l2DataDir), records);
}

function normalizeNoteRawPath(rawPath: string): string {
	return rawPath.replace(/\\/g, "/");
}

function sanitizeAttachmentName(name: string): string {
	const cleaned = name
		.replace(/[/\\?%*:|"<>]/g, "-")
		.replace(/\s+/g, " ")
		.trim();
	return cleaned || "attachment";
}

function attachmentExtension(fileName: string, mimeType: string): string {
	const ext = extname(fileName);
	if (ext) return ext;
	if (mimeType === "application/pdf") return ".pdf";
	if (mimeType.includes("wordprocessingml")) return ".docx";
	if (mimeType.includes("spreadsheetml")) return ".xlsx";
	if (mimeType.includes("presentationml")) return ".pptx";
	if (mimeType === "text/markdown") return ".md";
	if (mimeType.startsWith("image/")) return `.${mimeType.slice("image/".length).replace("jpeg", "jpg")}`;
	if (mimeType.startsWith("text/")) return ".txt";
	return ".bin";
}

function uniqueAttachmentName(dir: string, fileName: string, mimeType: string): string {
	const safeName = sanitizeAttachmentName(fileName);
	const ext = attachmentExtension(safeName, mimeType);
	const base = basename(safeName, ext).slice(0, 120) || "attachment";
	let candidate = `${base}${ext}`;
	let index = 1;
	while (existsSync(join(dir, candidate))) {
		index += 1;
		candidate = `${base} (${index})${ext}`;
	}
	return candidate;
}

export function listNoteAttachments(l2DataDir: string, noteRawPath: string): NoteAttachmentRecord[] {
	const normalizedPath = normalizeNoteRawPath(noteRawPath);
	return readAttachmentIndex(l2DataDir)
		.filter((record) => normalizeNoteRawPath(record.noteRawPath) === normalizedPath)
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function updateNoteAttachmentStatus(
	l2DataDir: string,
	attachmentId: string,
	status: NoteAttachmentStatus,
): NoteAttachmentRecord {
	const records = readAttachmentIndex(l2DataDir);
	const index = records.findIndex((record) => record.id === attachmentId);
	if (index < 0) {
		throw new Error("Attachment not found");
	}
	const updated: NoteAttachmentRecord = {
		...records[index],
		status,
		updatedAt: new Date().toISOString(),
	};
	records[index] = updated;
	writeAttachmentIndex(l2DataDir, records);
	return updated;
}

export function uploadNoteAttachment(
	l2DataDir: string,
	noteRawPath: string,
	options: { fileName: string; mimeType: string; dataBase64: string },
): NoteAttachmentRecord {
	const normalizedPath = normalizeNoteRawPath(noteRawPath);
	if (!normalizedPath.startsWith("raw/notes/") || !normalizedPath.endsWith(".md")) {
		throw new Error("Invalid note path");
	}

	const { frontmatter } = parseNoteFrontmatter(readText(join(l2DataDir, normalizedPath)));
	if (!frontmatter?.note_id) {
		throw new Error("Invalid note file");
	}
	const attachmentId = `att_${randomUUID().slice(0, 8)}`;
	const attachmentDir = join(l2DataDir, "raw", "notes", "attachments", frontmatter.note_id);
	mkdirSync(attachmentDir, { recursive: true });
	const storedName = uniqueAttachmentName(attachmentDir, options.fileName, options.mimeType);
	const absPath = join(attachmentDir, storedName);
	const data = Buffer.from(options.dataBase64, "base64");
	writeFileSync(absPath, data);

	const now = new Date().toISOString();
	const record: NoteAttachmentRecord = {
		id: attachmentId,
		noteRawPath: normalizedPath,
		noteId: frontmatter.note_id,
		fileName: options.fileName,
		mimeType: options.mimeType,
		size: data.length,
		filePath: join("raw/notes/attachments", frontmatter.note_id, storedName).replace(/\\/g, "/"),
		status: "uploaded",
		createdAt: now,
		updatedAt: now,
	};

	const records = readAttachmentIndex(l2DataDir);
	records.push(record);
	writeAttachmentIndex(l2DataDir, records);
	return record;
}

export function deleteNoteAttachment(l2DataDir: string, attachmentId: string): NoteAttachmentRecord {
	const records = readAttachmentIndex(l2DataDir);
	const index = records.findIndex((record) => record.id === attachmentId);
	if (index < 0) {
		throw new Error("Attachment not found");
	}

	const [removed] = records.splice(index, 1);
	writeAttachmentIndex(l2DataDir, records);

	const absPath = join(l2DataDir, removed.filePath);
	if (existsSync(absPath)) {
		unlinkSync(absPath);
	}
	return removed;
}

/**
 * Remove all attachment records and files belonging to a note.
 * Returns the number of attachments removed.
 */
export function deleteAttachmentsForNote(l2DataDir: string, noteRawPath: string): number {
	const normalizedPath = normalizeNoteRawPath(noteRawPath);
	const records = readAttachmentIndex(l2DataDir);
	const kept: NoteAttachmentRecord[] = [];
	const removed: NoteAttachmentRecord[] = [];
	for (const record of records) {
		if (normalizeNoteRawPath(record.noteRawPath) === normalizedPath) removed.push(record);
		else kept.push(record);
	}
	if (removed.length === 0) return 0;
	writeAttachmentIndex(l2DataDir, kept);
	for (const record of removed) {
		const absPath = join(l2DataDir, record.filePath);
		if (existsSync(absPath)) {
			try {
				unlinkSync(absPath);
			} catch {
				// best-effort cleanup; the index record is already gone
			}
		}
	}
	return removed.length;
}

export function findNoteAttachment(l2DataDir: string, attachmentId: string): NoteAttachmentRecord | undefined {
	return readAttachmentIndex(l2DataDir).find((record) => record.id === attachmentId);
}
