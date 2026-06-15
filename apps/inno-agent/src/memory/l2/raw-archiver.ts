import { existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { readText } from "../../storage/file-store.js";
import {
	findManifestById,
	findManifestByRawPath,
	readManifest,
	removeManifestById,
	removeManifestByRawPath,
} from "./manifest-store.js";
import { isUserNotePath, saveUserNote } from "./note-archiver.js";
import {
	cleanupLegacyAttachmentManifests,
	refreshNoteWithAttachments,
} from "./note-attachment-ingest.js";
import { isNoteAttachmentPath, listNoteAttachments, parentNoteRawPathFromAttachment, removeNoteAttachmentDir } from "./note-attachments.js";
import { type ArchiveModelContext } from "./archive-enricher.js";
import {
	getSourceById,
	orphanViewFromPath,
	safeL2RawPath,
	type OrphanRawFileView,
	type SourceSummaryView,
} from "./source-resolver.js";
import type { ManifestEntry } from "./types.js";
import { appendLog, ensureL2Directories, rebuildIndex } from "./wiki-maintainer.js";
import { ingestRawSourceFile, RawArchiveError } from "./source-ingest.js";

export { RawArchiveError } from "./source-ingest.js";

export interface ArchiveOrphanOptions {
	title?: string;
	tags?: string[];
	force?: boolean;
	modelContext?: ArchiveModelContext;
}

/** Archive an orphan raw file already stored under data/l2/raw/. */
export async function archiveOrphanRaw(
	l2DataDir: string,
	rawPath: string,
	options: ArchiveOrphanOptions = {},
): Promise<SourceSummaryView> {
	const normalized = rawPath.replace(/^\/+/, "");
	if (isUserNotePath(normalized)) {
		return saveUserNote(l2DataDir, normalized, readText(join(l2DataDir, normalized)), options.modelContext);
	}
	return ingestRawSourceFile(l2DataDir, rawPath, options);
}

function removeFileIfExists(filePath: string): void {
	if (existsSync(filePath)) rmSync(filePath);
}

function removeArchivedArtifacts(l2DataDir: string, entry: ManifestEntry): void {
	if (entry.extractedPath) {
		removeFileIfExists(join(l2DataDir, entry.extractedPath));
	}
	for (const extract of entry.attachmentExtracts ?? []) {
		removeFileIfExists(join(l2DataDir, extract.extractedPath));
	}
	for (const wikiPage of entry.wikiPages) {
		removeFileIfExists(join(l2DataDir, wikiPage));
	}
}

function removeNoteAttachmentArchives(l2DataDir: string, noteRawPath: string): void {
	const parent = findManifestByRawPath(l2DataDir, noteRawPath);
	if (parent) {
		cleanupLegacyAttachmentManifests(l2DataDir, parent, noteRawPath);
	}
}

/** Revoke archive: remove manifest + wiki artifacts, keep raw file as orphan. */
export function unarchiveSource(l2DataDir: string, sourceId: string): OrphanRawFileView {
	ensureL2Directories(l2DataDir);
	const entry = findManifestById(l2DataDir, sourceId);
	if (!entry) {
		throw new RawArchiveError("来源未归档或不存在", "NOT_ARCHIVED");
	}

	const normalized = entry.rawPath.replace(/^\/+/, "");
	const rawFilePath = safeL2RawPath(l2DataDir, normalized);
	if (!rawFilePath || !existsSync(rawFilePath) || !statSync(rawFilePath).isFile()) {
		throw new RawArchiveError("原始文件不存在，无法撤回", "NOT_FOUND");
	}

	removeManifestById(l2DataDir, sourceId);
	removeArchivedArtifacts(l2DataDir, entry);
	rebuildIndex(l2DataDir, readManifest(l2DataDir));
	appendLog(
		l2DataDir,
		"unarchive",
		entry.title,
		[`- Unarchived source: ${normalized}`, `- Removed ${entry.wikiPages.length} wiki page(s)`].join("\n"),
	);

	const orphan = orphanViewFromPath(l2DataDir, normalized);
	if (!orphan) throw new RawArchiveError("撤回失败", "NOT_FOUND");
	return orphan;
}

/** Delete a raw file and any archived artifacts (manifest, extracted, wiki pages). */
export async function deleteSourceByRawPath(
	l2DataDir: string,
	rawPath: string,
	modelContext?: ArchiveModelContext,
): Promise<boolean> {
	const normalized = rawPath.replace(/^\/+/, "");
	const filePath = safeL2RawPath(l2DataDir, normalized);

	if (isNoteAttachmentPath(normalized)) {
		const notePath = parentNoteRawPathFromAttachment(normalized);
		const legacy = removeManifestByRawPath(l2DataDir, normalized);
		if (legacy) removeArchivedArtifacts(l2DataDir, legacy);
		if (filePath && existsSync(filePath)) rmSync(filePath);
		if (notePath) {
			const parent = findManifestByRawPath(l2DataDir, notePath);
			const noteFull = safeL2RawPath(l2DataDir, notePath);
			if (parent && noteFull && existsSync(noteFull)) {
				await refreshNoteWithAttachments(
					l2DataDir,
					parent,
					readText(noteFull),
					modelContext,
					{ skipLlm: true },
				);
			}
		}
		return true;
	}

	if (isUserNotePath(normalized)) {
		removeNoteAttachmentArchives(l2DataDir, normalized);
	}
	const entry = removeManifestByRawPath(l2DataDir, normalized);
	if (entry) {
		removeArchivedArtifacts(l2DataDir, entry);
		rebuildIndex(l2DataDir, readManifest(l2DataDir));
		appendLog(l2DataDir, "delete", entry.title, `- Removed source: ${normalized}`);
	}
	const fileExisted = filePath && existsSync(filePath);
	if (fileExisted) {
		rmSync(filePath);
	}
	if (isUserNotePath(normalized)) {
		removeNoteAttachmentDir(l2DataDir, normalized);
	}
	if (!entry && !fileExisted) {
		throw new RawArchiveError("文件不存在", "NOT_FOUND");
	}
	return true;
}
