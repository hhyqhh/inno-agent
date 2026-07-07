import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import { readText, writeText } from "../../storage/file-store.js";
import { parseDocument, DocumentParseError } from "./document-parser.js";
import { convertToExtracted } from "./source-converter.js";
import {
	appendManifest,
	findManifestById,
	findManifestByRawPath,
	readManifest,
	removeWikiPathFromManifest,
	updateManifestEntry,
} from "./manifest-store.js";
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
import type { ManifestEntry, ManifestStatus, RawSourceType, SelectedScope, WikiPageType } from "./types.js";
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
	selectedScope?: SelectedScope;
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

export interface ExtractRawFileResult {
	sourceId: string;
	rawPath: string;
	extractedPath: string;
	pageCount?: number;
	textLength: number;
	status: "extracted";
}

export interface RegenerateSourceResult {
	sourceId: string;
	title: string;
	rawPath: string;
	wikiPagePath: string;
	wikiPages: string[];
	status: "indexed";
	updatedAt: string;
}

export interface AddSourceRelationResult {
	sourceId: string;
	title: string;
	rawPath: string;
	sourcePagePath: string;
	relationPagePath: string;
	relationTitle: string;
	relationType: Extract<WikiPageType, "concept" | "entity">;
	wikiPages: string[];
	status: "indexed";
	updatedAt: string;
}

export interface RemoveSourceRelationResult {
	sourceId: string;
	title: string;
	rawPath: string;
	sourcePagePath: string;
	relationPagePath: string;
	relationTitle: string;
	relationType: Extract<WikiPageType, "concept" | "entity">;
	wikiPages: string[];
	status: "indexed";
	deletedOrphanPage: boolean;
	updatedAt: string;
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

function isSourceSummaryPath(wikiPath: string | undefined): boolean {
	return Boolean(wikiPath?.includes("wiki/sources/"));
}

function relationDirForType(type: Extract<WikiPageType, "concept" | "entity">): "concepts" | "entities" {
	return type === "entity" ? "entities" : "concepts";
}

function slugifyWikiTitle(title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 60);
	if (slug) return slug;
	return createHash("sha256").update(title).digest("hex").slice(0, 12);
}

function relationPagePath(type: Extract<WikiPageType, "concept" | "entity">, title: string): string {
	return join("wiki", relationDirForType(type), `${slugifyWikiTitle(title)}.md`).replace(/\\/g, "/");
}

function findRelationPage(
	l2DataDir: string,
	type: Extract<WikiPageType, "concept" | "entity">,
	title: string,
): string {
	const preferredPath = relationPagePath(type, title);
	if (existsSync(join(l2DataDir, preferredPath))) return preferredPath;

	const dir = join(l2DataDir, "wiki", relationDirForType(type));
	if (!existsSync(dir)) return preferredPath;
	for (const file of readdirSync(dir)) {
		if (!file.endsWith(".md")) continue;
		const path = join("wiki", relationDirForType(type), file).replace(/\\/g, "/");
		const { frontmatter } = parseFrontmatter(readText(join(l2DataDir, path)));
		if ((frontmatter?.title || basename(file, extname(file))) === title) return path;
	}
	return preferredPath;
}

function mergeTags(...tagGroups: string[][]): string[] {
	const seen = new Set<string>();
	const tags: string[] = [];
	for (const group of tagGroups) {
		for (const rawTag of group) {
			for (const tag of rawTag.split(/[\s,\uFF0C;\uFF1B\u3001|]+/)) {
				const trimmed = tag.trim();
				if (!trimmed || seen.has(trimmed)) continue;
				seen.add(trimmed);
				tags.push(trimmed);
			}
		}
	}
	return tags.slice(0, 12);
}

function relationReferenceBullet(source: ManifestEntry, sourcePagePath: string): string {
	return `- [[${source.title}]] - \`${sourcePagePath}\``;
}

