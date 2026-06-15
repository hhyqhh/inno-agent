import { createHash, randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { existsSync, rmSync } from "node:fs";

import { readText } from "../../storage/file-store.js";
import { appendManifest, findManifestByRawPath, readManifest, removeManifestByRawPath, updateManifestEntry } from "./manifest-store.js";
import { convertToExtracted } from "./source-converter.js";
import { createEnrichedSourcePages, type ArchiveModelContext } from "./archive-enricher.js";
import { listNoteAttachments, removeNoteAttachmentDir } from "./note-attachments.js";
import { refreshNoteWithAttachments } from "./note-attachment-ingest.js";
import { logger } from "../../logger.js";
import { getSourceById, type SourceSummaryView } from "./source-resolver.js";
import type { ManifestEntry } from "./types.js";
import {
	appendLog,
	ensureL2Directories,
	rebuildIndex,
} from "./wiki-maintainer.js";

function parseNoteContent(content: string): { title: string; tags: string[]; body: string } {
	const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (!match) {
		return { title: "", tags: [], body: content };
	}
	let title = "";
	const tags: string[] = [];
	for (const line of match[1].split("\n")) {
		const titleMatch = line.match(/^title:\s*(.+)$/i);
		if (titleMatch) title = titleMatch[1].trim();
		const tagsMatch = line.match(/^tags:\s*(.+)$/i);
		if (tagsMatch) {
			tags.push(
				...tagsMatch[1]
					.split(/[,，;；、|/\n]/)
					.map((tag) => tag.trim().replace(/^#+/, ""))
					.filter(Boolean),
			);
		}
	}
	return { title, tags, body: match[2] };
}

function titleFromFileName(fileName: string): string {
	return (
		basename(fileName, ".md")
			.replace(/-\d{4}-\d{2}-\d{2}-[a-f0-9]{6}$/i, "")
			.replace(/-/g, " ")
			.trim() || fileName
	);
}

function summaryBodyFromNote(body: string): string {
	const trimmed = body.trim();
	if (!trimmed) return "## 内容\n\n(空笔记)";
	return trimmed.startsWith("#") ? trimmed : `## 内容\n\n${trimmed}`;
}

export function isUserNotePath(rawPath: string): boolean {
	const normalized = rawPath.replace(/^\/+/, "");
	return normalized.startsWith("raw/notes/") && normalized.toLowerCase().endsWith(".md");
}

export interface NoteAttachmentArchiveResult {
	merged: number;
	skipped: number;
}

/** Extract note attachments and merge into the parent note wiki page. */
export async function archiveNoteAttachments(
	l2DataDir: string,
	noteRawPath: string,
	noteContent: string,
	modelContext?: ArchiveModelContext,
	parentEntry?: ManifestEntry,
): Promise<NoteAttachmentArchiveResult> {
	if (!isUserNotePath(noteRawPath) || !parentEntry) return { merged: 0, skipped: 0 };
	const attachments = listNoteAttachments(l2DataDir, noteRawPath);
	if (attachments.length === 0) return { merged: 0, skipped: 0 };
	try {
		await refreshNoteWithAttachments(l2DataDir, parentEntry, noteContent, modelContext);
		return { merged: attachments.length, skipped: 0 };
	} catch (err) {
		logger.warn({ err, noteRawPath }, "failed to merge note attachments into wiki");
		return { merged: 0, skipped: attachments.length };
	}
}

/** Archive or sync a user note under raw/notes/*.md after save. */
export async function saveUserNote(
	l2DataDir: string,
	rawPath: string,
	content: string,
	modelContext?: ArchiveModelContext,
): Promise<SourceSummaryView> {
	if (!isUserNotePath(rawPath)) {
		throw new Error("Only raw/notes/*.md supports auto-archive");
	}

	ensureL2Directories(l2DataDir);
	const normalized = rawPath.replace(/^\/+/, "");
	const existing = findManifestByRawPath(l2DataDir, normalized);
	if (existing) {
		const refreshed = await refreshNoteWithAttachments(l2DataDir, existing, content, modelContext);
		const source = getSourceById(l2DataDir, refreshed.id);
		if (!source) throw new Error("Archived source not found");
		return source;
	}

	const { title: fmTitle, tags, body } = parseNoteContent(content);
	const fileName = basename(normalized);
	const title = fmTitle || titleFromFileName(fileName);
	const extractedBody = body.trim() || content;
	const contentHash = createHash("sha256").update(extractedBody).digest("hex").slice(0, 16);
	const id = `l2src_${randomUUID().slice(0, 8)}`;
	const extractedPath = convertToExtracted(l2DataDir, title, extractedBody, "markdown");

	const entry: ManifestEntry = {
		id,
		title,
		sourceType: "markdown",
		rawPath: normalized,
		extractedPath,
		wikiPages: [],
		tags,
		contentHash,
		status: "extracted",
		source: { origin: "user_upload" },
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};

	appendManifest(l2DataDir, entry);
	rebuildIndex(l2DataDir, readManifest(l2DataDir));

	if (listNoteAttachments(l2DataDir, normalized).length === 0) {
		const { wikiPagePath, linkMaintenance } = await createEnrichedSourcePages(
			l2DataDir,
			entry,
			title,
			extractedPath,
			summaryBodyFromNote(body),
			modelContext,
		);
		updateManifestEntry(l2DataDir, id, {
			wikiPages: [wikiPagePath, ...linkMaintenance.pages],
			status: "indexed",
		});
		appendLog(
			l2DataDir,
			"ingest",
			title,
			[
				`- User note archived: ${normalized}`,
				`- Source page: ${wikiPagePath}`,
				`- concepts/entities: 新建 ${linkMaintenance.created.length}, 更新 ${linkMaintenance.updated.length}, 不变 ${linkMaintenance.unchanged.length}`,
			].join("\n"),
		);
	} else {
		const current = findManifestByRawPath(l2DataDir, normalized)!;
		await refreshNoteWithAttachments(l2DataDir, current, content, modelContext);
		appendLog(l2DataDir, "ingest", title, `- User note archived with attachments: ${normalized}`);
	}

	const source = getSourceById(l2DataDir, id);
	if (!source) throw new Error("Failed to load archived source");
	return source;
}

function removeFileIfExists(filePath: string): void {
	if (existsSync(filePath)) rmSync(filePath);
}

/** Delete a user note and its archived artifacts (manifest, extracted, wiki pages). */
export function deleteUserNote(l2DataDir: string, rawPath: string): boolean {
	if (!isUserNotePath(rawPath)) {
		throw new Error("Only raw/notes/*.md can be deleted through this API");
	}
	const normalized = rawPath.replace(/^\/+/, "");
	const entry = removeManifestByRawPath(l2DataDir, normalized);
	if (entry) {
		if (entry.extractedPath) {
			removeFileIfExists(join(l2DataDir, entry.extractedPath));
		}
		for (const extract of entry.attachmentExtracts ?? []) {
			removeFileIfExists(join(l2DataDir, extract.extractedPath));
		}
		for (const wikiPage of entry.wikiPages) {
			removeFileIfExists(join(l2DataDir, wikiPage));
		}
		rebuildIndex(l2DataDir, readManifest(l2DataDir));
		appendLog(l2DataDir, "delete", entry.title, `- Removed archived note: ${normalized}`);
	}
	removeFileIfExists(join(l2DataDir, normalized));
	removeNoteAttachmentDir(l2DataDir, normalized);
	return true;
}
