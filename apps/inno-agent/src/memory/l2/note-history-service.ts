import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { readJson, writeJson } from "../../storage/file-store.js";
import type { NoteVersionDto, NoteVersionReason, NoteVersionSummaryDto } from "./types.js";

const AUTOSAVE_MERGE_WINDOW_MS = 5 * 60 * 1000;
const MAX_VERSIONS_PER_NOTE = 100;

function safeNoteId(noteId: string): string {
	const normalized = noteId.replace(/[^a-zA-Z0-9_-]/g, "_");
	if (!normalized) throw new Error("Invalid note id");
	return normalized;
}

function historyDir(l2DataDir: string, noteId: string): string {
	return join(l2DataDir, "note-history", safeNoteId(noteId));
}

function indexPath(l2DataDir: string, noteId: string): string {
	return join(historyDir(l2DataDir, noteId), "index.json");
}

function versionPath(l2DataDir: string, noteId: string, versionId: string): string {
	return join(historyDir(l2DataDir, noteId), `${versionId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
}

function contentHash(title: string, tags: string[], recordDate: string, content: string): string {
	return createHash("sha256")
		.update(JSON.stringify({ title, tags, recordDate, content }))
		.digest("hex")
		.slice(0, 24);
}

export function listNoteVersions(l2DataDir: string, noteId: string): NoteVersionSummaryDto[] {
	return readJson<NoteVersionSummaryDto[]>(indexPath(l2DataDir, noteId), []);
}

export function readNoteVersion(l2DataDir: string, noteId: string, versionId: string): NoteVersionDto {
	const snapshot = readJson<NoteVersionDto | null>(versionPath(l2DataDir, noteId, versionId), null);
	if (!snapshot || snapshot.noteId !== noteId || snapshot.versionId !== versionId) {
		throw new Error("Version not found");
	}
	return snapshot;
}

export function recordNoteVersion(
	l2DataDir: string,
	input: {
		noteId: string;
		title: string;
		tags: string[];
		recordDate: string;
		content: string;
		reason: NoteVersionReason;
	},
): NoteVersionSummaryDto {
	const now = new Date().toISOString();
	const hash = contentHash(input.title, input.tags, input.recordDate, input.content);
	const versions = listNoteVersions(l2DataDir, input.noteId);
	const latest = versions[0];
	if (latest) {
		const latestSnapshot = readJson<NoteVersionDto | null>(
			versionPath(l2DataDir, input.noteId, latest.versionId),
			null,
		);
		if (latestSnapshot?.contentHash === hash) return latest;
	}

	const mergeAutosave = input.reason === "autosave" && latest?.reason === "autosave" &&
		Date.now() - Date.parse(latest.createdAt) < AUTOSAVE_MERGE_WINDOW_MS;
	const versionId = mergeAutosave ? latest.versionId : `ver_${randomUUID().slice(0, 12)}`;
	const snapshot: NoteVersionDto = {
		versionId,
		noteId: input.noteId,
		createdAt: now,
		reason: input.reason,
		title: input.title,
		tags: [...input.tags],
		recordDate: input.recordDate,
		content: input.content,
		contentLength: input.content.length,
		contentHash: hash,
	};
	const summary: NoteVersionSummaryDto = {
		versionId,
		noteId: input.noteId,
		createdAt: now,
		reason: input.reason,
		title: input.title,
		contentLength: input.content.length,
	};

	mkdirSync(historyDir(l2DataDir, input.noteId), { recursive: true });
	writeJson(versionPath(l2DataDir, input.noteId, versionId), snapshot);
	const next = mergeAutosave ? [summary, ...versions.slice(1)] : [summary, ...versions];
	const kept = next.slice(0, MAX_VERSIONS_PER_NOTE);
	for (const removed of next.slice(MAX_VERSIONS_PER_NOTE)) {
		const path = versionPath(l2DataDir, input.noteId, removed.versionId);
		if (existsSync(path)) unlinkSync(path);
	}
	writeJson(indexPath(l2DataDir, input.noteId), kept);
	return summary;
}

export function deleteNoteHistory(l2DataDir: string, noteId: string): void {
	const dir = historyDir(l2DataDir, noteId);
	if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}
