import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isAbsolute, resolve } from "node:path";

import type { RawSourceType } from "./types.js";
import { appendLog, ensureL2Directories } from "./wiki-maintainer.js";
import { queryWiki } from "./wiki-query.js";
import { DocumentParseError } from "./document-parser.js";
import { stageL2File, regenerateL2Source } from "./sources-service.js";
import { archiveL2NotebookItem, createL2Note } from "./notes-service.js";
import { logger } from "../../logger.js";

/**
 * Create L2 Wiki memory tools for the Inno Agent.
 * When `isEnabled` is provided and returns false, the archive/query tools
 * short-circuit to a disabled notice without touching the knowledge base.
 */
export function createL2Tools(l2DataDir: string, codeDir: string, isEnabled?: () => boolean): ToolDefinition[] {
	const l2DisabledResult = () => ({
		content: [{ type: "text" as const, text: "L2 Wiki 知识库已在设置中关闭，当前不归档也不检索知识库内容。" }],
		details: { disabled: true } as Record<string, unknown>,
	});

	// ---- Tool 1: l2_save_draft ----
	const saveDraftTool = defineTool({
		name: "l2_save_draft",
		label: "保存为 L2 草稿",
		description:
			"将用户明确要求加入知识库的学习资料先保存到 Notebook 草稿区，不生成 Wiki 页面。新增知识必须先调用本工具，不得跳过草稿直接归档。" +
			"支持文本(text)、Markdown(markdown)、PDF(pdf)、Word 文档(word)、图片(image)。" +
			"文本类内容传 content 参数；文件类内容传 filePath 参数。",
		parameters: Type.Object({
			title: Type.String({ description: "资料标题" }),
			content: Type.Optional(Type.String({ description: "要保存为草稿的文本内容（与 filePath 二选一）" })),
			filePath: Type.Optional(Type.String({ description: "要保存到待处理区的文件路径（PDF/Word/Image），与 content 二选一" })),
			sourceType: StringEnum(["text", "markdown", "pdf", "word", "image"] as const, {
				description: "资料类型：text（纯文本）、markdown、pdf、word、image",
			}),
			tags: Type.Optional(Type.Array(Type.String(), { description: "标签列表，如 ['python', 'async']" })),
			origin: Type.Optional(
				StringEnum(["user_upload", "web", "research", "agent_inferred"] as const, {
					description: "来源类型，默认根据 sourceType 自动推断",
				}),
			),
			url: Type.Optional(Type.String({ description: "来源 URL（网页、论文链接等）" })),
			force: Type.Optional(Type.Boolean({ description: "文件为 true 时跳过重复检查，强制创建待处理副本" })),
		}),
		async execute(_toolCallId, params, _signal) {
			if (isEnabled && !isEnabled()) return l2DisabledResult();
			const sourceType = params.sourceType as RawSourceType;
			const isFileType = sourceType === "pdf" || sourceType === "word" || sourceType === "image";
			if ((isFileType && !params.filePath) || (!isFileType && params.content === undefined)) {
				return {
					content: [{ type: "text" as const, text: "参数错误：必须提供 content（文本内容）或 filePath（文件路径）。" }],
					details: { error: "missing_content" },
				};
			}

			if (!isFileType) {
				const note = createL2Note(l2DataDir, codeDir, {
					title: params.title,
					tags: params.tags,
					content: params.content,
				});
				return {
					content: [{
						type: "text" as const,
						text:
							"资料已保存为 Notebook 草稿，尚未归档到 Wiki。\n\n" +
							"- ID: " + note.noteId + "\n" +
							"- 标题: " + note.title + "\n" +
							"- 草稿路径: " + note.rawPath + "\n" +
							"- 状态: " + note.status + "\n\n" +
							"请先审阅或编辑；只有再次明确要求归档该草稿时才会生成 Wiki 页面。",
					}],
					details: { id: note.noteId, rawPath: note.rawPath, status: note.status },
				};
			}

			const workspaceDir = process.env.INNO_WORKSPACE_DIR || process.cwd();
			const filePath = isAbsolute(params.filePath!)
				? params.filePath!
				: resolve(workspaceDir, params.filePath!);
			let result;
			try {
				result = await stageL2File(l2DataDir, {
					title: params.title,
					sourceType: sourceType as Extract<RawSourceType, "pdf" | "word" | "image">,
					filePath,
					tags: params.tags,
					origin: params.origin,
					url: params.url,
					force: params.force,
					signal: _signal,
				});
			} catch (err) {
				if (err instanceof DocumentParseError) {
					logger.warn({ err, filePath }, "l2_save_draft: failed to parse document");
					return {
						content: [{ type: "text" as const, text: `文件解析失败: ${err.message}` }],
						details: { error: err.code },
					};
				}
				throw err;
			}

			if (result.duplicate) {
				const existing = result.existing;
				return {
					content: [{
						type: "text" as const,
						text:
							`该文件内容已存在，无需重复保存。\n\n` +
							`- ID: ${existing.id}\n` +
							`- 标题: ${existing.title}\n` +
							`- 状态: ${existing.status}\n` +
							`- 路径: ${existing.rawPath}\n\n` +
							`如需创建待处理副本，请设置 force: true。`,
					}],
					details: { id: existing.id, duplicate: true },
				};
			}

			return {
				content: [{
					type: "text" as const,
					text:
						`文件已保存到 Notebook 待处理区，尚未归档到 Wiki。\n\n` +
						`- ID: ${result.sourceId}\n` +
						`- 标题: ${result.title}\n` +
						`- 文件路径: ${result.rawPath}\n` +
						`- 状态: ${result.status}\n\n` +
						`只有再次明确要求归档该文件时才会生成 Wiki 页面。`,
				}],
				details: {
					id: result.sourceId,
					rawPath: result.rawPath,
					status: result.status,
				},
			};
		},
	});

	// ---- Tool 2: l2_archive_draft ----
	const archiveDraftTool = defineTool({
		name: "l2_archive_draft",
		label: "归档 L2 草稿",
		description:
			"将 Notebook 中已经存在的草稿或待处理文件归档为 L2 Wiki 页面。" +
			"只有用户在草稿已创建后，再次明确要求归档该草稿时才调用；rawPath 必须来自 l2_save_draft 或 Notebook。",
		parameters: Type.Object({
			rawPath: Type.String({ description: "Notebook 草稿或待处理文件的相对路径，例如 raw/notes/xxx.md" }),
			title: Type.Optional(Type.String({ description: "归档标题；省略时使用草稿标题" })),
			tags: Type.Optional(Type.Array(Type.String(), { description: "归档标签；省略时使用草稿标签" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (isEnabled && !isEnabled()) return l2DisabledResult();
			const result = await archiveL2NotebookItem(l2DataDir, params.rawPath, {
				title: params.title,
				tags: params.tags,
				model: ctx.model,
				modelRegistry: ctx.modelRegistry,
				signal: _signal,
			});
			return {
				content: [{
					type: "text" as const,
					text:
						`草稿已归档到 L2 Wiki。\n\n` +
						`- ID: ${result.sourceId}\n` +
						`- 标题: ${result.title}\n` +
						`- 原始内容: ${result.rawPath}\n` +
						`- Wiki 页面: ${result.wikiPagePath}`,
				}],
				details: result,
			};
		},
	});

	// ---- Tool 3: l2_query ----
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
			const result = queryWiki(l2DataDir, query);
			appendLog(l2DataDir, "query", query, "- L2 query executed through l2_query.");
			return {
				content: [{ type: "text" as const, text: result }],
				details: {},
			};
		},
	});

	const regenerateTool = defineTool({
		name: "l2_regenerate",
		label: "Regenerate L2 knowledge",
		description:
			"Regenerate an existing L2 source from its original extracted content. " +
			"Use this when the user asks to regenerate knowledge points, adjust the knowledge structure, rebuild concepts/entities, or refresh the source summary based on an existing source. " +
			"This tool keeps the original raw material and SourceID; it must not be used to create a new material/source.",
		parameters: Type.Object({
			sourceId: Type.String({ description: "Existing L2 source id, for example l2src_xxxxxxxx." }),
			regenerateTags: Type.Optional(Type.Boolean({ default: true, description: "Whether to recalculate source tags when supported." })),
			regenerateLinks: Type.Optional(Type.Boolean({ default: true, description: "Whether to rebuild concept/entity links." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (isEnabled && !isEnabled()) return l2DisabledResult();
			ensureL2Directories(l2DataDir);
			const result = await regenerateL2Source(l2DataDir, params.sourceId, {
				regenerateTags: params.regenerateTags ?? true,
				regenerateLinks: params.regenerateLinks ?? true,
				model: ctx.model,
				modelRegistry: ctx.modelRegistry,
			});
			return {
				content: [
					{
						type: "text" as const,
						text:
							`Regenerated existing L2 source without creating a new material.\n\n` +
							`- ID: ${result.sourceId}\n` +
							`- Title: ${result.title}\n` +
							`- Raw material: ${result.rawPath}\n` +
							`- Source summary: ${result.wikiPagePath}\n` +
							`- Knowledge pages: ${result.wikiPages.join(", ") || "none"}`,
					},
				],
				details: result,
			};
		},
	});

	return [saveDraftTool, archiveDraftTool, queryTool, regenerateTool];
}
