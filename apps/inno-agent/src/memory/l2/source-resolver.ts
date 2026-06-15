import { basename, join, resolve } from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";

import { readText } from "../../storage/file-store.js";
import { findManifestById, readManifest } from "./manifest-store.js";
import { parseFrontmatter } from "./wiki-maintainer.js";
import type { ManifestEntry, NoteAttachmentExtract } from "./types.js";

export interface WikiPageRef {
	path: string;
	title: string;
}

export interface NoteAttachmentSummary {
	rawPath: string;
	fileName: string;
	size: number;
	updatedAt: string;
	archived: boolean;
}

export interface SourceSummaryView {
	id: string;
	title: string;
	sourceType: string;
	rawPath: string;
	fileName: string;
	size: number;
	tags: string[];
	wikiPages: WikiPageRef[];
	origin: string;
	url?: string;
	attachments?: NoteAttachmentSummary[];
	createdAt: string;
	updatedAt: string;
}

export interface OrphanRawFileView {
	rawPath: string;
	fileName: string;
	size: number;
	updatedAt: string;
}

function safeL2Path(l2DataDir: string, relPath: string): string | null {
	const normalized = relPath.replace(/^\/+/, "");
	const full = resolve(l2DataDir, normalized);
	const base = resolve(l2DataDir);
	if (full !== base && !full.startsWith(base + "/") && !full.startsWith(base + "\\")) {
		return null;
	}
	return full;
}

function wikiPageTitle(l2DataDir: string, wikiPath: string): string {
	const full = safeL2Path(l2DataDir, wikiPath);
	if (!full || !existsSync(full)) return basename(wikiPath, ".md");
	try {
		const { frontmatter } = parseFrontmatter(readText(full));
		return frontmatter?.title ?? basename(wikiPath, ".md");
	} catch {
		return basename(wikiPath, ".md");
	}
}

function wikiPageRefs(l2DataDir: string, paths: string[]): WikiPageRef[] {
	return paths.map((path) => ({ path, title: wikiPageTitle(l2DataDir, path) }));
}

function attachmentSummaries(l2DataDir: string, extracts: NoteAttachmentExtract[] | undefined): NoteAttachmentSummary[] | undefined {
	if (!extracts || extracts.length === 0) return undefined;
	return extracts.map((item) => {
		const fullRawPath = safeL2Path(l2DataDir, item.rawPath);
		let size = 0;
		if (fullRawPath && existsSync(fullRawPath) && statSync(fullRawPath).isFile()) {
			size = statSync(fullRawPath).size;
		}
		return {
			rawPath: item.rawPath,
			fileName: item.fileName,
			size,
			updatedAt: item.updatedAt,
			archived: true,
		};
	});
}

function entryToView(l2DataDir: string, entry: ManifestEntry): SourceSummaryView {
	const fullRawPath = safeL2Path(l2DataDir, entry.rawPath);
	let size = 0;
	if (fullRawPath && existsSync(fullRawPath) && statSync(fullRawPath).isFile()) {
		size = statSync(fullRawPath).size;
	}
	return {
		id: entry.id,
		title: entry.title,
		sourceType: entry.sourceType,
		rawPath: entry.rawPath,
		fileName: basename(entry.rawPath),
		size,
		tags: entry.tags,
		wikiPages: wikiPageRefs(l2DataDir, entry.wikiPages),
		origin: entry.source.origin,
		url: entry.source.url,
		attachments: attachmentSummaries(l2DataDir, entry.attachmentExtracts),
		createdAt: entry.createdAt,
		updatedAt: entry.updatedAt,
	};
}

export function listAllSources(l2DataDir: string): SourceSummaryView[] {
	return readManifest(l2DataDir)
		.filter((entry) => !entry.parentSourceId)
		.map((entry) => entryToView(l2DataDir, entry))
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getSourceById(l2DataDir: string, id: string): SourceSummaryView | undefined {
	const entry = findManifestById(l2DataDir, id);
	return entry ? entryToView(l2DataDir, entry) : undefined;
}

export function listOrphanRawFiles(l2DataDir: string): OrphanRawFileView[] {
	const referenced = new Set<string>();
	for (const entry of readManifest(l2DataDir)) {
		referenced.add(entry.rawPath.replace(/^\/+/, ""));
	}

	const orphans: OrphanRawFileView[] = [];
	const rawRoot = join(l2DataDir, "raw");
	if (!existsSync(rawRoot)) return orphans;

	function walk(dir: string, relPrefix: string): void {
		for (const name of readdirSync(dir)) {
			const full = join(dir, name);
			const rel = join(relPrefix, name).replace(/\\/g, "/");
			if (statSync(full).isDirectory()) {
				walk(full, rel);
				continue;
			}
			if (referenced.has(rel)) continue;
			if (/^raw\/notes\/[^/]+\/.+/.test(rel)) continue;
			const stat = statSync(full);
			orphans.push({
				rawPath: rel,
				fileName: name,
				size: stat.size,
				updatedAt: stat.mtime.toISOString(),
			});
		}
	}

	walk(rawRoot, "raw");
	return orphans.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function safeL2RawPath(l2DataDir: string, rawPath: string): string | null {
	const normalized = rawPath.replace(/^\/+/, "");
	if (!normalized.startsWith("raw/")) return null;
	return safeL2Path(l2DataDir, normalized);
}

export function orphanViewFromPath(l2DataDir: string, rawPath: string): OrphanRawFileView | null {
	const filePath = safeL2RawPath(l2DataDir, rawPath);
	if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) return null;
	const stat = statSync(filePath);
	const normalized = rawPath.replace(/^\/+/, "");
	return {
		rawPath: normalized,
		fileName: basename(filePath),
		size: stat.size,
		updatedAt: stat.mtime.toISOString(),
	};
}
