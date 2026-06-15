import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

import { readText, writeText } from "../../storage/file-store.js";
import { updateEnrichedSourcePages, type ArchiveModelContext } from "./archive-enricher.js";
import {
	findManifestById,
	findManifestByRawPath,
	readManifest,
	removeManifestById,
	removeManifestByRawPath,
	updateManifestEntry,
} from "./manifest-store.js";
import { listNoteAttachments, type NoteAttachmentView } from "./note-attachments.js";
import { convertToExtracted } from "./source-converter.js";
import { extractRawFileContent, titleFromRawFileName } from "./raw-file-extractor.js";
import { RawArchiveError } from "./archive-errors.js";
import type { ManifestEntry, NoteAttachmentExtract } from "./types.js";
import { rebuildIndex } from "./wiki-maintainer.js";

function removeFileIfExists(filePath: string): void {
	if (existsSync(filePath)) rmSync(filePath);
}

function removeArchivedArtifacts(l2DataDir: string, entry: ManifestEntry): void {
	if (entry.extractedPath) {
		removeFileIfExists(join(l2DataDir, entry.extractedPath));
	}
	for (const wikiPage of entry.wikiPages) {
		removeFileIfExists(join(l2DataDir, wikiPage));
	}
}

/** Remove legacy per-attachment manifest rows (separate wiki pages). */
export function cleanupLegacyAttachmentManifests(
	l2DataDir: string,
	parentEntry: ManifestEntry,
	noteRawPath: string,
): NoteAttachmentExtract[] {
	const migrated: NoteAttachmentExtract[] = [];
	for (const attachment of listNoteAttachments(l2DataDir, noteRawPath)) {
		const legacy = findManifestByRawPath(l2DataDir, attachment.rawPath);
		if (!legacy || legacy.id === parentEntry.id) continue;
		if (legacy.extractedPath) {
			migrated.push({
				rawPath: attachment.rawPath,
				fileName: attachment.fileName,
				extractedPath: legacy.extractedPath,
				contentHash: legacy.contentHash,
				sourceType: legacy.sourceType,
				updatedAt: attachment.updatedAt,
			});
		}
		removeManifestByRawPath(l2DataDir, attachment.rawPath);
		removeArchivedArtifacts(l2DataDir, legacy);
	}
	for (const entry of readManifest(l2DataDir)) {
		if (entry.parentSourceId !== parentEntry.id) continue;
		if (entry.extractedPath && !migrated.some((item) => item.rawPath === entry.rawPath.replace(/^\/+/, ""))) {
			migrated.push({
				rawPath: entry.rawPath.replace(/^\/+/, ""),
				fileName: basename(entry.rawPath),
				extractedPath: entry.extractedPath,
				contentHash: entry.contentHash,
				sourceType: entry.sourceType,
				updatedAt: entry.updatedAt,
			});
		}
		removeManifestById(l2DataDir, entry.id);
		removeArchivedArtifacts(l2DataDir, entry);
	}
	return migrated;
}

async function extractAttachment(
	l2DataDir: string,
	attachment: NoteAttachmentView,
): Promise<NoteAttachmentExtract> {
	const { content, sourceType } = await extractRawFileContent(l2DataDir, attachment.rawPath);
	const contentHash = createHash("sha256").update(content).digest("hex").slice(0, 16);
	const label = titleFromRawFileName(attachment.fileName);
	const extractedPath = convertToExtracted(l2DataDir, label, content, sourceType);
	return {
		rawPath: attachment.rawPath,
		fileName: attachment.fileName,
		extractedPath,
		contentHash,
		sourceType,
		updatedAt: attachment.updatedAt,
	};
}

export function buildCombinedNoteExtract(
	noteBody: string,
	attachmentExtracts: NoteAttachmentExtract[],
	l2DataDir: string,
): string {
	const sections: string[] = [];
	const body = noteBody.trim();
	if (body) {
		sections.push(body.startsWith("#") ? body : `## 笔记正文\n\n${body}`);
	}
	for (const attachment of attachmentExtracts) {
		const text = readText(join(l2DataDir, attachment.extractedPath)).trim();
		sections.push(
			`## 附件: ${attachment.fileName}\n\n原始文件: \`${attachment.rawPath}\`\n\n${text || "(空内容)"}`,
		);
	}
	return sections.join("\n\n").trim() || "(空笔记)";
}

function summaryBodyFromCombined(
	noteBody: string,
	attachmentExtracts: NoteAttachmentExtract[],
	l2DataDir: string,
): string {
	const combined = buildCombinedNoteExtract(noteBody, attachmentExtracts, l2DataDir);
	if (combined.length <= 4000) {
		return combined.startsWith("#") || combined.startsWith("##") ? combined : `## 内容\n\n${combined}`;
	}
	const preview = combined.slice(0, 4000);
	return `${preview}\n\n...(内容已截断，完整文本见 extracted 文件)`;
}

function parseNoteBody(content: string): string {
	const match = content.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
	return (match ? match[1] : content).trim();
}

