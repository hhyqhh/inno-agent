import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import { readText } from "../../storage/file-store.js";
import { parseDocument, DocumentParseError } from "./document-parser.js";
import { convertToExtracted } from "./source-converter.js";
import { appendManifest, readManifest } from "./manifest-store.js";
import {
	appendLog,
	createSourcePage,
	ensureL2Directories,
	readMaintenanceContext,
	rebuildIndex,
} from "./wiki-maintainer.js";
import { summarizeContent } from "./summarizer.js";
import { maintainLinkedWikiPages } from "./wiki-linker.js";
import type { ManifestEntry, ManifestStatus, RawSourceType } from "./types.js";
import { logger } from "../../logger.js";

export interface SourceSummaryDto {
	sourceId: string;
	title: string;
	notebookType: "conversation" | "file" | "note";
	sourceType: RawSourceType;
	rawPath: string;
	extractedPath?: string;
	primaryWikiPath?: string;
	wikiPages: string[];
	tags: string[];
	status: ManifestStatus;
	origin: ManifestEntry["source"]["origin"];
	originUrl?: string;
	sessionId?: string;
	createdAt: string;
	updatedAt: string;
}

export interface OrphanRawFileDto {
	rawPath: string;
	fileName: string;
	sourceType: RawSourceType;
	size: number;
	modifiedAt: string;
	isMarkdown: boolean;
	pipelineStatus: "uploaded";
}

export interface SourcesListResponse {
	sources: SourceSummaryDto[];
	orphans: OrphanRawFileDto[];
}

export interface ArchiveRawResult {
	noteId: string;
	sourceId: string;
	title: string;
	rawPath: string;
	wikiPagePath: string;
	wikiPages: string[];
	status: "indexed";
}

const RAW_SCAN_DIRS = ["raw/uploads", "raw/conversations"] as const;

function inferSourceType(fileNameOrPath: string): RawSourceType {
	const normalized = fileNameOrPath.replace(/\\/g, "/");
	if (normalized.startsWith("raw/conversations/")) return "conversation";
	const ext = extname(fileNameOrPath).toLowerCase();
	if (ext === ".pdf") return "pdf";
	if (ext === ".doc" || ext === ".docx") return "word";
	if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".tiff"].includes(ext)) return "image";
	if (ext === ".md") return "markdown";
	return "text";
}

export function inferNotebookType(rawPath: string): "conversation" | "file" | "note" {
	if (rawPath.startsWith("raw/conversations/")) return "conversation";
	if (rawPath.startsWith("raw/notes/")) return "note";
	return "file";
}

export function primaryWikiPath(wikiPages: string[]): string | undefined {
	return wikiPages.find((p) => p.includes("wiki/sources/")) ?? wikiPages[0];
}

function entryToSummary(entry: ManifestEntry): SourceSummaryDto {
	const rawPath = entry.rawPath.replace(/\\/g, "/");
	return {
		sourceId: entry.id,
		title: entry.title,
		notebookType: inferNotebookType(rawPath),
		sourceType: entry.sourceType,
		rawPath,
		extractedPath: entry.extractedPath,
		primaryWikiPath: primaryWikiPath(entry.wikiPages),
		wikiPages: entry.wikiPages,
		tags: entry.tags,
		status: entry.status,
		origin: entry.source.origin,
		originUrl: entry.source.url,
		sessionId: entry.source.sessionId,
		createdAt: entry.createdAt,
		updatedAt: entry.updatedAt,
	};
}

export function scanOrphans(l2DataDir: string, indexedRawPaths: Set<string>): OrphanRawFileDto[] {
	const orphans: OrphanRawFileDto[] = [];
	for (const relDir of RAW_SCAN_DIRS) {
		const absDir = join(l2DataDir, relDir);
		if (!existsSync(absDir)) continue;
		for (const name of readdirSync(absDir)) {
			const relPath = join(relDir, name).replace(/\\/g, "/");
			if (indexedRawPaths.has(relPath)) continue;
			const absPath = join(l2DataDir, relPath);
			try {
				const stat = statSync(absPath);
				if (!stat.isFile()) continue;
				const ext = extname(name).toLowerCase();
				orphans.push({
					rawPath: relPath,
					fileName: name,
					sourceType: inferSourceType(relPath),
					size: stat.size,
					modifiedAt: stat.mtime.toISOString(),
					isMarkdown: ext === ".md" || ext === ".txt",
					pipelineStatus: "uploaded",
				});
			} catch (err) {
				logger.warn({ err, relPath }, "failed to stat orphan raw file");
			}
		}
	}
	orphans.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
	return orphans;
}

