import { basename, join } from "node:path";
import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";

import { ensureDir } from "../../storage/file-store.js";
import { isUserNotePath } from "./note-archiver.js";
import { safeL2RawPath } from "./source-resolver.js";

export interface NoteAttachmentView {
	rawPath: string;
	fileName: string;
	size: number;
	updatedAt: string;
}

/** Attachment files live beside the note: raw/notes/{stem}/file.ext */
export function noteAttachmentDirRel(noteRawPath: string): string {
	const normalized = noteRawPath.replace(/^\/+/, "");
	const stem = basename(normalized, ".md");
	return join("raw", "notes", stem).replace(/\\/g, "/");
}

export function isNoteAttachmentPath(rawPath: string): boolean {
	const normalized = rawPath.replace(/^\/+/, "");
	return /^raw\/notes\/[^/]+\/.+/.test(normalized);
}

/** Resolve parent note raw path from an attachment path under raw/notes/{stem}/. */
export function parentNoteRawPathFromAttachment(rawPath: string): string | null {
	const normalized = rawPath.replace(/^\/+/, "");
	const match = normalized.match(/^raw\/notes\/([^/]+)\/.+$/);
	if (!match) return null;
	return `raw/notes/${match[1]}.md`;
}

export function listNoteAttachments(l2DataDir: string, noteRawPath: string): NoteAttachmentView[] {
	if (!isUserNotePath(noteRawPath)) return [];
	const dirRel = noteAttachmentDirRel(noteRawPath);
	const dirFull = safeL2RawPath(l2DataDir, dirRel);
	if (!dirFull || !existsSync(dirFull) || !statSync(dirFull).isDirectory()) return [];

	const items: NoteAttachmentView[] = [];
	for (const name of readdirSync(dirFull)) {
		const full = join(dirFull, name);
		if (!statSync(full).isFile()) continue;
		const rel = join(dirRel, name).replace(/\\/g, "/");
		const stat = statSync(full);
		items.push({
			rawPath: rel,
			fileName: name,
			size: stat.size,
			updatedAt: stat.mtime.toISOString(),
		});
	}
	return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function uploadNoteAttachment(
	l2DataDir: string,
	noteRawPath: string,
	fileName: string,
	data: Buffer,
): NoteAttachmentView {
	if (!isUserNotePath(noteRawPath)) {
		throw new Error("Invalid note path");
	}
	const noteFull = safeL2RawPath(l2DataDir, noteRawPath.replace(/^\/+/, ""));
	if (!noteFull || !existsSync(noteFull)) {
		throw new Error("Note not found");
	}

	const safeName = basename(fileName).replace(/[^\w.\-()\u4e00-\u9fff ]+/g, "_").slice(0, 120) || "upload";
	const dirRel = noteAttachmentDirRel(noteRawPath);
	const dirFull = join(l2DataDir, dirRel);
	ensureDir(dirFull);
	const outputPath = join(dirFull, safeName);
	writeFileSync(outputPath, data);
	const stat = statSync(outputPath);
	const rel = join(dirRel, safeName).replace(/\\/g, "/");
	return {
		rawPath: rel,
		fileName: safeName,
		size: stat.size,
		updatedAt: stat.mtime.toISOString(),
	};
}

export function removeNoteAttachmentDir(l2DataDir: string, noteRawPath: string): void {
	const dirRel = noteAttachmentDirRel(noteRawPath);
	const dirFull = join(l2DataDir, dirRel);
	if (existsSync(dirFull)) {
		rmSync(dirFull, { recursive: true, force: true });
	}
}
