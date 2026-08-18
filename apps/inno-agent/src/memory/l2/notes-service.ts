import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import { readText, writeText } from "../../storage/file-store.js";
import { resolveContainedPath } from "../../utils/path-safety.js";
import { findManifestByRawPath, readManifest } from "./manifest-store.js";
import { archiveL2Source } from "./l2-archive-service.js";
import type { L2Memory } from "./l2-memory.js";
import {
	extractNoteTitle,
	getTodayRecordDate,
	parseNoteFrontmatter,
	recordDateFromIso,
	serializeNoteFile,
	type NoteFrontmatter,
	type NoteStatus,
} from "./note-frontmatter.js";
import { resolveNoteTemplateContent } from "./note-templates.js";
import {
	archiveRawFile,
	inferNotebookType,
	primaryWikiPath,
	scanOrphans,
	type ArchiveRawResult,
} from "./sources-service.js";
import type { ManifestEntry, ManifestStatus, RawSourceType } from "./types.js";
import { ensureL2Directories } from "./wiki-maintainer.js";
import { logger } from "../../logger.js";
import { listNoteAttachments, type NoteAttachmentRecord } from "./note-attachments-service.js";

export type NotebookItemKind = "markdown" | "orphan" | "archived";
export type NotebookType = "conversation" | "file" | "note";
export type NotebookItemStatus = NoteStatus | ManifestStatus | "uploaded";

export interface NoteSummaryDto {
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
	origin?: ManifestEntry["source"]["origin"];
	extractedPath?: string;
	size?: number;
	createdAt: string;
	updatedAt: string;
}

export interface NoteContentDto {
	rawPath: string;
	noteId: string;
	title: string;
	tags: string[];
	recordDate: string;
	status: NoteStatus;
	sourceId?: string;
	content: string;
	attachments: NoteAttachmentRecord[];
	createdAt: string;
	updatedAt: string;
}

export interface NotesListResponse {
	notes: NoteSummaryDto[];
}

interface ArchiveNotebookOptions {
	title?: string;
	tags?: string[];
	model?: Model<any>;
	modelRegistry?: ModelRegistry;
	memory?: L2Memory;
}

function noteFileName(title: string, noteId: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 40);
	return `${slug || "note"}-${noteId.slice(-8)}.md`;
}

function readNoteFile(l2DataDir: string, rawPath: string): { absPath: string; frontmatter: NoteFrontmatter; body: string } {
	const normalizedPath = rawPath.replace(/\\/g, "/");
	const noteRelativePath = normalizedPath.slice("raw/notes/".length);
	if (
		!normalizedPath.startsWith("raw/notes/")
		|| noteRelativePath.includes("/")
		|| !noteRelativePath.toLowerCase().endsWith(".md")
	) {
		throw new Error("Invalid note path");
	}
	const absPath = resolveContainedPath(join(l2DataDir, "raw", "notes"), noteRelativePath);
	if (!absPath) throw new Error("Invalid note path");
	const content = readText(absPath);
	const { frontmatter, body } = parseNoteFrontmatter(content);
	if (!frontmatter?.note_id) {
		throw new Error("Invalid note file: missing note_id frontmatter");
	}
	return { absPath, frontmatter, body };
}

function noteSummaryFromFile(l2DataDir: string, rawPath: string): NoteSummaryDto | null {
	try {
		const { frontmatter, body } = readNoteFile(l2DataDir, rawPath);
		const manifest = findManifestByRawPath(l2DataDir, rawPath);
		const title = frontmatter.title || extractNoteTitle(body, basename(rawPath, ".md"));
		return {
			noteId: frontmatter.note_id,
			rawPath,
			title,
			tags: frontmatter.tags,
			notebookType: "note",
			contentType: "markdown",
			status: frontmatter.status,
			kind: "markdown",
			wikiPagePath: manifest ? primaryWikiPath(manifest.wikiPages) : undefined,
			wikiPages: manifest?.wikiPages,
			origin: "user_upload",
			createdAt: frontmatter.created || statSync(join(l2DataDir, rawPath)).mtime.toISOString(),
			updatedAt: frontmatter.updated || frontmatter.created || statSync(join(l2DataDir, rawPath)).mtime.toISOString(),
		};
	} catch (err) {
		logger.warn({ err, rawPath }, "failed to read note file");
		return null;
	}
}

