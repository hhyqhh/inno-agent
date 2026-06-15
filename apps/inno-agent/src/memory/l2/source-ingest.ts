import { createHash, randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";

import { readText } from "../../storage/file-store.js";
import { RawArchiveError } from "./archive-errors.js";
import { appendManifest, findManifestByHash, findManifestByRawPath, readManifest } from "./manifest-store.js";
import { mergeAttachmentIntoParentNote } from "./note-attachment-ingest.js";
import { isNoteAttachmentPath, parentNoteRawPathFromAttachment } from "./note-attachments.js";
import { convertToExtracted } from "./source-converter.js";
import { createEnrichedSourcePages, type ArchiveModelContext } from "./archive-enricher.js";
import { extractRawFileContent, titleFromRawFileName } from "./raw-file-extractor.js";
import { getSourceById, safeL2RawPath, type SourceSummaryView } from "./source-resolver.js";
import type { ManifestEntry, RawSourceType } from "./types.js";
import { appendLog, ensureL2Directories, rebuildIndex } from "./wiki-maintainer.js";

export { RawArchiveError } from "./archive-errors.js";
export { inferSourceTypeFromFileName, extractRawFileContent, titleFromRawFileName } from "./raw-file-extractor.js";

export interface IngestRawSourceOptions {
	title?: string;
	tags?: string[];
	force?: boolean;
	modelContext?: ArchiveModelContext;
	parentSourceId?: string;
}

function summaryBodyFromContent(content: string, sourceType: RawSourceType): string {
	const trimmed = content.trim();
	if (!trimmed) return "## 摘要\n\n(空内容)";
	if (sourceType === "markdown" || sourceType === "text") {
		return trimmed.startsWith("#") ? trimmed : `## 内容\n\n${trimmed}`;
	}
	const preview = trimmed.length > 2000 ? `${trimmed.slice(0, 2000)}\n\n...(内容已截断)` : trimmed;
	return `## 摘要\n\n${preview}`;
}

function isUserNoteMarkdownPath(rawPath: string): boolean {
	const normalized = rawPath.replace(/^\/+/, "");
	return /^raw\/notes\/[^/]+\.md$/i.test(normalized);
}

function resolveParentSourceId(l2DataDir: string, rawPath: string, explicit?: string): string | undefined {
	if (explicit) return explicit;
	const notePath = parentNoteRawPathFromAttachment(rawPath);
	if (!notePath) return undefined;
	return findManifestByRawPath(l2DataDir, notePath)?.id;
}

/**
 * Parse a raw file, run wiki enrichment, and append manifest.
 * Skips user-note markdown paths (handled by saveUserNote).
 * Note attachments are merged into the parent note instead of standalone sources.
 */
export async function ingestRawSourceFile(
	l2DataDir: string,
	rawPath: string,
	options: IngestRawSourceOptions = {},
): Promise<SourceSummaryView> {
	ensureL2Directories(l2DataDir);
	const normalized = rawPath.replace(/^\/+/, "");
	if (isUserNoteMarkdownPath(normalized)) {
		throw new RawArchiveError("用户笔记请通过 saveUserNote 归档", "UNSUPPORTED");
	}

	if (isNoteAttachmentPath(normalized)) {
		const parentSourceId = resolveParentSourceId(l2DataDir, normalized, options.parentSourceId);
		if (!parentSourceId) {
			throw new RawArchiveError("笔记附件需随所属笔记一并归档", "UNSUPPORTED");
		}
		const notePath = parentNoteRawPathFromAttachment(normalized);
		if (!notePath) {
			throw new RawArchiveError("无法识别附件所属笔记", "NOT_FOUND");
		}
		const noteFull = safeL2RawPath(l2DataDir, notePath);
		const noteContent = noteFull && existsSync(noteFull) ? readText(noteFull) : "";
		await mergeAttachmentIntoParentNote(
			l2DataDir,
			parentSourceId,
			normalized,
			noteContent,
			options.modelContext,
		);
		const source = getSourceById(l2DataDir, parentSourceId);
		if (!source) throw new RawArchiveError("归档失败", "NOT_FOUND");
		return source;
	}

	const filePath = safeL2RawPath(l2DataDir, normalized);
	if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
		throw new RawArchiveError("原始文件不存在", "NOT_FOUND");
	}

	const existingByPath = findManifestByRawPath(l2DataDir, normalized);
	if (existingByPath) {
		const source = getSourceById(l2DataDir, existingByPath.id);
		if (!source) throw new RawArchiveError("已归档但无法加载来源", "ALREADY_ARCHIVED");
		return source;
	}

	const { content, sourceType, fileName } = await extractRawFileContent(l2DataDir, normalized);

	const contentHash = createHash("sha256").update(content).digest("hex").slice(0, 16);
	if (!options.force) {
		const duplicate = findManifestByHash(l2DataDir, contentHash);
		if (duplicate) {
			throw new RawArchiveError(`该内容已归档: ${duplicate.title} (${duplicate.id})`, "DUPLICATE");
		}
	}

	const title = options.title?.trim() || titleFromRawFileName(fileName);
	const tags = options.tags ?? [];
	const id = `l2src_${randomUUID().slice(0, 8)}`;
	const extractedPath = convertToExtracted(l2DataDir, title, content, sourceType);

	const entry: ManifestEntry = {
		id,
		title,
		sourceType,
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

	const { wikiPagePath, linkMaintenance } = await createEnrichedSourcePages(
		l2DataDir,
		entry,
		title,
		extractedPath,
		summaryBodyFromContent(content, sourceType),
		options.modelContext,
	);
	entry.wikiPages = [wikiPagePath, ...linkMaintenance.pages];
	entry.status = "indexed";

	appendManifest(l2DataDir, entry);
	rebuildIndex(l2DataDir, readManifest(l2DataDir));
	appendLog(
		l2DataDir,
		"ingest",
		title,
		[
			`- Raw orphan archived: ${normalized}`,
			`- Source page: ${wikiPagePath}`,
			`- concepts/entities: 新建 ${linkMaintenance.created.length}, 更新 ${linkMaintenance.updated.length}, 不变 ${linkMaintenance.unchanged.length}`,
		].join("\n"),
	);

	const source = getSourceById(l2DataDir, id);
	if (!source) throw new RawArchiveError("归档失败", "NOT_FOUND");
	return source;
}
