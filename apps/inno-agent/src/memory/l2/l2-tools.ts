import { StringEnum, type Model } from "@earendil-works/pi-ai";
import { defineTool, type ModelRegistry, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomUUID, createHash } from "node:crypto";
import { join, isAbsolute, resolve } from "node:path";

import type { ManifestEntry, RawSourceType } from "./types.js";
import { decodeEvidenceRefs, type EvidenceRef } from "./evidence-types.js";
import { archiveRawContent, archiveRawFile, RawArchiveError, type ArchivedRaw } from "./raw-store.js";
import { SourceFormatError, type ArchivableFileType } from "./source-format.js";
import { convertToExtracted } from "./source-converter.js";
import {
	upsertManifest,
	readManifest,
	findRecoverableManifest,
} from "./manifest-store.js";
import {
	createSourcePage,
	fileRevision,
	replaceSourcePageIfRevision,
	rebuildIndex,
	appendLog,
	ensureL2Directories,
	parseFrontmatter,
	readMaintenanceContext,
	sourcePageHasExpectedContent,
	sourcePagePath,
} from "./wiki-maintainer.js";
import { queryWikiHybridDetailed } from "./wiki-query.js";
import { summarizeContent, summarizeContentGrounded, type GroundedCitation } from "./summarizer.js";
import { maintainLinkedWikiPages } from "./wiki-linker.js";
import { fileExists, readText } from "../../storage/file-store.js";
import {
	parseDocument,
	parseDocumentBytes,
	DocumentParseError,
	type ParsedDocumentResult,
} from "./document-parser.js";
import { getL2Memory, type L2Memory } from "./l2-memory.js";
import { regenerateOverview } from "./overview.js";
import { formatL2LintReport, runL2Lint } from "./l2-lint.js";
import { logger } from "../../logger.js";
import { buildEvidenceIndex, writeEvidenceIndexAtomic } from "./evidence-index.js";
import {
	createModelEvidenceSelector,
	type EvidenceCandidateSelector,
} from "./evidence-selector.js";
import { attachEvidenceToPages, attachGroundedCitations } from "./evidence-page-writer.js";
import { getWikiPageWriteQueue } from "./wiki-page-write-queue.js";
import { resolveRawSourcePath } from "./source-path.js";
import { readSourceBytes } from "./source-revision.js";

export interface ArchiveModelContext {
	model?: Model<any>;
	modelRegistry?: ModelRegistry;
}

export interface L2ToolDependencies {
	parseDocument?: typeof parseDocument;
	selectorFactory?: (ctx: ArchiveModelContext) => EvidenceCandidateSelector | null;
}

// PI may dispatch several archive tool calls from one turn concurrently.
const archiveQueueTails = new Map<string, Promise<void>>();

function readGroundedEvidenceReferences(l2DataDir: string, pagePath: string, sourceId: string): EvidenceRef[] {
	const absolutePath = join(l2DataDir, pagePath);
	if (!fileExists(absolutePath)) return [];
	const parsed = parseFrontmatter(readText(absolutePath));
	return decodeEvidenceRefs(parsed.frontmatter?.evidence_refs, [sourceId]).valid.filter((reference) => (
		reference.selected_by === "model" && reference.marker !== undefined
	));
}