function manifestToNoteSummary(entry: ManifestEntry): NoteSummaryDto {
	const rawPath = entry.rawPath.replace(/\\/g, "/");
	return {
		noteId: entry.id,
		rawPath,
		title: entry.title,
		tags: entry.tags,
		notebookType: inferNotebookType(rawPath),
		contentType: entry.sourceType,
		status: entry.status,
		kind: "archived",
		wikiPagePath: primaryWikiPath(entry.wikiPages),
		wikiPages: entry.wikiPages,
		origin: entry.source.origin,
		extractedPath: entry.extractedPath,
		createdAt: entry.createdAt,
		updatedAt: entry.updatedAt,
	};
}

function orphanToNoteSummary(orphan: ReturnType<typeof scanOrphans>[number]): NoteSummaryDto {
	return {
		noteId: `orphan_${createHash("sha256").update(orphan.rawPath).digest("hex").slice(0, 8)}`,
		rawPath: orphan.rawPath,
		title: orphan.fileName,
		tags: [],
		notebookType: "file",
		contentType: orphan.sourceType,
		status: "uploaded",
		kind: "orphan",
		size: orphan.size,
		origin: "user_upload",
		createdAt: orphan.modifiedAt,
		updatedAt: orphan.modifiedAt,
	};
}

export function listL2Notes(
	l2DataDir: string,
	options: {
		notebookType?: NotebookType;
		status?: string;
	} = {},
): NotesListResponse {
	ensureL2Directories(l2DataDir);
	const entries = readManifest(l2DataDir);
	const indexedRawPaths = new Set(entries.map((e) => e.rawPath.replace(/\\/g, "/")));
	const notes: NoteSummaryDto[] = [];

	for (const entry of entries) {
		const summary = manifestToNoteSummary(entry);
		if (summary.notebookType === "note") continue;
		if (options.notebookType && summary.notebookType !== options.notebookType) continue;
		if (options.status && summary.status !== options.status) continue;
		notes.push(summary);
	}

	const notesDir = join(l2DataDir, "raw", "notes");
	if (existsSync(notesDir)) {
		for (const name of readdirSync(notesDir)) {
			if (!name.endsWith(".md")) continue;
			const rawPath = join("raw/notes", name).replace(/\\/g, "/");
			const summary = noteSummaryFromFile(l2DataDir, rawPath);
			if (!summary) continue;
			if (options.notebookType && summary.notebookType !== options.notebookType) continue;
			if (options.status && summary.status !== options.status) continue;
			notes.push(summary);
		}
	}

	for (const orphan of scanOrphans(l2DataDir, indexedRawPaths)) {
		const summary = orphanToNoteSummary(orphan);
		if (options.notebookType && summary.notebookType !== options.notebookType) continue;
		if (options.status && summary.status !== options.status) continue;
		notes.push(summary);
	}

	notes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	return { notes };
}

export function archiveL2NotebookItem(
	l2DataDir: string,
	rawPath: string,
	options: ArchiveNotebookOptions,
): Promise<ArchiveRawResult> {
	const normalizedPath = rawPath.replace(/\\/g, "/");
	if (normalizedPath.startsWith("raw/notes/")) {
		return archiveL2Note(l2DataDir, normalizedPath, options);
	}
	return archiveRawFile(l2DataDir, normalizedPath, options);
}

export function readNoteContent(l2DataDir: string, rawPath: string): NoteContentDto {
	const normalizedPath = rawPath.replace(/\\/g, "/");
	if (!normalizedPath.startsWith("raw/notes/")) {
		throw new Error("Invalid note path");
	}
	const { frontmatter, body } = readNoteFile(l2DataDir, normalizedPath);
	const title = frontmatter.title || extractNoteTitle(body, basename(normalizedPath, ".md"));
	return {
		rawPath: normalizedPath,
		noteId: frontmatter.note_id,
		title,
		tags: frontmatter.tags,
		recordDate: frontmatter.record_date,
		status: frontmatter.status,
		sourceId: frontmatter.source_id,
		content: body,
		attachments: listNoteAttachments(l2DataDir, normalizedPath),
		createdAt: frontmatter.created,
		updatedAt: frontmatter.updated,
	};
}