function buildRelationPage(
	source: ManifestEntry,
	sourcePagePath: string,
	title: string,
	type: Extract<WikiPageType, "concept" | "entity">,
	description?: string,
): string {
	const today = new Date().toISOString().slice(0, 10);
	const bodyDescription = description?.trim() || "User-added knowledge relation. Details can be refined later.";
	const frontmatter = serializeFrontmatter({
		title,
		created: today,
		type,
		tags: mergeTags([type], source.tags),
		sources: [sourcePagePath],
		source_ids: [source.id],
		updated: today,
		status: "draft",
		confidence: "medium",
	});
	return `${frontmatter}
# ${title}

## Definition

${bodyDescription}

## Related Sources

${relationReferenceBullet(source, sourcePagePath)}
`;
}

function upsertRelationPage(
	l2DataDir: string,
	source: ManifestEntry,
	sourcePagePath: string,
	title: string,
	type: Extract<WikiPageType, "concept" | "entity">,
	description?: string,
): string {
	const wikiPath = findRelationPage(l2DataDir, type, title);
	const absPath = join(l2DataDir, wikiPath);
	if (!existsSync(absPath)) {
		writeText(absPath, buildRelationPage(source, sourcePagePath, title, type, description));
		return wikiPath;
	}

	const existing = readText(absPath);
	const { frontmatter, body } = parseFrontmatter(existing);
	if (!frontmatter) {
		const nextBody = `${existing.trimEnd()}\n\n## Related Sources\n\n${relationReferenceBullet(source, sourcePagePath)}\n`;
		writeText(absPath, buildRelationPage(source, sourcePagePath, title, type, description) + "\n\n" + nextBody);
		return wikiPath;
	}

	frontmatter.sources = [...new Set([...frontmatter.sources, sourcePagePath])];
	frontmatter.source_ids = [...new Set([...frontmatter.source_ids, source.id])];
	frontmatter.tags = mergeTags(frontmatter.tags, [type], source.tags);
	frontmatter.updated = new Date().toISOString().slice(0, 10);

	let nextBody = body;
	if (description?.trim() && !nextBody.includes(description.trim())) {
		nextBody = `${nextBody.trimEnd()}\n\n## User Added Relation\n\n${description.trim()}\n`;
	}
	const bullet = relationReferenceBullet(source, sourcePagePath);
	if (!nextBody.includes(sourcePagePath)) {
		const header = "\n## Related Sources";
		const index = nextBody.indexOf(header);
		if (index >= 0) {
			nextBody = `${nextBody.trimEnd()}\n${bullet}\n`;
		} else {
			nextBody = `${nextBody.trimEnd()}\n\n## Related Sources\n\n${bullet}\n`;
		}
	}
	writeText(absPath, `${serializeFrontmatter(frontmatter)}\n${nextBody.replace(/^\n/, "")}`);
	return wikiPath;
}

function addRelationLinkToSourcePage(
	l2DataDir: string,
	sourcePagePath: string,
	relationTitle: string,
	relationPagePath: string,
	description?: string,
): void {
	const absPath = join(l2DataDir, sourcePagePath);
	if (!existsSync(absPath)) return;
	const content = readText(absPath);
	const link = `[[${relationTitle}]]`;
	if (content.includes(link) || content.includes(relationPagePath)) return;

	const bullet = description?.trim()
		? `- ${link} - ${description.trim()} (\`${relationPagePath}\`)`
		: `- ${link} - \`${relationPagePath}\``;
	const section = "\n## User Added Knowledge Relations\n\n";
	const next = content.includes("\n## User Added Knowledge Relations")
		? `${content.trimEnd()}\n${bullet}\n`
		: `${content.trimEnd()}${section}${bullet}\n`;
	writeText(absPath, next);
}

