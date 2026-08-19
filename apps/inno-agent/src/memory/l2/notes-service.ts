import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
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
	type MeetingStatus,
	type ConversationCaptureMode,
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
import {
	deleteAttachmentsForNote,
	listNoteAttachments,
	updateNoteAttachmentStatus,
	type NoteAttachmentRecord,
} from "./note-attachments-service.js";
import {
	deleteNoteHistory,
	listNoteVersions,
	readNoteVersion,
	recordNoteVersion,
	type NoteVersionDto,
	type NoteVersionReason,
	type NoteVersionSummaryDto,
} from "./note-history-service.js";
import { isSupportedFormat, parseDocument } from "./document-parser.js";

const TEXT_ATTACHMENT_EXTENSIONS = new Set([
	".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".jsonl", ".xml", ".yaml", ".yml",
	".html", ".css", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".java", ".go",
	".rs", ".sql", ".sh", ".log",
]);
const IMAGE_REFERENCE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".tiff", ".tif"]);

interface MarkdownImageReference {
	alt: string;
	target: string;
}

function markdownImageReferences(markdown: string): MarkdownImageReference[] {
	const references: MarkdownImageReference[] = [];
	const inlineImage = /!\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/g;
	for (const match of markdown.matchAll(inlineImage)) {
		const target = (match[2] || match[3] || "").trim();
		if (target) references.push({ alt: match[1].trim(), target });
	}
	const htmlImage = /<img\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1[^>]*>/gi;
	for (const match of markdown.matchAll(htmlImage)) {
		const target = match[2].trim();
		if (target) references.push({ alt: "", target });
	}
	return references;
}

