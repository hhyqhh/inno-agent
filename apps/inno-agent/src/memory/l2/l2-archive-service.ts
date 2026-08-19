import { createHash, randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import { logger } from "../../logger.js";
import { fileExists, readText } from "../../storage/file-store.js";
import { resolveContainedPath } from "../../utils/path-safety.js";
import { DocumentParseError, parseDocument } from "./document-parser.js";
import { getL2Memory, type L2Memory } from "./l2-memory.js";
import { findManifestByHash, findManifestByRawPath, readManifest, upsertManifest } from "./manifest-store.js";
import { regenerateOverview } from "./overview.js";
import { saveRaw, saveRawFile } from "./raw-store.js";
import { convertToExtracted } from "./source-converter.js";
import { summarizeContent } from "./summarizer.js";
import type { ManifestEntry, RawSourceType } from "./types.js";
import {
	appendLog,
	createSourcePage,
	ensureL2Directories,
	readMaintenanceContext,
	rebuildIndex,
} from "./wiki-maintainer.js";
import { maintainLinkedWikiPages, reconcileLinkedWikiSource } from "./wiki-linker.js";

type FileSourceType = Extract<RawSourceType, "pdf" | "word" | "image">;

export type ArchiveL2Source =
	| { kind: "content"; content: string; sourceType: RawSourceType }
	| { kind: "file"; filePath: string; sourceType: FileSourceType }
	| { kind: "existing"; rawPath: string; sourceType: RawSourceType; content?: string };

export interface ArchiveL2Request {
	title: string;
	source: ArchiveL2Source;
	tags?: string[];
	origin?: ManifestEntry["source"]["origin"];
	url?: string;
	sessionId?: string;
	force?: boolean;
	dedupeBy?: "content" | "rawPath";
	createExtracted?: boolean;
	plainSummaryFallback?: boolean;
	preferredId?: string;
	createdAt?: string;
	logLabel?: string;
	onIndexed?: (result: ArchiveL2Result) => void | Promise<void>;
}

export interface ArchiveL2Runtime {
	model?: Model<any>;
	modelRegistry?: ModelRegistry;
	memory?: L2Memory;
}

export interface ArchiveL2Result {
	id: string;
	noteId: string;
	sourceId: string;
	title: string;
	rawPath: string;
	extractedPath?: string;
	wikiPagePath: string;
	wikiPages: string[];
	linkedPages: string[];
	tags: string[];
	contentHash: string;
	status: "indexed";
	duplicate: boolean;
	createdCount: number;
	updatedCount: number;
}

export class ArchiveSourceReadError extends Error {
	constructor(
		message: string,
		readonly code: DocumentParseError["code"] | "READ_ERROR",
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "ArchiveSourceReadError";
	}
}

const archiveQueueTails = new Map<string, Promise<void>>();

export function runInL2ArchiveQueue<T>(l2DataDir: string, task: () => Promise<T>): Promise<T> {
	const queueKey = resolve(l2DataDir);
	const previous = archiveQueueTails.get(queueKey) ?? Promise.resolve();
	const run = previous.then(task, task);
	const tail = run.then(
		() => undefined,
		() => undefined,
	);
	archiveQueueTails.set(queueKey, tail);
	return run.finally(() => {
		if (archiveQueueTails.get(queueKey) === tail) archiveQueueTails.delete(queueKey);
	});
}

function normalizeRawPath(rawPath: string): string {
	return rawPath.replace(/\\/g, "/");
}

function resolveExistingRawFile(l2DataDir: string, rawPath: string): { rawPath: string; fullPath: string } {
	const normalized = normalizeRawPath(rawPath);
	if (!normalized.startsWith("raw/") || normalized === "raw/") {
		throw new ArchiveSourceReadError("Invalid raw path", "READ_ERROR");
	}
	const fullPath = resolveContainedPath(join(l2DataDir, "raw"), normalized.slice("raw/".length));
	if (!fullPath || !fileExists(fullPath)) {
		throw new ArchiveSourceReadError(`Raw file not found: ${normalized}`, "FILE_NOT_FOUND");
	}
	return { rawPath: normalized, fullPath };
}

function reusableStoredFile(l2DataDir: string, storedPath: string | undefined, rootName: string): string | undefined {
	if (!storedPath) return undefined;
	const normalized = normalizeRawPath(storedPath);
	const prefix = `${rootName}/`;
	if (!normalized.startsWith(prefix) || normalized === prefix) return undefined;
	const fullPath = resolveContainedPath(join(l2DataDir, rootName), normalized.slice(prefix.length));
	return fullPath && fileExists(fullPath) ? normalized : undefined;
}

function resolveWikiSourceFile(l2DataDir: string, wikiPath: string): string | undefined {
	const normalized = normalizeRawPath(wikiPath);
	const prefix = "wiki/sources/";
	if (!normalized.startsWith(prefix) || normalized === prefix) return undefined;
	return resolveContainedPath(join(l2DataDir, "wiki", "sources"), normalized.slice(prefix.length)) ?? undefined;
}

async function resolveArchiveContent(
	l2DataDir: string,
	source: ArchiveL2Source,
): Promise<{ content: string; requestedRawPath?: string; sourceFilePath?: string }> {
	try {
		if (source.kind === "content") return { content: source.content };
		if (source.kind === "file") {
			const parsed = await parseDocument(source.filePath);
			return { content: parsed.text, sourceFilePath: source.filePath };
		}

		const existing = resolveExistingRawFile(l2DataDir, source.rawPath);
		if (source.content !== undefined) {
			return { content: source.content, requestedRawPath: existing.rawPath };
		}
		if (source.sourceType === "pdf" || source.sourceType === "word" || source.sourceType === "image") {
			const parsed = await parseDocument(existing.fullPath);
			return { content: parsed.text, requestedRawPath: existing.rawPath };
		}
		return { content: readText(existing.fullPath), requestedRawPath: existing.rawPath };
	} catch (err) {
		if (err instanceof ArchiveSourceReadError) throw err;
		if (err instanceof DocumentParseError) {
			throw new ArchiveSourceReadError(err.message, err.code, { cause: err });
		}
		throw new ArchiveSourceReadError(err instanceof Error ? err.message : String(err), "READ_ERROR", {
			cause: err,
		});
	}
}

function resultFromEntry(
	entry: ManifestEntry,
	duplicate: boolean,
	counts: { created: number; updated: number } = { created: 0, updated: 0 },
): ArchiveL2Result {
	return {
		id: entry.id,
		noteId: entry.id,
		sourceId: entry.id,
		title: entry.title,
		rawPath: normalizeRawPath(entry.rawPath),
		extractedPath: entry.extractedPath,
		wikiPagePath: entry.wikiPages[0] ?? "",
		wikiPages: entry.wikiPages,
		linkedPages: entry.wikiPages.slice(1),
		tags: entry.tags,
		contentHash: entry.contentHash,
		status: "indexed",
		duplicate,
		createdCount: counts.created,
		updatedCount: counts.updated,
	};
}

export function archiveL2Source(
	l2DataDir: string,
	request: ArchiveL2Request,
	runtime: ArchiveL2Runtime = {},
): Promise<ArchiveL2Result> {
	return runInL2ArchiveQueue(l2DataDir, async () => {
		ensureL2Directories(l2DataDir);
		const resolvedSource = await resolveArchiveContent(l2DataDir, request.source);
		const content = resolvedSource.content;
		if (!content.trim()) {
			throw new ArchiveSourceReadError("无法从资料中提取有效文本", "EMPTY_RESULT");
		}

		const contentHash = createHash("sha256").update(content).digest("hex").slice(0, 16);
		const existingByPath = resolvedSource.requestedRawPath
			? findManifestByRawPath(l2DataDir, resolvedSource.requestedRawPath)
			: undefined;
		const existingByHash = findManifestByHash(l2DataDir, contentHash);
		const dedupeByRawPath = request.dedupeBy === "rawPath";
		const existing = dedupeByRawPath
			? existingByPath
			: (request.force ? undefined : existingByHash);
		const duplicateMatches = !dedupeByRawPath || existing?.contentHash === contentHash;
		if (existing?.status === "indexed" && !request.force && duplicateMatches) {
			const duplicateResult = resultFromEntry(existing, true);
			await request.onIndexed?.(duplicateResult);
			return duplicateResult;
		}
		const reusableRawPath = reusableStoredFile(l2DataDir, existing?.rawPath, "raw");
		const rawPath = resolvedSource.requestedRawPath
			?? reusableRawPath
			?? normalizeRawPath(resolvedSource.sourceFilePath
				? saveRawFile(l2DataDir, request.title, resolvedSource.sourceFilePath, request.source.sourceType)
				: saveRaw(l2DataDir, request.title, content, request.source.sourceType, request.url));

		const createExtracted = request.createExtracted !== false;
		const reusableExtractedPath = existing?.contentHash === contentHash
			? reusableStoredFile(l2DataDir, existing.extractedPath, "extracted")
			: undefined;
		const extractedPath = createExtracted
			? (reusableExtractedPath ?? convertToExtracted(l2DataDir, request.title, content, request.source.sourceType))
			: undefined;

		const now = new Date().toISOString();
		const sourceUrl = request.url ?? existing?.source.url;
		const sourceSessionId = request.sessionId ?? existing?.source.sessionId;
		const previousWikiPages = existing?.wikiPages ?? [];
		const previousSourcePages = previousWikiPages.filter((path) => path.startsWith("wiki/sources/"));
		const preferredSourcePagePath = previousSourcePages[0];
		const entry: ManifestEntry = {
			...existing,
			id: existing?.id ?? request.preferredId ?? `l2src_${randomUUID().slice(0, 8)}`,
			title: request.title,
			sourceType: request.source.sourceType,
			rawPath,
			extractedPath,
			wikiPages: previousWikiPages,
			tags: request.tags ?? existing?.tags ?? [],
			contentHash,
			status: "extracted",
			source: {
				origin: request.origin
					?? existing?.source.origin
					?? (request.source.sourceType === "conversation" ? "conversation" : "user_upload"),
				...(sourceUrl && { url: sourceUrl }),
				...(sourceSessionId && { sessionId: sourceSessionId }),
			},
			createdAt: existing?.createdAt ?? request.createdAt ?? now,
			updatedAt: now,
		};
		upsertManifest(l2DataDir, entry);

		const maintenanceContext = readMaintenanceContext(l2DataDir);
		let linkMaintenance: Awaited<ReturnType<typeof maintainLinkedWikiPages>>;
		try {
			const summaryContent = extractedPath ? readText(join(l2DataDir, extractedPath)) : content;
			let summaryBody = request.plainSummaryFallback ? content : `## 摘要\n\n${summaryContent}`;
			if (runtime.model && runtime.modelRegistry) {
				const summary = await summarizeContent(runtime.model, runtime.modelRegistry, request.title, summaryContent);
				if (summary) summaryBody = summary;
			}

			const wikiPagePath = createSourcePage(
				l2DataDir,
				entry,
				summaryBody,
				extractedPath,
				preferredSourcePagePath,
			);
			linkMaintenance = await maintainLinkedWikiPages(
				l2DataDir,
				entry,
				wikiPagePath,
				summaryBody,
				runtime.model,
				runtime.modelRegistry,
			);
			if (linkMaintenance.sourcePageBody !== summaryBody) {
				createSourcePage(
					l2DataDir,
					entry,
					linkMaintenance.sourcePageBody,
					extractedPath,
					wikiPagePath,
				);
			}
			const nextWikiPages = [wikiPagePath, ...linkMaintenance.pages];
			const staleSourcePages = previousSourcePages.filter((path) => path !== wikiPagePath);
			entry.wikiPages = Array.from(new Set([...previousWikiPages, ...nextWikiPages]));
			entry.updatedAt = new Date().toISOString();
			upsertManifest(l2DataDir, entry);

			const memory = runtime.memory ?? getL2Memory(l2DataDir);
			const nextLinkedPages = new Set(linkMaintenance.pages);
			const previousLinkedPages = previousWikiPages.filter(
				(path) => path.startsWith("wiki/entities/") || path.startsWith("wiki/concepts/"),
			);
			for (const previousLinkedPath of previousLinkedPages) {
				const reconciled = reconcileLinkedWikiSource(l2DataDir, previousLinkedPath, {
					sourceId: entry.id,
					previousSourcePagePaths: previousSourcePages,
					currentSourcePagePath: wikiPagePath,
					currentTitle: entry.title,
					keepSource: nextLinkedPages.has(previousLinkedPath),
				});
				if (!nextLinkedPages.has(previousLinkedPath)) {
					if (reconciled.exists) await memory.indexPageByPath(reconciled.path);
					else await memory.removePage(reconciled.path);
				}
			}

			const manifestsBeforeCleanup = readManifest(l2DataDir);
			for (const staleWikiPath of staleSourcePages) {
				const referencedByOtherSource = manifestsBeforeCleanup.some(
					(candidate) => candidate.id !== entry.id && candidate.wikiPages.includes(staleWikiPath),
				);
				if (referencedByOtherSource) continue;
				const staleFile = resolveWikiSourceFile(l2DataDir, staleWikiPath);
				if (staleFile && fileExists(staleFile)) unlinkSync(staleFile);
				await memory.removePage(staleWikiPath);
			}
			for (const wikiPath of nextWikiPages) await memory.indexPageByPath(wikiPath);

			entry.wikiPages = nextWikiPages;
			entry.status = "indexed";
			entry.updatedAt = new Date().toISOString();
			upsertManifest(l2DataDir, entry);
			rebuildIndex(l2DataDir, readManifest(l2DataDir));
			try {
				const overviewPath = await regenerateOverview(l2DataDir, runtime.model, runtime.modelRegistry);
				if (overviewPath) await memory.indexPageByPath(overviewPath);
			} catch (err) {
				logger.warn({ err }, "L2 archive overview regeneration failed");
			}
		} catch (err) {
			entry.status = "error";
			entry.updatedAt = new Date().toISOString();
			upsertManifest(l2DataDir, entry);
			throw err;
		}

		const result = resultFromEntry(entry, false, {
			created: linkMaintenance.created.length,
			updated: linkMaintenance.updated.length,
		});
		await request.onIndexed?.(result);
		appendLog(
			l2DataDir,
			"ingest",
			request.title,
			[
				`- ID: ${entry.id}`,
				`- 类型: ${entry.sourceType}`,
				`- 原始文件: ${rawPath}`,
				...(extractedPath ? [`- 提取文本: ${extractedPath}`] : []),
				`- Source 页面: ${result.wikiPagePath}`,
				`- concepts/entities: 新建 ${linkMaintenance.created.length}, 更新 ${linkMaintenance.updated.length}, 不变 ${linkMaintenance.unchanged.length}, 争议 ${linkMaintenance.contested.length}`,
				...(request.logLabel ? [`- 调用来源: ${request.logLabel}`] : []),
				`- 维护前上下文: schema ${maintenanceContext.schema.length} chars, index ${maintenanceContext.index.length} chars, recent log ${maintenanceContext.recentLog.length} chars`,
			].join("\n"),
		);
		return result;
	});
}
