import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { readJson, writeJson, readText } from "../../storage/file-store.js";
import { resolveContainedPath } from "../../utils/path-safety.js";
import { parseNoteFrontmatter } from "./note-frontmatter.js";
import { sanitizeUploadedFileName, uploadExtension } from "./upload-file-utils.js";

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

export function listNoteAttachments(l2DataDir: string, noteRawPath: string): NoteAttachmentRecord[] {
	const normalizedPath = normalizeNoteRawPath(noteRawPath);
	return readAttachmentIndex(l2DataDir)
		.filter((record) => normalizeNoteRawPath(record.noteRawPath) === normalizedPath)
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function uploadNoteAttachment(
	l2DataDir: string,
	noteRawPath: string,
	options: { fileName: string; mimeType: string; dataBase64: string },
): NoteAttachmentRecord {
	const normalizedPath = normalizeNoteRawPath(noteRawPath);
	const noteRelativePath = normalizedPath.slice("raw/notes/".length);
	if (
		!normalizedPath.startsWith("raw/notes/")
		|| noteRelativePath.includes("/")
		|| !noteRelativePath.toLowerCase().endsWith(".md")
	) {
		throw new Error("Invalid note path");
	}

	const notePath = resolveContainedPath(join(l2DataDir, "raw", "notes"), noteRelativePath);
	if (!notePath) throw new Error("Invalid note path");
	const { frontmatter } = parseNoteFrontmatter(readText(notePath));
	if (!frontmatter?.note_id) {
		throw new Error("Invalid note file");
	}
	const noteId = frontmatter.note_id.trim();
	if (!/^note_[A-Za-z0-9_-]+$/.test(noteId)) {
		throw new Error("Invalid note id");
	}
	const attachmentId = `att_${randomUUID().slice(0, 8)}`;
	const safeName = sanitizeUploadedFileName(options.fileName, "attachment");
	const ext = uploadExtension(safeName, options.mimeType);
	const base = basename(safeName, ext).slice(0, 80) || "attachment";
	const storedName = `${attachmentId}-${base}${ext}`;
	const attachmentsRoot = join(l2DataDir, "raw", "notes", "attachments");
	const attachmentDir = resolveContainedPath(attachmentsRoot, noteId);
	if (!attachmentDir) throw new Error("Invalid attachment path");
	mkdirSync(attachmentDir, { recursive: true });
	const absPath = resolveContainedPath(attachmentDir, storedName);
	if (!absPath) throw new Error("Invalid attachment path");
	const data = Buffer.from(options.dataBase64, "base64");
	writeFileSync(absPath, data);

	const now = new Date().toISOString();
	const record: NoteAttachmentRecord = {
		id: attachmentId,
		noteRawPath: normalizedPath,
		noteId,
		fileName: options.fileName,
		mimeType: options.mimeType,
		size: data.length,
		filePath: join("raw/notes/attachments", noteId, storedName).replace(/\\/g, "/"),
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

	const removed = records[index];
	const normalizedFilePath = removed.filePath.replace(/\\/g, "/");
	const attachmentPrefix = "raw/notes/attachments/";
	if (!normalizedFilePath.startsWith(attachmentPrefix)) {
		throw new Error("Invalid attachment path");
	}
	const absPath = resolveContainedPath(
		join(l2DataDir, "raw", "notes", "attachments"),
		normalizedFilePath.slice(attachmentPrefix.length),
	);
	if (!absPath) throw new Error("Invalid attachment path");

	records.splice(index, 1);
	writeAttachmentIndex(l2DataDir, records);

	if (existsSync(absPath)) {
		unlinkSync(absPath);
	}
	return removed;
}

export function findNoteAttachment(l2DataDir: string, attachmentId: string): NoteAttachmentRecord | undefined {
	return readAttachmentIndex(l2DataDir).find((record) => record.id === attachmentId);
}
