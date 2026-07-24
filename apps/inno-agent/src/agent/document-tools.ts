import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { parseDocument, DocumentParseError } from "../memory/l2/document-parser.js";
import { logger } from "../logger.js";

/**
 * Create document parsing tools for the Inno Agent.
 */
export function createDocumentTools(): ToolDefinition[] {
	const parseDocumentTool = defineTool({
		name: "parse_document",
		label: "解析文档",
		description:
			"解析 PDF、Word、Excel、PPT 或图片文件，提取文本内容；图片会自动执行中英文 OCR。" +
			"用户想查看文件内容、提取文本、或需要先预览再决定是否归档时调用。" +
			"支持格式：.pdf, .docx, .xlsx, .pptx, .png, .jpg, .jpeg, .gif, .webp, .tiff",
		parameters: Type.Object({
			filePath: Type.String({ description: "文件路径（绝对路径或相对于工作目录的路径）" }),
			includePageDetails: Type.Optional(
				Type.Boolean({
					description: "为 true 时返回每页的文本，默认只返回合并后的全文",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const typed = params as {
				filePath: string;
				includePageDetails?: boolean;
			};

			// Resolve path relative to workspace
			const workspaceDir = process.env.INNO_WORKSPACE_DIR || process.cwd();
			const resolvedPath = isAbsolute(typed.filePath)
				? typed.filePath
				: resolve(workspaceDir, typed.filePath);

			// Check file existence before attempting parse
			if (!existsSync(resolvedPath)) {
				return {
					content: [{ type: "text" as const, text: `文件不存在: ${typed.filePath}` }],
					details: { error: "file_not_found", filePath: resolvedPath, pageCount: 0, textLength: 0 },
				};
			}

			// Parse document
			let parsed;
			try {
				parsed = await parseDocument(resolvedPath);
			} catch (err) {
				logger.warn({ err, filePath: resolvedPath }, "parse_document tool: document parsing failed");
				const msg = err instanceof DocumentParseError
					? err.message
					: (err instanceof Error ? err.message : String(err));
				const code = err instanceof DocumentParseError ? err.code : "unknown";
				return {
					content: [{ type: "text" as const, text: `文档解析失败: ${msg}` }],
					details: { error: code, filePath: resolvedPath, pageCount: 0, textLength: 0 },
				};
			}

			// Build response
			const lines: string[] = [
				`文件: ${typed.filePath}`,
				`页数: ${parsed.pageCount}`,
				`文本长度: ${parsed.text.length} 字符`,
				"",
				"--- 提取文本 ---",
				parsed.text,
			];

			if (typed.includePageDetails && parsed.pages.length > 1) {
				lines.push("", "--- 逐页文本 ---");
				for (const page of parsed.pages) {
					lines.push(``, `[第 ${page.pageNumber} 页]`, page.text);
				}
			}

			const content: Array<{ type: "text"; text: string }> = [
				{ type: "text", text: lines.join("\n") },
			];

			return {
				content,
				details: {
					error: undefined as string | undefined,
					filePath: resolvedPath,
					pageCount: parsed.pageCount,
					textLength: parsed.text.length,
				},
			};
		},
	});

	return [parseDocumentTool];
}