function enqueueArchive<T>(l2DataDir: string, task: () => Promise<T>): Promise<T> {
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

interface RecoveredArchivedRaw {
	archivedRaw: ArchivedRaw;
	rawBytes: Buffer;
}

function archivedRawFromManifest(
	l2DataDir: string,
	entry: ManifestEntry | undefined,
	fallbackOriginLabel: ArchivedRaw["originLabel"],
): RecoveredArchivedRaw | undefined {
	if (!entry) return undefined;
	const paths = resolveRawSourcePath(l2DataDir, entry);
	if (paths.status !== "ready") return undefined;
	const snapshot = readSourceBytes(paths);
	if (snapshot.status !== "ready") return undefined;
	if (entry.rawContentHash && snapshot.rawContentHash !== entry.rawContentHash) return undefined;
	return {
		archivedRaw: {
			rawPath: entry.rawPath,
			absolutePath: paths.rawAbsolutePath,
			rawContentHash: snapshot.rawContentHash,
			rawSize: snapshot.rawSize,
			rawMtimeMs: snapshot.rawMtimeMs,
			originLabel: entry.rawKind ?? fallbackOriginLabel,
		},
		rawBytes: snapshot.rawBytes,
	};
}

function findManifestWithRaw(
	l2DataDir: string,
	predicate: (entry: ManifestEntry) => boolean,
	fallbackOriginLabel: ArchivedRaw["originLabel"],
	expectedRawContentHash?: string,
): { entry: ManifestEntry; archivedRaw: ArchivedRaw; rawBytes: Buffer } | undefined {
	const entries = readManifest(l2DataDir);
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!predicate(entry)) continue;
		const recovered = archivedRawFromManifest(l2DataDir, entry, fallbackOriginLabel);
		if (!recovered || (expectedRawContentHash && recovered.archivedRaw.rawContentHash !== expectedRawContentHash)) {
			continue;
		}
		return { entry, archivedRaw: recovered.archivedRaw, rawBytes: recovered.rawBytes };
	}
	return undefined;
}

/**
 * Create L2 Wiki memory tools for the Inno Agent.
 * When `isEnabled` is provided and returns false, the archive/query tools
 * short-circuit to a disabled notice without touching the knowledge base.
 * `l2Memory` keeps the retrieval index in sync; defaults to the per-dir
 * singleton so callers that don't pass one still get index maintenance.
 * `getActiveWorkspaceDir` resolves relative file paths for the current
 * session; server callers must keep this dynamic because sessions can switch
 * workspaces without recreating the extension.
 * The final argument accepts the legacy parser function or a dependency object.
 */
