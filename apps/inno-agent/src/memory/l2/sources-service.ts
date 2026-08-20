import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";

import { readText } from "../../storage/file-store.js";
import { resolveContainedPath } from "../../utils/path-safety.js";
import { readManifest } from "./manifest-store.js";
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
