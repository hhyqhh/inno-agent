import { existsSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import type { LiteParse, ParseResult } from "@llamaindex/liteparse";
import {
	loadRuntimePaddleOcrConfig,
	PaddleOcrError,
	recognizeWithPaddleOcr,
} from "../../ocr/paddle-ocr.js";
import type { ParsedDocumentResult } from "./types.js";

// ============================================================================
// LiteParse Wrapper - Lazy-loaded document parsing
// ============================================================================

const SUPPORTED_EXTENSIONS = new Set([
	".pdf",
	".docx",
	".xlsx",
	".pptx",
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".tiff",
	".tif",
]);

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".tiff", ".tif"]);
const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100MB

export class DocumentParseError extends Error {
	constructor(
		message: string,
		public code: "FILE_NOT_FOUND" | "UNSUPPORTED_FORMAT" | "FILE_TOO_LARGE" | "PARSE_ERROR" | "EMPTY_RESULT",
	) {
		super(message);
		this.name = "DocumentParseError";
	}
}

let parserInstance: LiteParse | null = null;

async function getParser(): Promise<LiteParse> {
	if (!parserInstance) {
		const { LiteParse: LiteParseClass } = await import("@llamaindex/liteparse");
		parserInstance = new LiteParseClass({
			// Images are handled below by the shared PaddleOCR-VL client.
			ocrEnabled: false,
			outputFormat: "text",
			preciseBoundingBox: false,
		});
	}
	return parserInstance;
}

function validateFile(filePath: string): void {
	const resolved = resolve(filePath);

	if (!existsSync(resolved)) {
		throw new DocumentParseError(`文件不存在: ${resolved}`, "FILE_NOT_FOUND");
	}

	const ext = extname(resolved).toLowerCase();
	if (!SUPPORTED_EXTENSIONS.has(ext)) {
		throw new DocumentParseError(
			`不支持的文件格式: ${ext}。支持的格式: ${[...SUPPORTED_EXTENSIONS].join(", ")}`,
			"UNSUPPORTED_FORMAT",
		);
	}

	const stat = statSync(resolved);
	if (stat.size > MAX_FILE_SIZE_BYTES) {
		throw new DocumentParseError(
			`文件过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB)，上限为 100MB`,
			"FILE_TOO_LARGE",
		);
	}
}

async function parseImageWithOcr(
	filePath: string,
	options: { signal?: AbortSignal } = {},
): Promise<ParsedDocumentResult> {
	const config = loadRuntimePaddleOcrConfig();
	if (!config) {
		throw new DocumentParseError(
			"尚未配置百度 PaddleOCR-VL API token，请先在设置面板的「OCR API」中完成配置。",
			"PARSE_ERROR",
		);
	}
	try {
		const result = await recognizeWithPaddleOcr(filePath, config, { signal: options.signal });
		return {
			text: result.markdown,
			pageCount: result.pages.length,
			pages: result.pages.map((text, index) => ({ pageNumber: index + 1, text })),
		};
	} catch (error) {
		throw new DocumentParseError(
			`百度 PaddleOCR-VL 识别失败：${error instanceof Error ? error.message : String(error)}`,
			error instanceof PaddleOcrError && error.code === "EMPTY_RESULT" ? "EMPTY_RESULT" : "PARSE_ERROR",
		);
	}
}

/**
 * Parse a document and extract text content.
 */
export async function parseDocument(
	filePath: string,
	options: { signal?: AbortSignal } = {},
): Promise<ParsedDocumentResult> {
	options.signal?.throwIfAborted();
	const resolved = resolve(filePath);
	validateFile(resolved);

	const ext = extname(resolved).toLowerCase();
	if (IMAGE_EXTENSIONS.has(ext)) {
		return parseImageWithOcr(resolved, options);
	}

	const parser = await getParser();
	let result: ParseResult;

	try {
		result = await parser.parse(resolved, true);
		options.signal?.throwIfAborted();
	} catch (err) {
		throw new DocumentParseError(
			`解析失败: ${err instanceof Error ? err.message : String(err)}`,
			"PARSE_ERROR",
		);
	}

	const text = result.text?.trim() ?? "";
	if (!text) {
		throw new DocumentParseError(
			"文件解析结果为空。可能是扫描件（需要 OCR）或文件内容为空。",
			"EMPTY_RESULT",
		);
	}

	return {
		text,
		pageCount: result.pages.length,
		pages: result.pages.map((p) => ({
			pageNumber: p.pageNum,
			text: p.text,
		})),
	};
}

/** Check if a file extension is supported for parsing. */
export function isSupportedFormat(filePath: string): boolean {
	return SUPPORTED_EXTENSIONS.has(extname(filePath).toLowerCase());
}