function resolveLocalNoteImage(
	l2DataDir: string,
	notePath: string,
	reference: MarkdownImageReference,
): { path: string; source: string; alt: string } | null {
	const rawTarget = reference.target.trim();
	if (/^(?:https?:|data:|blob:|mailto:)/i.test(rawTarget) || rawTarget.startsWith("#")) return null;

	let decodedTarget: string;
	try {
		decodedTarget = decodeURIComponent(rawTarget);
	} catch {
		decodedTarget = rawTarget;
	}

	let candidate: string | null;
	if (decodedTarget.startsWith("/api/l2/raw/file?")) {
		const rawPath = new URL(decodedTarget, "http://localhost").searchParams.get("path");
		candidate = rawPath ? resolveContainedPath(l2DataDir, rawPath) : null;
	} else {
		const cleanTarget = decodedTarget.split(/[?#]/, 1)[0].replace(/\\/g, "/");
		if (!cleanTarget) return null;
		const lexical = cleanTarget.startsWith("raw/")
			? resolve(l2DataDir, cleanTarget)
			: resolve(dirname(notePath), cleanTarget);
		candidate = resolveContainedPath(l2DataDir, relative(l2DataDir, lexical));
	}

	if (!candidate || !IMAGE_REFERENCE_EXTENSIONS.has(extname(candidate).toLowerCase())) return null;
	if (!existsSync(candidate) || !statSync(candidate).isFile()) {
		throw new Error(`笔记引用图片不存在: ${reference.target}`);
	}
	return { path: candidate, source: reference.target, alt: reference.alt };
}

function isTextAttachment(attachment: NoteAttachmentRecord): boolean {
	return attachment.mimeType.startsWith("text/")
		|| ["application/json", "application/xml", "application/javascript", "application/x-yaml"].includes(attachment.mimeType)
		|| TEXT_ATTACHMENT_EXTENSIONS.has(extname(attachment.fileName).toLowerCase());
}

function attachmentSignature(attachments: NoteAttachmentRecord[]): string {
	return attachments
		.map((attachment) => `${attachment.id}:${attachment.filePath}:${attachment.size}`)
		.sort()
		.join("|");
}

async function prepareNoteArchiveContent(
	l2DataDir: string,
	notePath: string,
	body: string,
	attachments: NoteAttachmentRecord[],
): Promise<string> {
	const attachmentSections: string[] = [];
	const processedImagePaths = new Set<string>();
	for (const attachment of attachments) {
		updateNoteAttachmentStatus(l2DataDir, attachment.id, "extracting");
		try {
			const attachmentPath = resolveContainedPath(l2DataDir, attachment.filePath);
			if (!attachmentPath || !existsSync(attachmentPath) || !statSync(attachmentPath).isFile()) {
				throw new Error("附件文件不存在或路径无效");
			}
			if (IMAGE_REFERENCE_EXTENSIONS.has(extname(attachmentPath).toLowerCase())) {
				processedImagePaths.add(resolve(attachmentPath));
			}
			const extractedContent = isSupportedFormat(attachmentPath)
				? (await parseDocument(attachmentPath)).text.trim()
				: isTextAttachment(attachment)
					? readText(attachmentPath).trim()
					: "";
			if (!extractedContent) throw new Error(`不支持或无法提取附件格式: ${extname(attachment.fileName) || attachment.mimeType}`);
			attachmentSections.push([
				`## 附件：${attachment.fileName}`,
				"",
				`> 来源：[${attachment.fileName}](${attachment.filePath})`,
				"",
				extractedContent,
			].join("\n"));
			updateNoteAttachmentStatus(l2DataDir, attachment.id, "extracted");
		} catch (error) {
			updateNoteAttachmentStatus(l2DataDir, attachment.id, "error");
			throw new Error(`附件“${attachment.fileName}”内容解析失败: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	const referencedImageSections: string[] = [];
	for (const reference of markdownImageReferences(body)) {
		const image = resolveLocalNoteImage(l2DataDir, notePath, reference);
		if (!image || processedImagePaths.has(resolve(image.path))) continue;
		processedImagePaths.add(resolve(image.path));
		try {
			const extractedContent = (await parseDocument(image.path)).text.trim();
			if (!extractedContent) throw new Error("OCR 结果为空");
			referencedImageSections.push([
				`## 引用图片：${image.alt || basename(image.path)}`,
				"",
				`> 来源：${image.source}`,
				"",
				extractedContent,
			].join("\n"));
		} catch (error) {
			throw new Error(`引用图片“${image.alt || image.source}”内容解析失败: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	return [body.trim(), ...attachmentSections, ...referencedImageSections].filter(Boolean).join("\n\n");
}

export type NotebookItemKind = "markdown" | "orphan" | "archived";
export type NotebookType = "conversation" | "file" | "note";
export type NotebookItemStatus = NoteStatus | ManifestStatus | "uploaded";

export interface NoteSummaryDto {
	noteId: string;
	sourceId?: string;
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
	sourceSessionId?: string;
	captureMode?: ConversationCaptureMode;
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
	sourceSessionId?: string;
	captureMode?: ConversationCaptureMode;
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
			sourceId: manifest?.id ?? frontmatter.source_id,
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
			sourceSessionId: frontmatter.source_session_id,
			captureMode: frontmatter.capture_mode,
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
		sourceId: entry.id,
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
		meetingId: frontmatter.meeting_id,
		meetingStatus: frontmatter.meeting_status,
		sourceSessionId: frontmatter.source_session_id,
		captureMode: frontmatter.capture_mode,
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
		sourceSessionId?: string;
		captureMode?: ConversationCaptureMode;
	},
): { rawPath: string; status: NoteStatus; noteId: string; title: string } {
	ensureL2Directories(l2DataDir);
	const { title, tags, body } = resolveNoteTemplateContent(codeDir, l2DataDir, options);
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
		source_session_id: options.sourceSessionId,
		capture_mode: options.captureMode,
		created: now,
		updated: now,
	};
	writeText(join(l2DataDir, rawPath), serializeNoteFile(frontmatter, body));
	recordNoteVersion(l2DataDir, {
		noteId,
		title,
		tags,
		recordDate: frontmatter.record_date,
		content: body,
		reason: "created",
	});
	return { rawPath, status: "draft", noteId, title };
}

export function saveL2NoteContent(
	l2DataDir: string,
	rawPath: string,
	options: {
		title: string;
		tags?: string[];
		recordDate?: string;
		content: string;
		saveReason?: Exclude<NoteVersionReason, "created">;
	},
): { rawPath: string; status: NoteStatus } {
	const normalizedPath = rawPath.replace(/\\/g, "/");
	const { absPath, frontmatter, body: oldBody } = readNoteFile(l2DataDir, normalizedPath);
	if (listNoteVersions(l2DataDir, frontmatter.note_id).length === 0) {
		recordNoteVersion(l2DataDir, {
			noteId: frontmatter.note_id,
			title: frontmatter.title,
			tags: frontmatter.tags,
			recordDate: frontmatter.record_date || recordDateFromIso(frontmatter.created),
			content: oldBody,
			reason: "created",
		});
	}
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
	recordNoteVersion(l2DataDir, {
		noteId: nextFrontmatter.note_id,
		title: nextFrontmatter.title,
		tags: nextFrontmatter.tags,
		recordDate: nextFrontmatter.record_date,
		content: options.content,
		reason: options.saveReason ?? "manual",
	});
	return { rawPath: normalizedPath, status: nextStatus };
}

export function listL2NoteVersions(l2DataDir: string, rawPath: string): NoteVersionSummaryDto[] {
	const { frontmatter } = readNoteFile(l2DataDir, rawPath.replace(/\\/g, "/"));
	return listNoteVersions(l2DataDir, frontmatter.note_id);
}

export function readL2NoteVersion(l2DataDir: string, rawPath: string, versionId: string): NoteVersionDto {
	const { frontmatter } = readNoteFile(l2DataDir, rawPath.replace(/\\/g, "/"));
	return readNoteVersion(l2DataDir, frontmatter.note_id, versionId);
}

export function restoreL2NoteVersion(
	l2DataDir: string,
	rawPath: string,
	versionId: string,
): { rawPath: string; status: NoteStatus; versionId: string } {
	const normalizedPath = rawPath.replace(/\\/g, "/");
	const version = readL2NoteVersion(l2DataDir, normalizedPath, versionId);
	const result = saveL2NoteContent(l2DataDir, normalizedPath, {
		title: version.title,
		tags: version.tags,
		recordDate: version.recordDate,
		content: version.content,
		saveReason: "restore",
	});
	return { ...result, versionId };
}

export async function archiveL2Note(
	l2DataDir: string,
	rawPath: string,
	options: ArchiveNotebookOptions,
): Promise<ArchiveRawResult> {
	ensureL2Directories(l2DataDir);
	const normalizedPath = rawPath.replace(/\\/g, "/");
	const snapshot = readNoteFile(l2DataDir, normalizedPath);
	const attachments = listNoteAttachments(l2DataDir, normalizedPath);
	const archivedContent = await prepareNoteArchiveContent(
		l2DataDir,
		snapshot.absPath,
		snapshot.body,
		attachments,
	);
	if (!archivedContent) throw new Error("笔记内容为空，无法归档");
	const snapshotBodyHash = createHash("sha256").update(snapshot.body.trim()).digest("hex").slice(0, 16);
	const snapshotAttachments = attachmentSignature(attachments);

	const title = options.title?.trim()
		|| snapshot.frontmatter.title
		|| extractNoteTitle(snapshot.body, basename(normalizedPath, ".md"));
	const tags = options.tags ?? snapshot.frontmatter.tags;

	const result = await archiveL2Source(
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
			onIndexed: (archiveResult) => {
				const current = readNoteFile(l2DataDir, normalizedPath);
				const currentHash = createHash("sha256").update(current.body.trim()).digest("hex").slice(0, 16);
				const sameTags = current.frontmatter.tags.length === tags.length
					&& current.frontmatter.tags.every((tag, index) => tag === tags[index]);
				const unchanged = currentHash === snapshotBodyHash
					&& current.frontmatter.title === title
					&& sameTags
					&& attachmentSignature(listNoteAttachments(l2DataDir, normalizedPath)) === snapshotAttachments;
				const nextFrontmatter: NoteFrontmatter = {
					...current.frontmatter,
					status: unchanged ? "indexed" : "outdated",
					source_id: archiveResult.sourceId,
					updated: new Date().toISOString(),
				};
				writeText(current.absPath, serializeNoteFile(nextFrontmatter, current.body));
			},
		},
		{ model: options.model, modelRegistry: options.modelRegistry, memory: options.memory },
	);
	for (const attachment of attachments) updateNoteAttachmentStatus(l2DataDir, attachment.id, "indexed");
	return result;
}

export interface DeleteNotebookItemResult {
	rawPath: string;
	title: string;
}

export function deleteL2NotebookItem(l2DataDir: string, rawPath: string): DeleteNotebookItemResult {
	const normalizedPath = rawPath.replace(/\\/g, "/");
	const isNote = normalizedPath.startsWith("raw/notes/");
	const prefix = isNote
		? "raw/notes/"
		: normalizedPath.startsWith("raw/uploads/")
			? "raw/uploads/"
			: normalizedPath.startsWith("raw/conversations/")
				? "raw/conversations/"
				: "";
	const relativePath = prefix ? normalizedPath.slice(prefix.length) : "";
	if (!prefix || !relativePath || relativePath.includes("/")) throw new Error("Invalid raw path");
	if (isNote && !relativePath.toLowerCase().endsWith(".md")) throw new Error("Invalid note path");
	if (findManifestByRawPath(l2DataDir, normalizedPath)) {
		throw new Error("该内容已归档，不能直接删除");
	}

	const storageRoot = join(l2DataDir, ...prefix.slice(0, -1).split("/"));
	const absPath = resolveContainedPath(storageRoot, relativePath);
	if (!absPath || !existsSync(absPath) || !statSync(absPath).isFile()) throw new Error("文件不存在");

	let title = basename(normalizedPath);
	if (isNote) {
		const note = readNoteFile(l2DataDir, normalizedPath);
		if (note.frontmatter.status !== "draft" || note.frontmatter.source_id) {
			throw new Error("该笔记可能仍被知识库引用，不能直接删除");
		}
		title = note.frontmatter.title || extractNoteTitle(note.body, basename(normalizedPath, ".md"));
		deleteAttachmentsForNote(l2DataDir, normalizedPath);
		deleteNoteHistory(l2DataDir, note.frontmatter.note_id);
	}

	unlinkSync(absPath);
	return { rawPath: normalizedPath, title };
}