function removeRelationLinkFromSourcePage(
	l2DataDir: string,
	sourcePagePath: string,
	relationTitle: string,
	relationPagePath: string,
): void {
	const absPath = join(l2DataDir, sourcePagePath);
	if (!existsSync(absPath)) return;
	const content = readText(absPath);
	const link = `[[${relationTitle}]]`;
	const lines = content.split("\n");
	const nextLines = lines.filter((line) => {
		const trimmed = line.trim();
		if (!trimmed.startsWith("-")) return true;
		return !trimmed.includes(link) && !trimmed.includes(relationPagePath);
	});
	let next = nextLines.join("\n");
	next = next.replace(/\n## User Added Knowledge Relations\n\n(?=\n|$)/g, "\n");
	if (next !== content) writeText(absPath, next);
}

function removeSourceReferenceFromRelationPage(
	l2DataDir: string,
	source: ManifestEntry,
	sourcePagePath: string,
	relationPagePath: string,
	deleteOrphanPage: boolean,
): { deleted: boolean; remainingSourceIds: string[] } {
	const absPath = join(l2DataDir, relationPagePath);
	if (!existsSync(absPath)) return { deleted: false, remainingSourceIds: [] };

	const content = readText(absPath);
	const { frontmatter, body } = parseFrontmatter(content);
	if (!frontmatter) {
		const nextBody = body
			.split("\n")
			.filter((line) => !(line.includes(sourcePagePath) || line.includes(source.id)))
			.join("\n");
		if (nextBody !== body) writeText(absPath, nextBody);
		return { deleted: false, remainingSourceIds: [] };
	}

	frontmatter.sources = frontmatter.sources.filter((item) => item !== sourcePagePath && item !== source.rawPath);
	frontmatter.source_ids = frontmatter.source_ids.filter((id) => id !== source.id);
	if (frontmatter.source_ids.length === 0 && deleteOrphanPage) {
		unlinkSync(absPath);
		return { deleted: true, remainingSourceIds: [] };
	}

	frontmatter.updated = new Date().toISOString().slice(0, 10);
	if (frontmatter.source_ids.length === 0) {
		frontmatter.status = "outdated";
	}
	const nextBody = body
		.split("\n")
		.filter((line) => !(line.includes(sourcePagePath) || line.includes(source.id)))
		.join("\n");
	writeText(absPath, `${serializeFrontmatter(frontmatter)}\n${nextBody.replace(/^\n/, "")}`);
	return { deleted: false, remainingSourceIds: frontmatter.source_ids };
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
		primaryWikiPath: entry.primary_wiki_path ?? primaryWikiPath(entry.wikiPages),
		wikiPages: entry.wikiPages,
		tags: entry.tags,
		status: entry.status,
		origin: entry.source.origin,
		originUrl: entry.source.url,
		sessionId: entry.source.sessionId,
		selectedScope: entry.selected_scope,
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

async function extractRawContent(
	l2DataDir: string,
	rawPath: string,
	sourceType: RawSourceType,
): Promise<{ content: string; pageCount?: number }> {
	const absPath = join(l2DataDir, rawPath);
	if (!existsSync(absPath)) {
		throw new Error(`Raw file not found: ${rawPath}`);
	}
	if (sourceType === "pdf" || sourceType === "word" || sourceType === "image") {
		const parsed = await parseDocument(absPath);
		return { content: parsed.text, pageCount: parsed.pageCount };
	}
	return { content: readText(absPath) };
}

function defaultTitleFromPath(rawPath: string): string {
	const name = basename(rawPath);
	const ext = extname(name);
	return name.slice(0, name.length - ext.length) || name;
}

function createUploadedEntry(
	rawPath: string,
	sourceType: RawSourceType,
	title: string,
	tags: string[] = [],
	selectedScope?: SelectedScope,
): ManifestEntry {
	const now = new Date().toISOString();
	const normalizedPath = rawPath.replace(/\\/g, "/");
	return {
		id: `l2src_${randomUUID().slice(0, 8)}`,
		title,
		sourceType,
		rawPath: normalizedPath,
		wikiPages: [],
		tags,
		contentHash: createHash("sha256").update(normalizedPath).digest("hex").slice(0, 16),
		status: "uploaded",
		notebook_type: inferNotebookType(normalizedPath),
		selected_scope: selectedScope,
		primary_wiki_path: undefined,
		error_message: null,
		source: {
			origin: normalizedPath.startsWith("raw/conversations/") ? "conversation" : "user_upload",
		},
		createdAt: now,
		updatedAt: now,
	};
}

function updateEntryStatus(
	l2DataDir: string,
	id: string,
	status: ManifestStatus,
	patch: Partial<ManifestEntry> = {},
): void {
	updateManifestEntry(l2DataDir, id, (entry) => ({
		...entry,
		...patch,
		status,
		updatedAt: new Date().toISOString(),
	}));
}

function detachSourceFromLinkedPage(
	l2DataDir: string,
	wikiPath: string,
	source: ManifestEntry,
	sourcePagePath: string | undefined,
): "deleted" | "kept" | "unchanged" {
	const absPath = join(l2DataDir, wikiPath);
	if (!existsSync(absPath)) return "unchanged";
	try {
		const { frontmatter, body } = parseFrontmatter(readText(absPath));
		if (!frontmatter) return "unchanged";

		const nextSourceIds = frontmatter.source_ids.filter((id) => id !== source.id);
		const referencesSource = nextSourceIds.length !== frontmatter.source_ids.length;
		if (referencesSource && nextSourceIds.length === 0) {
			unlinkSync(absPath);
			return "deleted";
		}

		const nextSources = frontmatter.sources.filter((item) => item !== source.rawPath && item !== sourcePagePath);
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
		logger.warn({ err, wikiPath, sourceId: source.id }, "failed to detach source from linked page before regeneration");
		return "unchanged";
	}
}

function removePreviousGeneratedLinks(l2DataDir: string, source: ManifestEntry): string[] {
	const removed: string[] = [];
	const sourcePagePath = source.primary_wiki_path ?? primaryWikiPath(source.wikiPages);
	for (const wikiPath of source.wikiPages) {
		if (wikiPath === sourcePagePath || wikiPath.includes("wiki/sources/")) continue;
		const outcome = detachSourceFromLinkedPage(l2DataDir, wikiPath, source, sourcePagePath);
		if (outcome === "deleted") {
			removed.push(wikiPath);
			removeWikiPathFromManifest(l2DataDir, wikiPath);
		}
	}
	return removed;
}

export async function extractL2RawFile(
	l2DataDir: string,
	rawPath: string,
	options: {
		title?: string;
		tags?: string[];
		selectedScope?: SelectedScope;
	} = {},
): Promise<ExtractRawFileResult> {
	ensureL2Directories(l2DataDir);
	const normalizedPath = rawPath.replace(/\\/g, "/");
	const sourceType = inferSourceType(normalizedPath);
	const title = options.title?.trim() || defaultTitleFromPath(normalizedPath);
	let entry = findManifestByRawPath(l2DataDir, normalizedPath);
	if (entry?.status === "indexed") {
		throw new Error("该文件已归档。");
	}
	if (!entry) {
		entry = createUploadedEntry(normalizedPath, sourceType, title, options.tags ?? [], options.selectedScope);
		appendManifest(l2DataDir, entry);
	} else {
		updateEntryStatus(l2DataDir, entry.id, "uploaded", {
			title,
			tags: options.tags ?? entry.tags,
			selected_scope: options.selectedScope ?? entry.selected_scope,
			error_message: null,
		});
		entry = findManifestByRawPath(l2DataDir, normalizedPath) ?? entry;
	}

	try {
		updateEntryStatus(l2DataDir, entry.id, "extracting", { error_message: null });
		const parsed = await extractRawContent(l2DataDir, normalizedPath, sourceType);
		if (!parsed.content.trim()) {
			throw new DocumentParseError("无法从文件中提取有效文本", "EMPTY_RESULT");
		}
		const contentHash = createHash("sha256").update(parsed.content).digest("hex").slice(0, 16);
		const extractedPath = convertToExtracted(l2DataDir, title, parsed.content, sourceType);
		updateEntryStatus(l2DataDir, entry.id, "extracted", {
			title,
			sourceType,
			extractedPath,
			contentHash,
			tags: options.tags ?? entry.tags,
			notebook_type: inferNotebookType(normalizedPath),
			selected_scope: options.selectedScope ?? entry.selected_scope,
			error_message: null,
		});
		return {
			sourceId: entry.id,
			rawPath: normalizedPath,
			extractedPath,
			pageCount: parsed.pageCount,
			textLength: parsed.content.length,
			status: "extracted",
		};
	} catch (err) {
		updateEntryStatus(l2DataDir, entry.id, "error", {
			error_message: err instanceof Error ? err.message : String(err),
		});
		throw err;
	}
}

export async function archiveRawFile(
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
	ensureL2Directories(l2DataDir);
	const normalizedPath = rawPath.replace(/\\/g, "/");
	let entry = findManifestByRawPath(l2DataDir, normalizedPath);
	if (entry?.status === "indexed") {
		throw new Error("该文件已归档。");
	}

	const sourceType = inferSourceType(normalizedPath);
	const title = options.title?.trim() || defaultTitleFromPath(normalizedPath);
	const tags = options.tags ?? [];
	try {
		if (!entry || !entry.extractedPath || entry.status === "uploaded" || entry.status === "error") {
			await extractL2RawFile(l2DataDir, normalizedPath, {
				title,
				tags,
				selectedScope: options.selectedScope,
			});
			entry = findManifestByRawPath(l2DataDir, normalizedPath);
		} else if (entry.status === "outdated") {
			updateEntryStatus(l2DataDir, entry.id, "extracted", {
				title,
				tags: tags.length > 0 ? tags : entry.tags,
				selected_scope: options.selectedScope ?? entry.selected_scope,
				error_message: null,
			});
			entry = findManifestByRawPath(l2DataDir, normalizedPath);
		}
		if (!entry?.extractedPath) {
			throw new Error("Extracted content is missing.");
		}
		const extractedPath = entry.extractedPath;

		updateEntryStatus(l2DataDir, entry.id, "indexing", {
			title,
			sourceType,
			tags: tags.length > 0 ? tags : entry.tags,
			selected_scope: options.selectedScope ?? entry.selected_scope,
			error_message: null,
		});
		entry = findManifestByRawPath(l2DataDir, normalizedPath) ?? entry;
		const maintenanceContext = readMaintenanceContext(l2DataDir);
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
		const indexedEntry: ManifestEntry = {
			...entry,
			title,
			sourceType,
			tags: tags.length > 0 ? tags : entry.tags,
			wikiPages: [wikiPagePath, ...linkMaintenance.pages],
			status: "indexed",
			primary_wiki_path: wikiPagePath,
			archived_at: new Date().toISOString(),
			error_message: null,
			updatedAt: new Date().toISOString(),
		};

		updateManifestEntry(l2DataDir, indexedEntry.id, () => indexedEntry);
		rebuildIndex(l2DataDir, readManifest(l2DataDir));
		appendLog(
			l2DataDir,
			"ingest",
			title,
			[
				`- ID: ${indexedEntry.id}`,
				`- 类型: ${sourceType}`,
				`- 原始文件: ${normalizedPath}`,
				`- Source 页面: ${wikiPagePath}`,
				`- UI archive from Sources panel`,
				`- 维护前上下文: schema ${maintenanceContext.schema.length} chars`,
			].join("\n"),
		);

		return {
			noteId: indexedEntry.id,
			sourceId: indexedEntry.id,
			title,
			rawPath: normalizedPath,
			wikiPagePath,
			wikiPages: indexedEntry.wikiPages,
			status: "indexed",
		};
	} catch (err) {
		const failedEntry = findManifestByRawPath(l2DataDir, normalizedPath);
		if (failedEntry) {
			updateEntryStatus(l2DataDir, failedEntry.id, "error", {
				error_message: err instanceof Error ? err.message : String(err),
			});
		}
		throw err;
	}
}

export async function regenerateL2Source(
	l2DataDir: string,
	sourceId: string,
	options: {
		regenerateTags?: boolean;
		regenerateLinks?: boolean;
		model?: Model<any>;
		modelRegistry?: ModelRegistry;
	} = {},
): Promise<RegenerateSourceResult> {
	ensureL2Directories(l2DataDir);
	const source = findManifestById(l2DataDir, sourceId);
	if (!source) {
		throw new Error(`Source not found: ${sourceId}`);
	}
	if (!source.extractedPath) {
		throw new Error(`Source has no extracted content: ${sourceId}`);
	}
	const extractedAbsPath = join(l2DataDir, source.extractedPath);
	if (!existsSync(extractedAbsPath)) {
		throw new Error(`Extracted file not found: ${source.extractedPath}`);
	}

	try {
		updateEntryStatus(l2DataDir, source.id, "indexing", { error_message: null });
		const entry = findManifestById(l2DataDir, source.id) ?? source;
		const maintenanceContext = readMaintenanceContext(l2DataDir);
		const extractedContent = readText(extractedAbsPath);
		const existingSourcePagePath = source.primary_wiki_path ?? primaryWikiPath(source.wikiPages);
		let summaryBody = `## 鎽樿\n\n${extractedContent}`;
		if (options.model && options.modelRegistry) {
			const summary = await summarizeContent(options.model, options.modelRegistry, entry.title, extractedContent);
			if (summary) summaryBody = summary;
		}
		const wikiPagePath = createSourcePage(l2DataDir, entry, summaryBody, source.extractedPath, existingSourcePagePath);
		const existingLinkedPages = source.wikiPages.filter((page) => !isSourceSummaryPath(page));
		const currentRelations = readSourceKnowledgeRelations(l2DataDir, source.wikiPages);
		const removedLinkedPages = options.regenerateLinks === false ? [] : removePreviousGeneratedLinks(l2DataDir, source);
		const linkMaintenance = options.regenerateLinks === false
			? { pages: existingLinkedPages }
			: await maintainLinkedWikiPages(
				l2DataDir,
				entry,
				wikiPagePath,
				summaryBody,
				options.model,
				options.modelRegistry,
				{ currentRelations },
			);
		const updatedAt = new Date().toISOString();
		const linkedPages = [...new Set(linkMaintenance.pages)];
		const wikiPages = [wikiPagePath, ...linkedPages];
		const indexedEntry: ManifestEntry = {
			...entry,
			wikiPages,
			tags: options.regenerateTags ? entry.tags : source.tags,
			status: "indexed",
			primary_wiki_path: wikiPagePath,
			error_message: null,
			updatedAt,
		};

		updateManifestEntry(l2DataDir, indexedEntry.id, () => indexedEntry);
		rebuildIndex(l2DataDir, readManifest(l2DataDir));
		appendLog(
			l2DataDir,
			"regenerate",
			indexedEntry.title,
			[
				`- ID: ${indexedEntry.id}`,
				`- Removed old linked pages: ${removedLinkedPages.join(", ") || "none"}`,
				`- Linked pages after regeneration: ${linkedPages.join(", ") || "none"}`,
				`- 原始文件: ${indexedEntry.rawPath}`,
				`- Extracted: ${indexedEntry.extractedPath}`,
				`- Source 页面: ${wikiPagePath}`,
				`- 保留旧关联页: ${existingLinkedPages.join(", ") || "none"}`,
				`- 重算标签: ${options.regenerateTags ? "yes" : "no"}`,
				`- 重跑概念链: ${options.regenerateLinks === false ? "no" : "yes"}`,
				`- 维护前上下文: schema ${maintenanceContext.schema.length} chars`,
			].join("\n"),
		);

		return {
			sourceId: indexedEntry.id,
			title: indexedEntry.title,
			rawPath: indexedEntry.rawPath,
			wikiPagePath,
			wikiPages: indexedEntry.wikiPages,
			status: "indexed",
			updatedAt,
		};
	} catch (err) {
		updateEntryStatus(l2DataDir, source.id, "error", {
			error_message: err instanceof Error ? err.message : String(err),
		});
		throw err;
	}
}

export function addL2SourceRelation(
	l2DataDir: string,
	sourceId: string,
	options: {
		title: string;
		type: Extract<WikiPageType, "concept" | "entity">;
		description?: string;
	},
): AddSourceRelationResult {
	ensureL2Directories(l2DataDir);
	const source = findManifestById(l2DataDir, sourceId);
	if (!source) {
		throw new Error(`Source not found: ${sourceId}`);
	}
	const relationTitle = options.title.trim();
	if (!relationTitle) {
		throw new Error("Relation title is required.");
	}
	if (options.type !== "concept" && options.type !== "entity") {
		throw new Error("Relation type must be concept or entity.");
	}

	const sourcePagePath = source.primary_wiki_path ?? primaryWikiPath(source.wikiPages);
	if (!sourcePagePath || !isSourceSummaryPath(sourcePagePath)) {
		throw new Error(`Source has no source-summary page: ${sourceId}`);
	}
	const relationPage = upsertRelationPage(
		l2DataDir,
		source,
		sourcePagePath,
		relationTitle,
		options.type,
		options.description,
	);
	addRelationLinkToSourcePage(l2DataDir, sourcePagePath, relationTitle, relationPage, options.description);

	const updatedAt = new Date().toISOString();
	const wikiPages = [...new Set([sourcePagePath, ...source.wikiPages.filter((page) => page !== sourcePagePath), relationPage])];
	const indexedEntry: ManifestEntry = {
		...source,
		wikiPages,
		primary_wiki_path: sourcePagePath,
		status: "indexed",
		error_message: null,
		updatedAt,
	};
	updateManifestEntry(l2DataDir, indexedEntry.id, () => indexedEntry);
	rebuildIndex(l2DataDir, readManifest(l2DataDir));
	appendLog(
		l2DataDir,
		"add-relation",
		indexedEntry.title,
		[
			`- ID: ${indexedEntry.id}`,
			`- Source page: ${sourcePagePath}`,
			`- Relation: ${relationTitle}`,
			`- Relation type: ${options.type}`,
			`- Relation page: ${relationPage}`,
		].join("\n"),
	);

	return {
		sourceId: indexedEntry.id,
		title: indexedEntry.title,
		rawPath: indexedEntry.rawPath,
		sourcePagePath,
		relationPagePath: relationPage,
		relationTitle,
		relationType: options.type,
		wikiPages: indexedEntry.wikiPages,
		status: "indexed",
		updatedAt,
	};
}

export function removeL2SourceRelation(
	l2DataDir: string,
	sourceId: string,
	options: {
		title: string;
		type: Extract<WikiPageType, "concept" | "entity">;
		deleteOrphanPage?: boolean;
	},
): RemoveSourceRelationResult {
	ensureL2Directories(l2DataDir);
	const source = findManifestById(l2DataDir, sourceId);
	if (!source) {
		throw new Error(`Source not found: ${sourceId}`);
	}
	const relationTitle = options.title.trim();
	if (!relationTitle) {
		throw new Error("Relation title is required.");
	}
	if (options.type !== "concept" && options.type !== "entity") {
		throw new Error("Relation type must be concept or entity.");
	}

	const sourcePagePath = source.primary_wiki_path ?? primaryWikiPath(source.wikiPages);
	if (!sourcePagePath || !isSourceSummaryPath(sourcePagePath)) {
		throw new Error(`Source has no source-summary page: ${sourceId}`);
	}
	const relationPage = findRelationPage(l2DataDir, options.type, relationTitle);
	removeRelationLinkFromSourcePage(l2DataDir, sourcePagePath, relationTitle, relationPage);
	const relationUpdate = removeSourceReferenceFromRelationPage(
		l2DataDir,
		source,
		sourcePagePath,
		relationPage,
		options.deleteOrphanPage === true,
	);

	const updatedAt = new Date().toISOString();
	const wikiPages = source.wikiPages.filter((page) => page !== relationPage);
	const indexedEntry: ManifestEntry = {
		...source,
		wikiPages,
		primary_wiki_path: sourcePagePath,
		status: "indexed",
		error_message: null,
		updatedAt,
	};
	updateManifestEntry(l2DataDir, indexedEntry.id, () => indexedEntry);
	rebuildIndex(l2DataDir, readManifest(l2DataDir));
	appendLog(
		l2DataDir,
		"remove-relation",
		indexedEntry.title,
		[
			`- ID: ${indexedEntry.id}`,
			`- Source page: ${sourcePagePath}`,
			`- Relation: ${relationTitle}`,
			`- Relation type: ${options.type}`,
			`- Relation page: ${relationPage}`,
			`- Deleted orphan page: ${relationUpdate.deleted ? "yes" : "no"}`,
			`- Remaining relation source ids: ${relationUpdate.remainingSourceIds.join(", ") || "none"}`,
		].join("\n"),
	);

	return {
		sourceId: indexedEntry.id,
		title: indexedEntry.title,
		rawPath: indexedEntry.rawPath,
		sourcePagePath,
		relationPagePath: relationPage,
		relationTitle,
		relationType: options.type,
		wikiPages: indexedEntry.wikiPages,
		status: "indexed",
		deletedOrphanPage: relationUpdate.deleted,
		updatedAt,
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
