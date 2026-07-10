import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import { readText, writeText } from "../../storage/file-store.js";
import {
	findManifestByRawPath,
	readManifest,
	appendManifest,
	removeManifestEntry,
	removeWikiPathFromManifest,
	updateManifestEntry,
} from "./manifest-store.js";
import {
	extractNoteTitle,
	getTodayRecordDate,
	parseNoteFrontmatter,
	recordDateFromIso,
	serializeNoteFile,
	type NoteFrontmatter,
	type NoteStatus,
	type MeetingStatus,
} from "./note-frontmatter.js";
import { resolveNoteTemplateContent } from "./note-templates.js";
import {
	archiveRawFile,
	inferNotebookType,
	primaryWikiPath,
	scanOrphans,
	type ArchiveRawResult,
} from "./sources-service.js";
import type { ManifestEntry, ManifestStatus, RawSourceType, SelectedScope } from "./types.js";
import {
	appendLog,
	createSourcePage,
	ensureL2Directories,
	parseFrontmatter,
	readMaintenanceContext,
	rebuildIndex,
	serializeFrontmatter,
} from "./wiki-maintainer.js";
import { summarizeContent } from "./summarizer.js";
import { maintainLinkedWikiPages, readSourceKnowledgeRelations } from "./wiki-linker.js";
import { logger } from "../../logger.js";
import {
	deleteAttachmentsForNote,
	listNoteAttachments,
	type NoteAttachmentRecord,
} from "./note-attachments-service.js";

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
	meetingId?: string;
	meetingStatus?: MeetingStatus;
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
	meetingId?: string;
	meetingStatus?: MeetingStatus;
}

export interface NotesListResponse {
	notes: NoteSummaryDto[];
}

function noteFileName(title: string, noteId: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 40);
	return `${slug || "note"}-${noteId.slice(-8)}.md`;
}

