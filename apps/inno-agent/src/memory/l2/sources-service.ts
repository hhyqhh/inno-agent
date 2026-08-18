import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import { readText, writeText } from "../../storage/file-store.js";
import { resolveContainedPath } from "../../utils/path-safety.js";
import { archiveL2Source, type ArchiveL2Result } from "./l2-archive-service.js";
import type { L2Memory } from "./l2-memory.js";
import { findManifestById, findManifestByRawPath, readManifest, upsertManifest } from "./manifest-store.js";
import { ensureL2Directories } from "./wiki-maintainer.js";
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

export type ArchiveRawResult = ArchiveL2Result;
export type RegenerateSourceResult = ArchiveL2Result;

export interface SaveRawMarkdownResult {
	rawPath: string;
	status: ManifestStatus | "uploaded";
}

const RAW_SCAN_DIRS = ["raw/uploads", "raw/conversations"] as const;

function inferSourceType(fileName: string): RawSourceType {
	const ext = extname(fileName).toLowerCase();
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
					sourceType: inferSourceType(name),
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

function defaultTitleFromPath(rawPath: string): string {
	const name = basename(rawPath);
	const extension = extname(name);
	return name.slice(0, name.length - extension.length) || name;
}

export function archiveRawFile(
	l2DataDir: string,
	rawPath: string,
	options: {
		title?: string;
		tags?: string[];
		model?: Model<any>;
		modelRegistry?: ModelRegistry;
		memory?: L2Memory;
	},
): Promise<ArchiveRawResult> {
	const normalizedPath = rawPath.replace(/\\/g, "/");
	const sourceType = inferSourceType(basename(normalizedPath));
	return archiveL2Source(
		l2DataDir,
		{
			title: options.title?.trim() || defaultTitleFromPath(normalizedPath),
			source: { kind: "existing", rawPath: normalizedPath, sourceType },
			tags: options.tags,
			origin: normalizedPath.startsWith("raw/conversations/") ? "conversation" : "user_upload",
			dedupeBy: "rawPath",
			logLabel: "notebook sources API",
		},
		{ model: options.model, modelRegistry: options.modelRegistry, memory: options.memory },
	);
}

export function readRawTextPreview(l2DataDir: string, rawPath: string, maxChars = 12000): string {
	const normalizedPath = rawPath.replace(/\\/g, "/");
	const sourceType = inferSourceType(basename(normalizedPath));
	if (sourceType === "pdf" || sourceType === "word" || sourceType === "image") {
		return "";
	}
	if (!normalizedPath.startsWith("raw/") || normalizedPath === "raw/") {
		throw new Error("Invalid raw path");
	}
	const absPath = resolveContainedPath(join(l2DataDir, "raw"), normalizedPath.slice("raw/".length));
	if (!absPath) throw new Error("Invalid raw path");
	const text = readText(absPath);
	return text.length > maxChars ? `${text.slice(0, maxChars)}\n\n...(已截断)` : text;
}

export async function regenerateL2Source(
	l2DataDir: string,
	sourceId: string,
	runtime: {
		model?: Model<any>;
		modelRegistry?: ModelRegistry;
		memory?: L2Memory;
	} = {},
): Promise<RegenerateSourceResult> {
	const entry = findManifestById(l2DataDir, sourceId);
	if (!entry) throw new Error(`Source not found: ${sourceId}`);
	return archiveL2Source(
		l2DataDir,
		{
			title: entry.title,
			source: { kind: "existing", rawPath: entry.rawPath, sourceType: entry.sourceType },
			tags: entry.tags,
			origin: entry.source.origin,
			url: entry.source.url,
			sessionId: entry.source.sessionId,
			force: true,
			dedupeBy: "rawPath",
			logLabel: "source regeneration",
		},
		runtime,
	);
}

export function saveRawMarkdownContent(
	l2DataDir: string,
	rawPath: string,
	content: string,
): SaveRawMarkdownResult {
	ensureL2Directories(l2DataDir);
	const normalizedPath = rawPath.replace(/\\/g, "/");
	if (!normalizedPath.startsWith("raw/") || normalizedPath.startsWith("raw/notes/")) {
		throw new Error("Invalid raw path");
	}
	if (extname(normalizedPath).toLowerCase() !== ".md") {
		throw new Error("Only Markdown raw files can be edited");
	}
	const absPath = resolveContainedPath(join(l2DataDir, "raw"), normalizedPath.slice("raw/".length));
	if (!absPath || !existsSync(absPath) || !statSync(absPath).isFile()) {
		throw new Error("文件不存在");
	}

	writeText(absPath, content.endsWith("\n") ? content : `${content}\n`);
	const entry = findManifestByRawPath(l2DataDir, normalizedPath);
	if (!entry) return { rawPath: normalizedPath, status: "uploaded" };

	upsertManifest(l2DataDir, {
		...entry,
		status: "outdated",
		updatedAt: new Date().toISOString(),
	});
	return { rawPath: normalizedPath, status: "outdated" };
}