export function createL2Tools(
	l2DataDir: string,
	isEnabled?: () => boolean,
	l2Memory: L2Memory = getL2Memory(l2DataDir),
	getActiveWorkspaceDir?: () => string,
	dependenciesOrParser: L2ToolDependencies | typeof parseDocument = {},
): ToolDefinition[] {
	const dependencies: L2ToolDependencies = typeof dependenciesOrParser === "function"
		? { parseDocument: dependenciesOrParser }
		: dependenciesOrParser;
	const documentParser = dependencies.parseDocument ?? parseDocument;
	const selectorFactory = dependencies.selectorFactory
		?? ((archiveContext: ArchiveModelContext) => createModelEvidenceSelector(
			archiveContext.model,
			archiveContext.modelRegistry,
		));
	const l2DisabledResult = () => ({
		content: [{ type: "text" as const, text: "L2 Wiki 知识库已在设置中关闭，当前不归档也不检索知识库内容。" }],
		details: { disabled: true },
	});

	// ---- Tool 1: l2_archive ----
	const archiveTool = defineTool({
		name: "l2_archive",
		label: "归档到 L2 Wiki",
		description:
			"将学习资料归档到 L2 Wiki 知识库。用户说「归档」「保存到知识库」「帮我记下来」或上传资料要求学习/总结时调用。" +
			"支持文本(text)、Markdown(markdown)、对话片段(conversation)、PDF(pdf)、Word 文档(word)、图片(image)。" +
			"文本类内容传 content 参数；文件类内容传 filePath 参数。",
		parameters: Type.Object({
			title: Type.String({ description: "资料标题" }),
			content: Type.Optional(Type.String({ description: "要归档的文本内容（与 filePath 二选一）" })),
			filePath: Type.Optional(Type.String({ description: "要归档的文件路径（PDF/Word/Markdown/Image），与 content 二选一" })),
			sourceType: StringEnum(["text", "markdown", "conversation", "pdf", "word", "image"] as const, {
				description: "资料类型：text（纯文本）、markdown、conversation（对话片段）、pdf、word、image",
			}),
			tags: Type.Optional(Type.Array(Type.String(), { description: "标签列表，如 ['python', 'async']" })),
			origin: Type.Optional(
				StringEnum(["user_upload", "conversation", "web", "research", "agent_inferred"] as const, {
					description: "来源类型，默认根据 sourceType 自动推断",
				}),
			),
			url: Type.Optional(Type.String({ description: "来源 URL（网页、论文链接等）" })),
			sessionId: Type.Optional(Type.String({ description: "关联的会话 ID" })),
			force: Type.Optional(Type.Boolean({ description: "为 true 时跳过重复检查，强制归档" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (isEnabled && !isEnabled()) return l2DisabledResult();
			return enqueueArchive(l2DataDir, async () => {
			ensureL2Directories(l2DataDir);
			const maintenanceContext = readMaintenanceContext(l2DataDir);

			const sourceType = params.sourceType as RawSourceType;
			const isFileType = sourceType === "pdf"
				|| sourceType === "word"
				|| sourceType === "markdown"
				|| sourceType === "image";
			const hasPreciseEvidence = sourceType === "pdf" || sourceType === "word" || sourceType === "markdown";
			const tags = params.tags ?? [];
			const inferredOrigin = sourceType === "conversation" ? "conversation" : "user_upload";
			let existing: ManifestEntry | undefined;
			if ((sourceType === "pdf" || sourceType === "word") && !params.filePath) {
				return {
					content: [{ type: "text" as const, text: "PDF and Word archives require filePath." }],
					details: { error: "file_path_required" },
				};
			}

			// Resolve content: either from params.content or by parsing a file
			let content: string;
			let archivedRaw: ArchivedRaw | undefined;
			let recoveredRawBytes: Buffer | undefined;
			let parsedDocument: ParsedDocumentResult | undefined;

			const duplicateResult = (entry: ManifestEntry) => ({
				content: [{
					type: "text" as const,
					text: `Source already archived: ${entry.title} (${entry.id}).`,
				}],
				details: { id: entry.id, duplicate: true },
			});

			const archiveFailureResult = (error: unknown) => {
				const controlledError = error instanceof DocumentParseError
					|| error instanceof SourceFormatError
					|| error instanceof RawArchiveError;
				const message = controlledError ? error.message : String(error);
				return {
					content: [{ type: "text" as const, text: `Failed to archive or parse source: ${message}` }],
					details: { error: controlledError ? error.code : "parse_error" },
				};
			};

			const persistParseFailure = (error: unknown, knownContentHash = "") => {
				if (!archivedRaw) return archiveFailureResult(error);
				const failedId = existing?.id ?? `l2src_${randomUUID().slice(0, 8)}`;
				const failedEntry: ManifestEntry = {
					...existing,
					id: failedId,
					title: params.title,
					sourceType,
					rawPath: archivedRaw.rawPath,
					extractedPath: existing?.extractedPath,
					wikiPages: existing?.wikiPages ?? [],
					tags,
					contentHash: knownContentHash || existing?.contentHash || "",
					rawContentHash: archivedRaw.rawContentHash,
					rawSize: archivedRaw.rawSize,
					rawMtimeMs: archivedRaw.rawMtimeMs,
					rawKind: archivedRaw.originLabel,
					status: "error",
					source: {
						origin: (params.origin ?? inferredOrigin) as ManifestEntry["source"]["origin"],
						...(params.url && { url: params.url }),
						...(params.sessionId && { sessionId: params.sessionId }),
					},
					createdAt: existing?.createdAt ?? new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				};
				upsertManifest(l2DataDir, failedEntry);
				const result = archiveFailureResult(error);
				return { ...result, details: { ...result.details, id: failedId } };
			};

			if (isFileType && params.filePath) {
				// File-based: preserve the immutable original before any validation or parsing.
				existing = !params.force
					? findRecoverableManifest(l2DataDir, params.title, sourceType)
					: undefined;
				const recoveredRaw = archivedRawFromManifest(l2DataDir, existing, "uploaded-original");
				archivedRaw = recoveredRaw?.archivedRaw;
				recoveredRawBytes = recoveredRaw?.rawBytes;
				if (existing && !recoveredRaw) existing = undefined;
				const workspaceDir = getActiveWorkspaceDir?.() || process.env.INNO_WORKSPACE_DIR || process.cwd();
				const resolvedFilePath = isAbsolute(params.filePath)
					? params.filePath
					: resolve(workspaceDir, params.filePath);

				try {
					if (!archivedRaw) {
						archivedRaw = sourceType === "image"
							? archiveRawFile(l2DataDir, params.title, resolvedFilePath, "image")
							: archiveRawFile(l2DataDir, params.title, resolvedFilePath, sourceType as ArchivableFileType);
					}
				} catch (err) {
					logger.warn({ err, filePath: resolvedFilePath }, "l2_archive: failed to archive or parse document");
					const controlledError = err instanceof DocumentParseError
						|| err instanceof SourceFormatError
						|| err instanceof RawArchiveError;
					const msg = controlledError ? err.message : String(err);
					return {
						content: [{ type: "text" as const, text: `文件归档或解析失败: ${msg}` }],
						details: { error: controlledError ? err.code : "parse_error" },
					};
				}

				try {
					parsedDocument = recoveredRawBytes
						? await parseDocumentBytes(archivedRaw.absolutePath, recoveredRawBytes)
						: await documentParser(archivedRaw.absolutePath);
				} catch (error) {
					logger.warn({ sourceId: existing?.id, code: "parse-failed" }, "l2_archive: failed to parse archived document");
					return persistParseFailure(error);
				}
				content = parsedDocument.text;
			} else if (params.content) {
				content = params.content;
				const prospectiveHash = createHash("sha256").update(content).digest("hex").slice(0, 16);
				const recovered = !params.force
					? findManifestWithRaw(
						l2DataDir,
						(entry) => entry.contentHash === prospectiveHash && entry.sourceType === sourceType,
						"archived-text",
					)
					: undefined;
				existing = recovered?.entry;
				archivedRaw = recovered?.archivedRaw;
				recoveredRawBytes = recovered?.rawBytes;
				if (existing?.status === "indexed") return duplicateResult(existing);
				archivedRaw ??= archiveRawContent(l2DataDir, params.title, content, sourceType, params.url);
				if (sourceType === "markdown") {
					try {
						parsedDocument = recoveredRawBytes
							? await parseDocumentBytes(archivedRaw.absolutePath, recoveredRawBytes)
							: await documentParser(archivedRaw.absolutePath);
					} catch (error) {
						logger.warn({ sourceId: existing?.id, code: "parse-failed" }, "l2_archive: failed to parse archived Markdown");
						return persistParseFailure(error, prospectiveHash);
					}
				}
			} else {
				return {
					content: [{ type: "text" as const, text: "参数错误：必须提供 content（文本内容）或 filePath（文件路径）。" }],
					details: { error: "missing_content" },
				};
			}

			const contentHash = createHash("sha256").update(content).digest("hex").slice(0, 16);

				// Completed content is a duplicate. Incomplete records resume below.
				if (!existing && !params.force && params.filePath) {
					const recovered = findManifestWithRaw(
						l2DataDir,
						(entry) => entry.contentHash === contentHash && entry.sourceType === sourceType,
						"uploaded-original",
						archivedRaw.rawContentHash,
					);
					if (recovered) {
						existing = recovered.entry;
						archivedRaw = recovered.archivedRaw;
						recoveredRawBytes = recovered.rawBytes;
					}
				}
				if (existing?.status === "indexed") {
						return {
						content: [
							{
								type: "text" as const,
								text:
									`该内容已归档，无需重复保存。\n\n` +
									`- ID: ${existing.id}\n` +
									`- 标题: ${existing.title}\n` +
									`- Wiki 页面: ${existing.wikiPages.join(", ") || "无"}\n\n` +
									`如需强制归档，请设置 force: true。`,
							},
						],
						details: { id: existing.id, duplicate: true },
					};
				}

				if (!archivedRaw) {
					archivedRaw = archiveRawContent(l2DataDir, params.title, content, sourceType, params.url);
				}
				const rawPath = archivedRaw.rawPath;

				const id = existing?.id ?? `l2src_${randomUUID().slice(0, 8)}`;

				// Convert to extracted markdown
				const existingExtractedPath = existing?.extractedPath && fileExists(join(l2DataDir, existing.extractedPath))
					? existing.extractedPath
					: undefined;
				const extractedPath = existingExtractedPath
					?? convertToExtracted(l2DataDir, params.title, content, sourceType);

				// Persist the recoverable source record before model/page work begins.
				const entry: ManifestEntry = {
					...existing,
					id,
				title: params.title,
				sourceType,
				rawPath,
				extractedPath,
				wikiPages: [],
				tags,
				contentHash,
				rawContentHash: archivedRaw.rawContentHash,
				rawSize: archivedRaw.rawSize,
				rawMtimeMs: archivedRaw.rawMtimeMs,
				rawKind: archivedRaw.originLabel,
				status: "extracted",
				source: {
					origin: (params.origin ?? inferredOrigin) as ManifestEntry["source"]["origin"],
					...(params.url && { url: params.url }),
					...(params.sessionId && { sessionId: params.sessionId }),
				},
					createdAt: existing?.createdAt ?? new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				};
				upsertManifest(l2DataDir, entry);

				let wikiPagePath = "";
				let linkMaintenance: Awaited<ReturnType<typeof maintainLinkedWikiPages>>;
				try {
					let evidenceIndexReady = false;
					if (hasPreciseEvidence && parsedDocument) {
						const evidenceIndex = buildEvidenceIndex({
							sourceId: entry.id,
							sourceType: sourceType as "pdf" | "word" | "markdown",
							rawContentHash: archivedRaw.rawContentHash,
							parsed: parsedDocument,
							...(sourceType === "markdown" && archivedRaw.originLabel === "archived-text"
								? { markdownContent: recoveredRawBytes?.toString("utf8") ?? readText(archivedRaw.absolutePath) }
								: {}),
						});
						writeEvidenceIndexAtomic(l2DataDir, evidenceIndex);
						evidenceIndexReady = true;
					}

					// Create wiki source page (with LLM summary)
					const extractedContent = readText(join(l2DataDir, extractedPath));
					let summaryBody = `## 摘要\n\n${extractedContent}`;
					let groundedCitations: GroundedCitation[] | null = null;
					let groundedCanonicalReferences: EvidenceRef[] | undefined;
					if (ctx.model) {
						if (evidenceIndexReady) {
							const result = await summarizeContentGrounded(ctx.model, ctx.modelRegistry, params.title, extractedContent);
							if (result.body) summaryBody = result.body;
							groundedCitations = result.citations;
						} else {
							const result = await summarizeContent(ctx.model, ctx.modelRegistry, params.title, extractedContent);
							if (result) summaryBody = result;
						}
					}
					wikiPagePath = sourcePagePath(entry);
					const sourcePageAbsolutePath = join(l2DataDir, wikiPagePath);
					const sourcePageQueue = getWikiPageWriteQueue(l2DataDir);
					let sourcePageManaged = false;
					let sourcePageFileRevision = "";
					await sourcePageQueue.run(wikiPagePath, () => {
						const existed = fileExists(sourcePageAbsolutePath);
						createSourcePage(l2DataDir, entry, summaryBody, extractedPath);
						const currentContent = readText(sourcePageAbsolutePath);
						sourcePageFileRevision = fileRevision(Buffer.from(currentContent, "utf8"));
						sourcePageManaged = !existed
							|| existing?.sourcePageFileRevision === sourcePageFileRevision;
						if (!existed) {
							entry.sourcePageFileRevision = sourcePageFileRevision;
							entry.wikiPages = [wikiPagePath];
							upsertManifest(l2DataDir, entry);
						}
					});
					linkMaintenance = await maintainLinkedWikiPages(
						l2DataDir,
						entry,
						wikiPagePath,
						summaryBody,
						ctx.model,
						ctx.modelRegistry,
					);
					const sourcePageNeedsPublication = !sourcePageHasExpectedContent(
						l2DataDir,
						entry,
						linkMaintenance.sourcePageBody,
						extractedPath,
					) || groundedCitations !== null;
					if (sourcePageNeedsPublication && sourcePageManaged) {
						await sourcePageQueue.run(wikiPagePath, () => {
							const currentContent = readText(sourcePageAbsolutePath);
							if (fileRevision(Buffer.from(currentContent, "utf8")) !== sourcePageFileRevision) {
								logger.warn(
									{ sourceId: entry.id, pagePath: wikiPagePath, code: "source-page-changed-during-maintenance" },
									"L2 source-page publication skipped",
								);
								return;
							}
							if (!sourcePageHasExpectedContent(
								l2DataDir,
								entry,
								linkMaintenance.sourcePageBody,
								extractedPath,
							)) {
								if (!replaceSourcePageIfRevision(
									l2DataDir,
									entry,
									linkMaintenance.sourcePageBody,
									sourcePageFileRevision,
									extractedPath,
								)) return;
							}
							if (groundedCitations !== null) {
								const groundedResult = attachGroundedCitations({
									l2DataDir,
									entry,
									pagePath: wikiPagePath,
									citations: groundedCitations,
								});
								if (groundedResult.rejected === 0 && groundedResult.accepted === groundedCitations.length) {
									groundedCanonicalReferences = readGroundedEvidenceReferences(
										l2DataDir,
										wikiPagePath,
										entry.id,
									);
								}
							}
							entry.sourcePageFileRevision = fileRevision(
								Buffer.from(readText(sourcePageAbsolutePath), "utf8"),
							);
						});
					} else if (sourcePageNeedsPublication) {
						logger.warn(
							{ sourceId: entry.id, pagePath: wikiPagePath, code: "source-page-not-system-managed" },
							"L2 source-page publication skipped",
						);
					}
					entry.wikiPages = [wikiPagePath, ...linkMaintenance.pages];
					if (evidenceIndexReady) {
						let selector: EvidenceCandidateSelector | null = null;
						try {
							selector = selectorFactory({ model: ctx.model, modelRegistry: ctx.modelRegistry });
						} catch {
							logger.warn({ sourceId: entry.id, code: "selector-factory-failed" }, "L2 evidence selector unavailable");
						}
						if (groundedCitations !== null) {
							if (linkMaintenance.pages.length > 0) {
								await attachEvidenceToPages({
									l2DataDir,
									entry,
									pagePaths: linkMaintenance.pages,
									selector,
									canonicalReferences: groundedCanonicalReferences ?? [],
								});
							}
						} else {
							await attachEvidenceToPages({
								l2DataDir,
								entry,
								pagePaths: entry.wikiPages,
								selector,
							});
						}
					}
					entry.status = "indexed";
					entry.updatedAt = new Date().toISOString();
					upsertManifest(l2DataDir, entry);

					// Rebuild index
					const allEntries = readManifest(l2DataDir);
					rebuildIndex(l2DataDir, allEntries);

					// Keep the retrieval index in sync with the touched pages.
					for (const wikiPath of entry.wikiPages) {
						await l2Memory.indexPageByPath(wikiPath);
					}

					// Regenerate the knowledge-base overview (best-effort; never fails archive).
					try {
						const overviewPath = await regenerateOverview(l2DataDir, ctx.model, ctx.modelRegistry);
						if (overviewPath) await l2Memory.indexPageByPath(overviewPath);
					} catch (err) {
						logger.warn({ err }, "l2_archive: overview regeneration failed");
					}
				} catch (err) {
					entry.status = "error";
					entry.updatedAt = new Date().toISOString();
					upsertManifest(l2DataDir, entry);
					throw err;
				}

			// Append log
			appendLog(
				l2DataDir,
				"ingest",
				params.title,
				[
					`- ID: ${id}`,
					`- 类型: ${sourceType}`,
					`- 原始文件: ${rawPath}`,
					`- 提取文本: ${extractedPath}`,
					`- Source 页面: ${wikiPagePath}`,
					`- concepts/entities: 新建 ${linkMaintenance.created.length}, 更新 ${linkMaintenance.updated.length}, 不变 ${linkMaintenance.unchanged.length}, 争议 ${linkMaintenance.contested.length}`,
					`- 维护前上下文: schema ${maintenanceContext.schema.length} chars, index ${maintenanceContext.index.length} chars, recent log ${maintenanceContext.recentLog.length} chars`,
				].join("\n"),
			);

			return {
				content: [
					{
						type: "text" as const,
						text:
							`资料已归档到 L2 Wiki。\n\n` +
							`- ID: ${id}\n` +
							`- 标题: ${params.title}\n` +
							`- 原始文件: ${rawPath}\n` +
							`- Wiki 页面: ${wikiPagePath}\n` +
							`- 自动维护: 新建 ${linkMaintenance.created.length} 个概念/实体页，更新 ${linkMaintenance.updated.length} 个\n` +
							`- 标签: ${tags.join(", ") || "无"}\n\n` +
							`Wiki 索引已更新。`,
					},
				],
				details: { id, rawPath, wikiPagePath, linkedPages: linkMaintenance.pages },
			};
			});
		},
	});

	// ---- Tool 2: l2_query ----
	const queryTool = defineTool({
		name: "l2_query",
		label: "查询 L2 Wiki",
		description:
			"查询 L2 Wiki 知识库。当需要回答与已归档学习资料相关的问题时调用。" +
			"先读取索引，再定位和读取相关页面，综合回答。" +
			"参数 query 可省略或留空字符串，此时返回 Wiki 索引概览（用于查看有哪些内容）。",
		parameters: Type.Object({
			query: Type.Optional(
				Type.String({
					default: "",
					description:
						"查询关键词或问题，如「Python async」「上次读的论文」。留空或省略则返回 Wiki 索引概览。",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			if (isEnabled && !isEnabled()) return l2DisabledResult();
			ensureL2Directories(l2DataDir);
			const query = params.query ?? "";
			const result = await queryWikiHybridDetailed(l2Memory, query);
			appendLog(l2DataDir, "query", query, "- L2 query executed through l2_query.");
			return {
				content: [{ type: "text" as const, text: result.text }],
				details: { disabled: false, mode: result.mode, hits: result.hits },
			};
		},
	});

	// ---- Tool 3: l2_lint ----
	const lintTool = defineTool({
		name: "l2_lint",
		label: "检查 L2 Wiki",
		description: "只读检查 L2 Wiki 的 frontmatter、双链、来源追溯、manifest 和 index 一致性。不会修改或自动修复文件。",
		parameters: Type.Object({}),
		async execute() {
			if (isEnabled && !isEnabled()) return l2DisabledResult();
			const report = runL2Lint(l2DataDir);
			return {
				content: [{ type: "text" as const, text: formatL2LintReport(report) }],
				details: { disabled: false, ...report },
			};
		},
	});

	return [archiveTool, queryTool, lintTool];
}