function sanitizeUploadName(name: string): string {
	const cleaned = name
		.replace(/[/\\?%*:|"<>]/g, "-")
		.replace(/\s+/g, " ")
		.trim();
	return cleaned || "upload";
}

function uploadExtension(fileName: string, mimeType: string): string {
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

function uniqueUploadName(dir: string, fileName: string, mimeType: string): string {
	const safeName = sanitizeUploadName(fileName);
	const ext = uploadExtension(safeName, mimeType);
	const base = basename(safeName, ext).slice(0, 120) || "upload";
	let candidate = `${base}${ext}`;
	let index = 1;
	while (existsSync(join(dir, candidate))) {
		index += 1;
		candidate = `${base} (${index})${ext}`;
	}
	return candidate;
}

function readNoteFile(l2DataDir: string, rawPath: string): { absPath: string; frontmatter: NoteFrontmatter; body: string } {
	const absPath = join(l2DataDir, rawPath);
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
		if (manifest?.status === "indexed") {
			return null;
		}
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
			meetingId: frontmatter.meeting_id,
			meetingStatus: frontmatter.meeting_status,
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
		if (options.notebookType && summary.notebookType !== options.notebookType) continue;
		if (options.status && summary.status !== options.status) continue;
		notes.push(summary);
	}

	const notesDir = join(l2DataDir, "raw", "notes");
	if (existsSync(notesDir)) {
		for (const name of readdirSync(notesDir)) {
			if (!name.endsWith(".md")) continue;
			const rawPath = join("raw/notes", name).replace(/\\/g, "/");
			if (indexedRawPaths.has(rawPath)) continue;
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

export function uploadL2NoteFile(
	l2DataDir: string,
	options: { fileName: string; mimeType: string; dataBase64: string },
): {
	fileName: string;
	mimeType: string;
	size: number;
	rawPath: string;
	notebookType: "file";
	status: "uploaded";
} {
	ensureL2Directories(l2DataDir);
	const dir = join(l2DataDir, "raw", "uploads");
	mkdirSync(dir, { recursive: true });
	const outputName = uniqueUploadName(dir, options.fileName, options.mimeType);
	const outputPath = join(dir, outputName);
	const data = Buffer.from(options.dataBase64, "base64");
	writeFileSync(outputPath, data);
	const rawPath = join("raw", "uploads", outputName).replace(/\\/g, "/");
	return {
		fileName: options.fileName,
		mimeType: options.mimeType,
		size: data.length,
		rawPath,
		notebookType: "file",
		status: "uploaded",
	};
}

export async function archiveL2NotebookItem(
	l2DataDir: string,
	rawPath: string,
	options: {
		title?: string;
		tags?: string[];
		selectedScope?: SelectedScope;
		model?: Model<any>;
		modelRegistry?: ModelRegistry;
	},
): Promise<ArchiveRawResult> {
	const normalizedPath = rawPath.replace(/\\/g, "/");
	if (normalizedPath.startsWith("raw/notes/")) {
		return archiveL2Note(l2DataDir, normalizedPath, options);
	}
	const existing = findManifestByRawPath(l2DataDir, normalizedPath);
	if (existing?.status === "outdated") {
		unarchiveL2NotebookItem(l2DataDir, normalizedPath);
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
		meetingId: frontmatter.meeting_id,
		meetingStatus: frontmatter.meeting_status,
	};
}

export function saveL2MeetingDraft(
	l2DataDir: string,
	rawPath: string,
	options: { meetingId: string; meetingStatus: MeetingStatus; content: string; title?: string; tags?: string[] },
): { rawPath: string; status: NoteStatus; meetingStatus: MeetingStatus } {
	const normalizedPath = rawPath.replace(/\\/g, "/");
	const { absPath, frontmatter } = readNoteFile(l2DataDir, normalizedPath);
	const nextFrontmatter: NoteFrontmatter = {
		...frontmatter,
		title: options.title?.trim() || frontmatter.title,
		tags: options.tags ?? frontmatter.tags,
		status: "draft",
		meeting_id: options.meetingId,
		meeting_status: options.meetingStatus,
		updated: new Date().toISOString(),
	};
	writeText(absPath, serializeNoteFile(nextFrontmatter, options.content));
	return { rawPath: normalizedPath, status: "draft", meetingStatus: options.meetingStatus };
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
	options: {
		tags?: string[];
		model?: Model<any>;
		modelRegistry?: ModelRegistry;
	},
): Promise<ArchiveRawResult> {
	ensureL2Directories(l2DataDir);
	const normalizedPath = rawPath.replace(/\\/g, "/");
	if (!normalizedPath.startsWith("raw/notes/")) {
		throw new Error("Invalid note path");
	}

	const existing = findManifestByRawPath(l2DataDir, normalizedPath);
	if (existing?.status === "indexed") {
		const wikiPagePath = primaryWikiPath(existing.wikiPages) ?? existing.wikiPages[0] ?? "";
		return {
			noteId: existing.id,
			sourceId: existing.id,
			title: existing.title,
			rawPath: normalizedPath,
			wikiPagePath,
			wikiPages: existing.wikiPages,
			status: "indexed",
		};
	}

	const { absPath, frontmatter, body } = readNoteFile(l2DataDir, normalizedPath);
	const title = frontmatter.title || extractNoteTitle(body, basename(normalizedPath, ".md"));
	const tags = options.tags ?? frontmatter.tags;
	const content = body.trim();
	if (!content) {
		throw new Error("笔记内容为空，无法归档");
	}

	const contentHash = createHash("sha256").update(content).digest("hex").slice(0, 16);
	const id = frontmatter.source_id ?? `l2src_${randomUUID().slice(0, 8)}`;
	const maintenanceContext = readMaintenanceContext(l2DataDir);

	const entry: ManifestEntry = {
		id,
		title,
		sourceType: "markdown",
		rawPath: normalizedPath,
		wikiPages: [],
		tags,
		contentHash,
		status: "extracted",
		source: { origin: "user_upload" },
		createdAt: frontmatter.created || new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};

	let summaryBody = content;
	if (!existing && options.model && options.modelRegistry) {
		const summary = await summarizeContent(options.model, options.modelRegistry, title, content);
		if (summary) summaryBody = summary;
	}

	const existingSourcePagePath = existing?.primary_wiki_path ?? primaryWikiPath(existing?.wikiPages ?? []);
	const existingLinkedPages = (existing?.wikiPages ?? []).filter((page) => !page.includes("wiki/sources/"));
	const wikiPagePath = existing
		? existingSourcePagePath ?? ""
		: createSourcePage(l2DataDir, entry, summaryBody, undefined, existingSourcePagePath);
	const graphReferencePath = wikiPagePath || normalizedPath;
	const currentRelations = readSourceKnowledgeRelations(l2DataDir, existing?.wikiPages ?? []);
	const linkMaintenance = await maintainLinkedWikiPages(
		l2DataDir,
		entry,
		graphReferencePath,
		existing ? content : summaryBody,
		options.model,
		options.modelRegistry,
		existing ? { currentRelations } : undefined,
	);
	const linkedPages = existing
		? [...new Set([...existingLinkedPages, ...linkMaintenance.pages])]
		: linkMaintenance.pages;
	entry.wikiPages = wikiPagePath ? [wikiPagePath, ...linkedPages] : linkedPages;
	entry.primary_wiki_path = wikiPagePath || existing?.primary_wiki_path;
	entry.status = "indexed";
	entry.updatedAt = new Date().toISOString();

	if (existing) {
		updateManifestEntry(l2DataDir, existing.id, () => entry);
	} else {
		appendManifest(l2DataDir, entry);
	}
	rebuildIndex(l2DataDir, readManifest(l2DataDir));

	const now = new Date().toISOString();
	const nextFrontmatter: NoteFrontmatter = {
		...frontmatter,
		title,
		tags,
		status: "indexed",
		source_id: id,
		updated: now,
	};
	writeText(absPath, serializeNoteFile(nextFrontmatter, body));

	appendLog(
		l2DataDir,
		"ingest",
		title,
		[
			`- ID: ${id}`,
			`- 类型: markdown (note)`,
			`- 原始文件: ${normalizedPath}`,
			`- Source 页面: ${wikiPagePath}`,
			`- UI archive from Notes panel`,
			`- 维护前上下文: schema ${maintenanceContext.schema.length} chars`,
		].join("\n"),
	);

	return {
		noteId: id,
		sourceId: id,
		title,
		rawPath: normalizedPath,
		wikiPagePath,
		wikiPages: entry.wikiPages,
		status: "indexed",
	};
}

export interface DeleteNotebookItemResult {
	rawPath: string;
	title: string;
}

export interface SaveRawMarkdownResult {
	rawPath: string;
	status: ManifestStatus | "uploaded";
}

export function saveL2RawMarkdownContent(
	l2DataDir: string,
	rawPath: string,
	content: string,
): SaveRawMarkdownResult {
	ensureL2Directories(l2DataDir);
	const normalizedPath = rawPath.replace(/\\/g, "/");
	if (!normalizedPath.startsWith("raw/") || normalizedPath.startsWith("raw/notes/")) {
		throw new Error("Invalid raw path");
	}
	const ext = extname(normalizedPath).toLowerCase();
	if (ext !== ".md") {
		throw new Error("Only Markdown raw files can be edited");
	}
	const absPath = join(l2DataDir, normalizedPath);
	if (!existsSync(absPath)) {
		throw new Error("文件不存在");
	}

	const nextContent = content.endsWith("\n") ? content : `${content}\n`;
	writeText(absPath, nextContent);

	const entry = findManifestByRawPath(l2DataDir, normalizedPath);
	if (!entry) {
		return { rawPath: normalizedPath, status: "uploaded" };
	}

	const contentHash = createHash("sha256").update(nextContent).digest("hex").slice(0, 16);
	updateManifestEntry(l2DataDir, entry.id, (current) => ({
		...current,
		contentHash,
		status: "outdated",
		updatedAt: new Date().toISOString(),
	}));
	appendLog(
		l2DataDir,
		"edit-raw",
		entry.title,
		[
			`- ID: ${entry.id}`,
			`- 原始文件: ${normalizedPath}`,
			`- 状态: outdated`,
			`- UI edit raw Markdown from Notes panel`,
		].join("\n"),
	);
	return { rawPath: normalizedPath, status: "outdated" };
}

/**
 * Permanently delete a notebook item.
 *
 * If the item has already been archived, first undo the archive so generated
 * wiki pages, concept/entity source references, manifest rows, and indexes are
 * cleaned up before the raw file is removed.
 */
export function deleteL2NotebookItem(l2DataDir: string, rawPath: string): DeleteNotebookItemResult {
	const normalizedPath = rawPath.replace(/\\/g, "/");
	if (!normalizedPath.startsWith("raw/")) {
		throw new Error("Invalid raw path");
	}
	const entry = findManifestByRawPath(l2DataDir, normalizedPath);
	let title = entry?.title ?? basename(normalizedPath);
	if (entry) {
		const unarchived = unarchiveL2NotebookItem(l2DataDir, normalizedPath);
		title = unarchived.title || title;
	}
	const absPath = join(l2DataDir, normalizedPath);
	if (!existsSync(absPath)) {
		if (entry) {
			appendLog(
				l2DataDir,
				"delete",
				title,
				[
					`- 原始文件: ${normalizedPath}`,
					`- Raw file was already missing after archive cleanup`,
					`- UI delete from Notes panel`,
				].join("\n"),
			);
			return { rawPath: normalizedPath, title };
		}
		throw new Error("文件不存在");
	}

	if (normalizedPath.startsWith("raw/notes/")) {
		try {
			const { frontmatter, body } = readNoteFile(l2DataDir, normalizedPath);
			title = frontmatter.title || extractNoteTitle(body, title);
		} catch (err) {
			logger.warn({ err, rawPath: normalizedPath }, "failed to read note before delete");
		}
		deleteAttachmentsForNote(l2DataDir, normalizedPath);
	}

	unlinkSync(absPath);
	appendLog(
		l2DataDir,
		"delete",
		title,
		[`- 原始文件: ${normalizedPath}`, `- UI delete from Notes panel`].join("\n"),
	);
	return { rawPath: normalizedPath, title };
}

export interface UnarchiveResult {
	rawPath: string;
	title: string;
	removedWikiPages: string[];
	status: "draft" | "uploaded";
}

/**
 * Remove a source's reference (source_id + source paths) from a linked wiki
 * page. If the page was extracted solely from this source (its `source_ids`
 * becomes empty), the whole page is deleted — the knowledge point came from
 * nowhere else, so unarchiving must take it back too. Pages that aggregate
 * other sources are kept with just this reference detached.
 */
function detachSourceFromWikiPage(
	l2DataDir: string,
	wikiPath: string,
	sourceId: string,
	rawPath: string,
	sourcePagePath: string | undefined,
): "deleted" | "kept" | "unchanged" {
	const absPath = join(l2DataDir, wikiPath);
	if (!existsSync(absPath)) return "unchanged";
	try {
		const { frontmatter, body } = parseFrontmatter(readText(absPath));
		if (!frontmatter) return "unchanged";

		const referencesSource = frontmatter.source_ids.includes(sourceId);
		const nextSourceIds = frontmatter.source_ids.filter((id) => id !== sourceId);
		if (referencesSource && nextSourceIds.length === 0) {
			unlinkSync(absPath);
			return "deleted";
		}

		const nextSources = frontmatter.sources.filter((s) => s !== rawPath && s !== sourcePagePath);
		let nextBody = body;
		if (sourcePagePath) {
			nextBody = body
				.split("\n")
				.filter((line) => !(line.trim().startsWith("-") && line.includes(sourcePagePath)))
				.join("\n");
		}
		if (
			!referencesSource &&
			nextSources.length === frontmatter.sources.length &&
			nextBody === body
		) {
			return "unchanged";
		}
		frontmatter.source_ids = nextSourceIds;
		frontmatter.sources = nextSources;
		frontmatter.updated = new Date().toISOString().slice(0, 10);
		writeText(absPath, `${serializeFrontmatter(frontmatter)}\n${nextBody.replace(/^\n/, "")}`);
		return "kept";
	} catch (err) {
		logger.warn({ err, wikiPath }, "failed to detach source from wiki page");
		return "unchanged";
	}
}

function wikiPathExists(l2DataDir: string, wikiPath: string): boolean {
	const normalized = wikiPath.replace(/\\/g, "/");
	return existsSync(join(l2DataDir, normalized));
}

function pruneOrphanDerivedWikiPages(l2DataDir: string): string[] {
	const removed: string[] = [];
	let changed = true;
	const dirs = ["wiki/concepts", "wiki/entities", "wiki/analysis"];
	while (changed) {
		changed = false;
		for (const dir of dirs) {
			const absDir = join(l2DataDir, dir);
			if (!existsSync(absDir)) continue;
			for (const file of readdirSync(absDir)) {
				if (!file.endsWith(".md")) continue;
				const wikiPath = join(dir, file).replace(/\\/g, "/");
				const absPath = join(l2DataDir, wikiPath);
				if (!existsSync(absPath)) continue;
				try {
					const { frontmatter } = parseFrontmatter(readText(absPath));
					if (!frontmatter) continue;
					if (frontmatter.source_ids.length > 0 || frontmatter.sources.length === 0) continue;
					const hasLiveSource = frontmatter.sources.some((sourcePath) => wikiPathExists(l2DataDir, sourcePath));
					if (hasLiveSource) continue;
					unlinkSync(absPath);
					removed.push(wikiPath);
					removeWikiPathFromManifest(l2DataDir, wikiPath);
					changed = true;
				} catch (err) {
					logger.warn({ err, wikiPath }, "failed to prune orphan derived wiki page");
				}
			}
		}
	}
	return removed;
}

/**
 * Undo an archive: remove the manifest entry, delete the generated source
 * wiki page, detach the source from linked wiki pages, and revert a note's
 * frontmatter back to draft. Uploaded files simply become orphans again.
 */
export function unarchiveL2NotebookItem(l2DataDir: string, rawPath: string): UnarchiveResult {
	ensureL2Directories(l2DataDir);
	const normalizedPath = rawPath.replace(/\\/g, "/");
	const isNote = normalizedPath.startsWith("raw/notes/");
	const entry = findManifestByRawPath(l2DataDir, normalizedPath);
	if (!entry) {
		throw new Error("该内容未归档，无法撤回");
	}

	const removedWikiPages: string[] = [];
	const sourcePage = primaryWikiPath(entry.wikiPages);
	for (const wikiPath of entry.wikiPages) {
		if (wikiPath === sourcePage && wikiPath.includes("wiki/sources/")) {
			const absPath = join(l2DataDir, wikiPath);
			if (existsSync(absPath)) {
				unlinkSync(absPath);
				removedWikiPages.push(wikiPath);
			}
		} else {
			const outcome = detachSourceFromWikiPage(l2DataDir, wikiPath, entry.id, normalizedPath, sourcePage);
			if (outcome === "deleted") removedWikiPages.push(wikiPath);
		}
	}

	if (entry.extractedPath) {
		const absExtracted = join(l2DataDir, entry.extractedPath);
		if (existsSync(absExtracted)) {
			try {
				unlinkSync(absExtracted);
			} catch (err) {
				logger.warn({ err, extractedPath: entry.extractedPath }, "failed to remove extracted file");
			}
		}
	}

	removeManifestEntry(l2DataDir, entry.id);
	// Deleted pages may still be listed in other manifest entries' wikiPages
	// (defensive: keeps the graph/manifest consistent).
	for (const wikiPath of removedWikiPages) {
		removeWikiPathFromManifest(l2DataDir, wikiPath);
	}
	const prunedWikiPages = pruneOrphanDerivedWikiPages(l2DataDir);
	removedWikiPages.push(...prunedWikiPages);
	rebuildIndex(l2DataDir, readManifest(l2DataDir));

	let status: UnarchiveResult["status"] = "uploaded";
	if (isNote) {
		try {
			const { absPath, frontmatter, body } = readNoteFile(l2DataDir, normalizedPath);
			const nextFrontmatter: NoteFrontmatter = {
				...frontmatter,
				status: "draft",
				source_id: undefined,
				updated: new Date().toISOString(),
			};
			writeText(absPath, serializeNoteFile(nextFrontmatter, body));
			status = "draft";
		} catch (err) {
			logger.warn({ err, rawPath: normalizedPath }, "failed to revert note frontmatter after unarchive");
		}
	}

	appendLog(
		l2DataDir,
		"unarchive",
		entry.title,
		[
			`- ID: ${entry.id}`,
			`- 原始文件: ${normalizedPath}`,
			`- 删除的 Wiki 页面: ${removedWikiPages.join(", ") || "(无)"}`,
			`- UI unarchive from Notes panel`,
		].join("\n"),
	);

	return {
		rawPath: normalizedPath,
		title: entry.title,
		removedWikiPages,
		status,
	};
}