export function createL2Note(
	l2DataDir: string,
	codeDir: string,
	options: {
		title?: string;
		templateId?: string;
		tags?: string[];
		content?: string;
	},
): { rawPath: string; status: NoteStatus; noteId: string; title: string } {
	ensureL2Directories(l2DataDir);
	const { title, tags, body } = resolveNoteTemplateContent(codeDir, options);
	const noteId = `note_${randomUUID().slice(0, 8)}`;
	const now = new Date().toISOString();
	const fileName = noteFileName(title, noteId);
	const rawPath = join("raw/notes", fileName).replace(/\\/g, "/");
	const frontmatter: NoteFrontmatter = {
		note_id: noteId,
		title,
		tags,
		record_date: getTodayRecordDate(),
		status: "draft",
		created: now,
		updated: now,
	};
	writeText(join(l2DataDir, rawPath), serializeNoteFile(frontmatter, body));
	return { rawPath, status: "draft", noteId, title };
}

export function saveL2NoteContent(
	l2DataDir: string,
	rawPath: string,
	options: { title: string; tags?: string[]; recordDate?: string; content: string },
): { rawPath: string; status: NoteStatus } {
	const normalizedPath = rawPath.replace(/\\/g, "/");
	const { absPath, frontmatter, body: _oldBody } = readNoteFile(l2DataDir, normalizedPath);
	const wasIndexed = frontmatter.status === "indexed" || Boolean(frontmatter.source_id);
	const nextStatus: NoteStatus = wasIndexed ? "outdated" : "draft";
	const now = new Date().toISOString();
	const nextFrontmatter: NoteFrontmatter = {
		...frontmatter,
		title: options.title.trim() || frontmatter.title,
		tags: options.tags ?? frontmatter.tags,
		record_date: options.recordDate?.trim() || frontmatter.record_date || recordDateFromIso(frontmatter.created),
		status: nextStatus,
		updated: now,
	};
	writeText(absPath, serializeNoteFile(nextFrontmatter, options.content));
	return { rawPath: normalizedPath, status: nextStatus };
}

export async function archiveL2Note(
	l2DataDir: string,
	rawPath: string,
	options: ArchiveNotebookOptions,
): Promise<ArchiveRawResult> {
	ensureL2Directories(l2DataDir);
	const normalizedPath = rawPath.replace(/\\/g, "/");
	const snapshot = readNoteFile(l2DataDir, normalizedPath);
	const archivedContent = snapshot.body.trim();
	if (!archivedContent) throw new Error("笔记内容为空，无法归档");

	const title = options.title?.trim()
		|| snapshot.frontmatter.title
		|| extractNoteTitle(snapshot.body, basename(normalizedPath, ".md"));
	const tags = options.tags ?? snapshot.frontmatter.tags;

	return archiveL2Source(
		l2DataDir,
		{
			title,
			source: {
				kind: "existing",
				rawPath: normalizedPath,
				sourceType: "markdown",
				content: archivedContent,
			},
			tags,
			origin: "user_upload",
			dedupeBy: "rawPath",
			createExtracted: false,
			plainSummaryFallback: true,
			preferredId: snapshot.frontmatter.source_id,
			createdAt: snapshot.frontmatter.created,
			force: snapshot.frontmatter.status === "outdated",
			logLabel: "notebook notes API",
			onIndexed: (result) => {
				const current = readNoteFile(l2DataDir, normalizedPath);
				const currentHash = createHash("sha256").update(current.body.trim()).digest("hex").slice(0, 16);
				const sameTags = current.frontmatter.tags.length === tags.length
					&& current.frontmatter.tags.every((tag, index) => tag === tags[index]);
				const unchanged = currentHash === result.contentHash
					&& current.frontmatter.title === title
					&& sameTags;
				const nextFrontmatter: NoteFrontmatter = {
					...current.frontmatter,
					status: unchanged ? "indexed" : "outdated",
					source_id: result.sourceId,
					updated: new Date().toISOString(),
				};
				writeText(current.absPath, serializeNoteFile(nextFrontmatter, current.body));
			},
		},
		{ model: options.model, modelRegistry: options.modelRegistry, memory: options.memory },
	);
}
