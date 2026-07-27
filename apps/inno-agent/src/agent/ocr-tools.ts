import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	PaddleOcrError,
	recognizeWithPaddleOcr,
	resolvePaddleOcrConfig,
} from "../ocr/paddle-ocr.js";
import { logger } from "../logger.js";
import type { ConfigHolder } from "./inno-extension.js";

function isHttpUrl(value: string): boolean {
	return /^https?:\/\//i.test(value);
}

/** Resolve a local input without allowing workspace traversal. */
function resolveLocalPath(filePath: string): string | undefined {
	const workspaceDir = process.env.INNO_WORKSPACE_DIR || process.cwd();
	const root = resolve(workspaceDir);
	const cleaned = isAbsolute(filePath) ? filePath : filePath.replace(/^\/+/, "");
	const resolved = resolve(root, cleaned);
	const rel = relative(root, resolved);
	if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
	if (!existsSync(resolved) || !statSync(resolved).isFile()) return undefined;
	return resolved;
}

/**
 * Agent-facing OCR tool. The shared PaddleOCR client is also used by
 * parse_document and Notebook/L2 archival, avoiding two OCR implementations.
 */
export function createOcrTools(configHolder: ConfigHolder): ToolDefinition[] {
	const tool = defineTool({
		name: "ocr_image",
		label: "图片文字识别 (OCR)",
		description:
			"调用百度 PaddleOCR-VL API 提取图片中的文字并返回 Markdown。" +
			"当当前模型不支持图片识别或图片识别失败时调用。" +
			"filePath 可以是工作区相对路径或 http(s) URL。",
		parameters: Type.Object({
			filePath: Type.String({
				description: "要识别的图片路径（工作区相对路径）或 http(s) URL",
			}),
		}),
		async execute(_toolCallId, params, signal) {
			const filePath = String((params as { filePath?: string }).filePath ?? "").trim();
			if (!filePath) {
				return {
					content: [{ type: "text" as const, text: "请提供 filePath（图片路径或 URL）。" }],
					details: { error: "missing_file_path" } as Record<string, unknown>,
				};
			}

			const config = resolvePaddleOcrConfig(configHolder.current.ocrApi);
			if (!config) {
				return {
					content: [{
						type: "text" as const,
						text: "尚未配置 OCR API token。请在设置面板的「OCR API」卡片填入 token 后重试。",
					}],
					details: { error: "ocr_not_configured" } as Record<string, unknown>,
				};
			}

			const input = isHttpUrl(filePath) ? filePath : resolveLocalPath(filePath);
			if (!input) {
				return {
					content: [{ type: "text" as const, text: `找不到工作区内的图片文件：${filePath}` }],
					details: { error: "file_not_found", filePath } as Record<string, unknown>,
				};
			}

			try {
				const result = await recognizeWithPaddleOcr(input, config, { signal });
				return {
					content: [{ type: "text" as const, text: result.markdown }],
					details: {
						jobId: result.jobId,
						pages: result.pages.length,
						textLength: result.markdown.length,
					} as Record<string, unknown>,
				};
			} catch (error) {
				logger.warn({ err: error, filePath }, "ocr_image: PaddleOCR failed");
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text" as const, text: `OCR 处理失败：${message}` }],
					details: {
						error: error instanceof PaddleOcrError ? error.code.toLowerCase() : "ocr_failed",
						filePath,
						message,
					} as Record<string, unknown>,
				};
			}
		},
	});

	return [tool];
}