export function listL2Sources(l2DataDir: string): SourcesListResponse {
	ensureL2Directories(l2DataDir);
	const entries = readManifest(l2DataDir);
	const indexedRawPaths = new Set(entries.map((e) => e.rawPath.replace(/\\/g, "/")));
	return {
		sources: entries.map(entryToSummary).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
		orphans: scanOrphans(l2DataDir, indexedRawPaths),
	};
}

async function extractRawContent(l2DataDir: string, rawPath: string, sourceType: RawSourceType): Promise<string> {
	const absPath = join(l2DataDir, rawPath);
	if (!existsSync(absPath)) {
		throw new Error(`Raw file not found: ${rawPath}`);
	}
	if (sourceType === "pdf" || sourceType === "word" || sourceType === "image") {
		const parsed = await parseDocument(absPath);
		return parsed.text;
	}
	return readText(absPath);
}

function defaultTitleFromPath(rawPath: string): string {
	const name = basename(rawPath);
	const ext = extname(name);
	return name.slice(0, name.length - ext.length) || name;
}

export async function archiveRawFile(
	l2DataDir: string,
	rawPath: string,
	options: {
		title?: string;
		tags?: string[];
		model?: Model<any>;
		modelRegistry?: ModelRegistry;
	},
): Promise<ArchiveRawResult> {
	ensureL2Directories(l2DataDir);
	const normalizedPath = rawPath.replace(/\\/g, "/");
	const indexed = new Set(readManifest(l2DataDir).map((e) => e.rawPath.replace(/\\/g, "/")));
	if (indexed.has(normalizedPath)) {
		throw new Error("该文件已归档");
	}

	const sourceType = inferSourceType(normalizedPath);
	const title = options.title?.trim() || defaultTitleFromPath(normalizedPath);
	const content = await extractRawContent(l2DataDir, normalizedPath, sourceType);
	if (!content.trim()) {
		throw new DocumentParseError("无法从文件中提取有效文本", "EMPTY_RESULT");
	}

	const contentHash = createHash("sha256").update(content).digest("hex").slice(0, 16);
	const id = `l2src_${randomUUID().slice(0, 8)}`;
	const tags = options.tags ?? [];
	const extractedPath = convertToExtracted(l2DataDir, title, content, sourceType);
	const maintenanceContext = readMaintenanceContext(l2DataDir);

	const entry: ManifestEntry = {
		id,
		title,
		sourceType,
		rawPath: normalizedPath,
		extractedPath,
		wikiPages: [],
		tags,
		contentHash,
		status: "extracted",
		source: {
			origin: normalizedPath.startsWith("raw/conversations/") ? "conversation" : "user_upload",
		},
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};

	const extractedContent = readText(join(l2DataDir, extractedPath));
	let summaryBody = `## 摘要\n\n${extractedContent}`;
	if (options.model && options.modelRegistry) {
		const summary = await summarizeContent(options.model, options.modelRegistry, title, extractedContent);
		if (summary) summaryBody = summary;
	}

	const wikiPagePath = createSourcePage(l2DataDir, entry, summaryBody, extractedPath);
	const linkMaintenance = await maintainLinkedWikiPages(
		l2DataDir,
		entry,
		wikiPagePath,
		summaryBody,
		options.model,
		options.modelRegistry,
	);
	entry.wikiPages = [wikiPagePath, ...linkMaintenance.pages];
	entry.status = "indexed";
	entry.updatedAt = new Date().toISOString();

	appendManifest(l2DataDir, entry);
	rebuildIndex(l2DataDir, readManifest(l2DataDir));
	appendLog(
		l2DataDir,
		"ingest",
		title,
		[
			`- ID: ${id}`,
			`- 类型: ${sourceType}`,
			`- 原始文件: ${normalizedPath}`,
			`- Source 页面: ${wikiPagePath}`,
			`- UI archive from Sources panel`,
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

export function readRawTextPreview(l2DataDir: string, rawPath: string, maxChars = 12000): string {
	const normalizedPath = rawPath.replace(/\\/g, "/");
	const sourceType = inferSourceType(basename(normalizedPath));
	if (sourceType === "pdf" || sourceType === "word" || sourceType === "image") {
		return "";
	}
	const text = readText(join(l2DataDir, normalizedPath));
	return text.length > maxChars ? `${text.slice(0, maxChars)}\n\n...(已截断)` : text;
}
