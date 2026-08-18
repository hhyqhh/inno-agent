import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isAbsolute, resolve } from "node:path";

import type { ManifestEntry, RawSourceType } from "./types.js";
import { queryWikiHybridDetailed } from "./wiki-query.js";
import { appendLog, ensureL2Directories } from "./wiki-maintainer.js";
import { getL2Memory, type L2Memory } from "./l2-memory.js";
import { formatL2LintReport, runL2Lint } from "./l2-lint.js";
import { archiveL2Source, ArchiveSourceReadError, type ArchiveL2Source } from "./l2-archive-service.js";
import { logger } from "../../logger.js";

/**
 * Create L2 Wiki memory tools for the Inno Agent.
 * When `isEnabled` is provided and returns false, the archive/query tools
 * short-circuit to a disabled notice without touching the knowledge base.
 * `l2Memory` keeps the retrieval index in sync; defaults to the per-dir
 * singleton so callers that don't pass one still get index maintenance.
 * `getActiveWorkspaceDir` resolves relative file paths for the current
 * session; server callers must keep this dynamic because sessions can switch
 * workspaces without recreating the extension.
 */
export function createL2Tools(
	l2DataDir: string,
	isEnabled?: () => boolean,
	l2Memory: L2Memory = getL2Memory(l2DataDir),
	getActiveWorkspaceDir?: () => string,
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
			"将学习资料归档到 L2 Wiki 知识库。只有用户明确说「归档」「保存到知识库」「帮我记下来」「加入知识库」等表达长期保存意图时才调用；不要因内容有价值或用户仅要求学习/总结就主动调用。" +
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
			const sourceType = params.sourceType as RawSourceType;
			const isFileType = sourceType === "pdf" || sourceType === "word" || sourceType === "image";
			let source: ArchiveL2Source;
			if (isFileType && params.filePath) {
				const workspaceDir = getActiveWorkspaceDir?.() || process.env.INNO_WORKSPACE_DIR || process.cwd();
				const resolvedFilePath = isAbsolute(params.filePath)
					? params.filePath
					: resolve(workspaceDir, params.filePath);
				source = { kind: "file", filePath: resolvedFilePath, sourceType };
			} else if (params.content) {
				source = { kind: "content", content: params.content, sourceType };
			} else {
				return {
					content: [{ type: "text" as const, text: "参数错误：必须提供 content（文本内容）或 filePath（文件路径）。" }],
					details: { error: "missing_content" },
				};
			}

			try {
				const result = await archiveL2Source(
					l2DataDir,
					{
						title: params.title,
						source,
						tags: params.tags,
						origin: params.origin as ManifestEntry["source"]["origin"] | undefined,
						url: params.url,
						sessionId: params.sessionId,
						force: params.force,
						dedupeBy: "content",
						logLabel: "agent tool",
					},
					{ model: ctx.model, modelRegistry: ctx.modelRegistry, memory: l2Memory },
				);
				if (result.duplicate) {
					return {
						content: [
							{
								type: "text" as const,
								text:
									`该内容已归档，无需重复保存。\n\n` +
									`- ID: ${result.id}\n` +
									`- 标题: ${result.title}\n` +
									`- Wiki 页面: ${result.wikiPages.join(", ") || "无"}\n\n` +
									`如需强制归档，请设置 force: true。`,
							},
						],
						details: { id: result.id, duplicate: true },
					};
				}

				return {
					content: [
						{
							type: "text" as const,
							text:
								`资料已归档到 L2 Wiki。\n\n` +
							`- ID: ${result.id}\n` +
							`- 标题: ${params.title}\n` +
							`- 原始文件: ${result.rawPath}\n` +
							`- Wiki 页面: ${result.wikiPagePath}\n` +
							`- 自动维护: 新建 ${result.createdCount} 个概念/实体页，更新 ${result.updatedCount} 个\n` +
							`- 标签: ${result.tags.join(", ") || "无"}\n\n` +
							`Wiki 索引已更新。`,
						},
					],
					details: {
						id: result.id,
						rawPath: result.rawPath,
						wikiPagePath: result.wikiPagePath,
						linkedPages: result.linkedPages,
					},
				};
			} catch (err) {
				if (err instanceof ArchiveSourceReadError) {
					logger.warn({ err }, "l2_archive: failed to read source");
					return {
						content: [{ type: "text" as const, text: `文件解析失败: ${err.message}` }],
						details: { error: err.code === "READ_ERROR" ? "parse_error" : err.code },
					};
				}
				throw err;
			}
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