function reuseExtract(
	existing: NoteAttachmentExtract | undefined,
	attachment: NoteAttachmentView,
	l2DataDir: string,
): NoteAttachmentExtract | undefined {
	if (!existing?.extractedPath) return undefined;
	if (existing.updatedAt !== attachment.updatedAt) return undefined;
	if (!existsSync(join(l2DataDir, existing.extractedPath))) return undefined;
	return { ...existing, fileName: attachment.fileName, rawPath: attachment.rawPath };
}

async function collectAttachmentExtracts(
	l2DataDir: string,
	noteRawPath: string,
	existingExtracts: NoteAttachmentExtract[],
): Promise<NoteAttachmentExtract[]> {
	const byPath = new Map(existingExtracts.map((item) => [item.rawPath, item]));
	const results: NoteAttachmentExtract[] = [];
	for (const attachment of listNoteAttachments(l2DataDir, noteRawPath)) {
		const reused = reuseExtract(byPath.get(attachment.rawPath), attachment, l2DataDir);
		if (reused) {
			results.push(reused);
			continue;
		}
		try {
			results.push(await extractAttachment(l2DataDir, attachment));
		} catch (err) {
			if (err instanceof RawArchiveError && ["UNSUPPORTED", "EMPTY"].includes(err.code)) {
				continue;
			}
			throw err;
		}
	}
	return results;
}

function removeOrphanExtractFiles(
	l2DataDir: string,
	previous: NoteAttachmentExtract[],
	current: NoteAttachmentExtract[],
): void {
	const currentPaths = new Set(current.map((item) => item.extractedPath));
	for (const item of previous) {
		if (!currentPaths.has(item.extractedPath)) {
			removeFileIfExists(join(l2DataDir, item.extractedPath));
		}
	}
}

/** Parse attachments and merge all extracted text into the parent note wiki page. */
export async function refreshNoteWithAttachments(
	l2DataDir: string,
	parentEntry: ManifestEntry,
	noteMarkdownContent: string,
	modelContext?: ArchiveModelContext,
	options: { skipLlm?: boolean } = {},
): Promise<ManifestEntry> {
	const noteRawPath = parentEntry.rawPath.replace(/^\/+/, "");
	const noteBody = parseNoteBody(noteMarkdownContent);
	let attachmentExtracts = parentEntry.attachmentExtracts ?? [];

	const migrated = cleanupLegacyAttachmentManifests(l2DataDir, parentEntry, noteRawPath);
	if (migrated.length > 0) {
		const merged = new Map(attachmentExtracts.map((item) => [item.rawPath, item]));
		for (const item of migrated) merged.set(item.rawPath, item);
		attachmentExtracts = [...merged.values()];
	}

	const previousExtracts = attachmentExtracts;
	attachmentExtracts = await collectAttachmentExtracts(l2DataDir, noteRawPath, attachmentExtracts);
	removeOrphanExtractFiles(l2DataDir, previousExtracts, attachmentExtracts);

	const combined = buildCombinedNoteExtract(noteBody, attachmentExtracts, l2DataDir);
	const contentHash = createHash("sha256").update(combined).digest("hex").slice(0, 16);
	if (parentEntry.extractedPath) {
		writeText(join(l2DataDir, parentEntry.extractedPath), combined);
	}

	const extraRawPaths = attachmentExtracts.map((item) => item.rawPath);
	const { wikiPagePath, linkMaintenance } = await updateEnrichedSourcePages(
		l2DataDir,
		parentEntry,
		parentEntry.title,
		parentEntry.extractedPath ?? "",
		summaryBodyFromCombined(noteBody, attachmentExtracts, l2DataDir),
		options.skipLlm ? undefined : modelContext,
		extraRawPaths,
	);

	const conceptPages = linkMaintenance.pages.filter((page) => !page.includes("wiki/sources/"));
	const wikiPages = [
		...new Set([
			...parentEntry.wikiPages.filter((page) => page.includes("wiki/sources/")),
			wikiPagePath,
			...conceptPages,
		]),
	];

	const updated =
		updateManifestEntry(l2DataDir, parentEntry.id, {
			attachmentExtracts,
			contentHash,
			wikiPages,
			status: "indexed",
		}) ?? parentEntry;

	rebuildIndex(l2DataDir, readManifest(l2DataDir));
	return updated;
}

export async function mergeAttachmentIntoParentNote(
	l2DataDir: string,
	parentSourceId: string,
	_attachmentRawPath: string,
	noteMarkdownContent: string,
	modelContext?: ArchiveModelContext,
): Promise<ManifestEntry> {
	const parentEntry = findManifestById(l2DataDir, parentSourceId);
	if (!parentEntry) {
		throw new RawArchiveError("所属笔记未归档", "NOT_FOUND");
	}
	return refreshNoteWithAttachments(l2DataDir, parentEntry, noteMarkdownContent, modelContext);
}

export function isAttachmentMerged(
	parentEntry: ManifestEntry | undefined,
	attachmentRawPath: string,
): boolean {
	if (!parentEntry?.attachmentExtracts) return false;
	const normalized = attachmentRawPath.replace(/^\/+/, "");
	return parentEntry.attachmentExtracts.some((item) => item.rawPath === normalized);
}
