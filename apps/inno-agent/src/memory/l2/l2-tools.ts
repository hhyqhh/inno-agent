import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomUUID, createHash } from "node:crypto";
import { join, isAbsolute, resolve } from "node:path";

import type { ManifestEntry, RawSourceType } from "./types.js";
import { saveRaw, saveRawFile } from "./raw-store.js";
import { convertToExtracted } from "./source-converter.js";
import { appendManifest, readManifest, findManifestByHash } from "./manifest-store.js";
import {
	createSourcePage,
	rebuildIndex,
	appendLog,
	ensureL2Directories,
	readMaintenanceContext,
} from "./wiki-maintainer.js";
import { queryWikiHybrid } from "./wiki-query.js";
import { summarizeContent } from "./summarizer.js";
import { maintainLinkedWikiPages } from "./wiki-linker.js";
import { readText } from "../../storage/file-store.js";
import { parseDocument, DocumentParseError } from "./document-parser.js";
import { getL2Memory, type L2Memory } from "./l2-memory.js";
import { regenerateOverview } from "./overview.js";
import { logger } from "../../logger.js";

/**
 * Create L2 Wiki memory tools for the Inno Agent.
 * When `isEnabled` is provided and returns false, the archive/query tools
 * short-circuit to a disabled notice without touching the knowledge base.
 * `l2Memory` keeps the retrieval index in sync; defaults to the per-dir
 * singleton so callers that don't pass one still get index maintenance.
 */
export function createL2Tools(
	l2DataDir: string,
	isEnabled?: () => boolean,
	l2Memory: L2Memory = getL2Memory(l2DataDir),
): ToolDefinition[] {
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
			filePath: Type.Optional(Type.String({ description: "要归档的文件路径（PDF/Word/Image），与 content 二选一" })),
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
			ensureL2Directories(l2DataDir);
			const maintenanceContext = readMaintenanceContext(l2DataDir);

			const sourceType = params.sourceType as RawSourceType;
			const isFileType = sourceType === "pdf" || sourceType === "word" || sourceType === "image";

			// Resolve content: either from params.content or by parsing a file
			let content: string;
			let resolvedFilePath: string | undefined;

			if (isFileType && params.filePath) {
				// File-based: parse with LiteParse
				const workspaceDir = process.env.INNO_WORKSPACE_DIR || process.cwd();
				resolvedFilePath = isAbsolute(params.filePath)
					? params.filePath
					: resolve(workspaceDir, params.filePath);

				let parsed;
				try {
					parsed = await parseDocument(resolvedFilePath);
				} catch (err) {
					logger.warn({ err, filePath: resolvedFilePath }, "l2_archive: failed to parse document");
					const msg = err instanceof DocumentParseError ? err.message : String(err);
					return {
						content: [{ type: "text" as const, text: `文件解析失败: ${msg}` }],
						details: { error: err instanceof DocumentParseError ? err.code : "parse_error" },
					};
				}

				content = parsed.text;
			} else if (params.content) {
				// Text-based: use content directly
				content = params.content;
			} else {
				return {
					content: [{ type: "text" as const, text: "参数错误：必须提供 content（文本内容）或 filePath（文件路径）。" }],
					details: { error: "missing_content" },
				};
			}

			const contentHash = createHash("sha256").update(content).digest("hex").slice(0, 16);

			// Dedup: check if same content already archived
			if (!params.force) {
				const existing = findManifestByHash(l2DataDir, contentHash);
				if (existing) {
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
			}

			const rawPath = resolvedFilePath
				? saveRawFile(l2DataDir, params.title, resolvedFilePath, sourceType)
				: saveRaw(l2DataDir, params.title, content, sourceType, params.url);

			const id = `l2src_${randomUUID().slice(0, 8)}`;
			const tags = params.tags ?? [];

			// Convert to extracted markdown
			const extractedPath = convertToExtracted(l2DataDir, params.title, content, sourceType);

			// Build manifest entry
			const inferredOrigin = sourceType === "conversation" ? "conversation" : "user_upload";
			const entry: ManifestEntry = {
				id,
				title: params.title,
				sourceType,
				rawPath,
				extractedPath,
				wikiPages: [],
				tags,
				contentHash,
				status: "extracted",
				source: {
					origin: (params.origin ?? inferredOrigin) as ManifestEntry["source"]["origin"],
					...(params.url && { url: params.url }),
					...(params.sessionId && { sessionId: params.sessionId }),
				},
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			};

			// Create wiki source page (with LLM summary)
			const extractedContent = readText(join(l2DataDir, extractedPath));
			let summaryBody = `## 摘要\n\n${extractedContent}`;
			if (ctx.model) {
				const summary = await summarizeContent(ctx.model, ctx.modelRegistry, params.title, extractedContent);
				if (summary) summaryBody = summary;
			}
			const wikiPagePath = createSourcePage(l2DataDir, entry, summaryBody, extractedPath);
			const linkMaintenance = await maintainLinkedWikiPages(
				l2DataDir,
				entry,
				wikiPagePath,
				summaryBody,
				ctx.model,
				ctx.modelRegistry,
			);
			entry.wikiPages = [wikiPagePath, ...linkMaintenance.pages];
			entry.status = "indexed";

			// Write manifest
			appendManifest(l2DataDir, entry);

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
			const result = await queryWikiHybrid(l2Memory, query);
			appendLog(l2DataDir, "query", query, "- L2 query executed through l2_query.");
			return {
				content: [{ type: "text" as const, text: result }],
				details: {},
			};
		},
	});

	return [archiveTool, queryTool];
}
