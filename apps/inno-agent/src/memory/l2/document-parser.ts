import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import type { LiteParse, ParseResult, ScreenshotResult } from "@llamaindex/liteparse";

// ============================================================================
// LiteParse Wrapper — Lazy-loaded document parsing
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
	".md",
	".markdown",
]);

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);

const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100MB

export interface ParsedDocumentResult {
	text: string;
	pageCount: number;
	pages: Array<{ pageNumber: number; text: string }>;
}

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

function parseMarkdownBytes(bytes: Uint8Array): ParsedDocumentResult {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new DocumentParseError("Markdown 文件不是有效的 UTF-8。", "PARSE_ERROR");
	}
	if (!text.trim()) {
		throw new DocumentParseError("Markdown 文件内容为空。", "EMPTY_RESULT");
	}
	return {
		text,
		pageCount: 1,
		pages: [{ pageNumber: 1, text }],
	};
}

function parsedResult(result: ParseResult): ParsedDocumentResult {
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
		pages: result.pages.map((page) => ({
			pageNumber: page.pageNum,
			text: page.text,
		})),
	};
}

/**
 * Parse a document and extract text content.
 */
export async function parseDocument(filePath: string): Promise<ParsedDocumentResult> {
	const resolved = resolve(filePath);
	validateFile(resolved);
	if (MARKDOWN_EXTENSIONS.has(extname(resolved).toLowerCase())) {
		let bytes: Buffer;
		try {
			bytes = readFileSync(resolved);
		} catch {
			throw new DocumentParseError("Markdown 文件无法读取。", "PARSE_ERROR");
		}
		return parseMarkdownBytes(bytes);
	}

	const parser = await getParser();
	let result: ParseResult;

	try {
		result = await parser.parse(resolved, true);
	} catch (err) {
		throw new DocumentParseError(
			`解析失败: ${err instanceof Error ? err.message : String(err)}`,
			"PARSE_ERROR",
		);
	}

	return parsedResult(result);
}

/** Parse an already verified byte snapshot without reopening its original path. */
export async function parseDocumentBytes(displayFilePath: string, bytes: Buffer): Promise<ParsedDocumentResult> {
	const extension = extname(displayFilePath).toLowerCase();
	if (!SUPPORTED_EXTENSIONS.has(extension)) {
		throw new DocumentParseError(
			`不支持的文件格式: ${extension}。支持的格式: ${[...SUPPORTED_EXTENSIONS].join(", ")}`,
			"UNSUPPORTED_FORMAT",
		);
	}
	if (bytes.byteLength > MAX_FILE_SIZE_BYTES) {
		throw new DocumentParseError(
			`文件过大 (${(bytes.byteLength / 1024 / 1024).toFixed(1)}MB)，上限为 100MB`,
			"FILE_TOO_LARGE",
		);
	}
	if (MARKDOWN_EXTENSIONS.has(extension)) return parseMarkdownBytes(bytes);

	const parser = await getParser();
	const snapshot = Buffer.from(bytes);
	let privateTempDir: string | undefined;
	try {
		if (extension === ".pdf") {
			return parsedResult(await parser.parse(snapshot, true));
		}

		privateTempDir = mkdtempSync(join(tmpdir(), "inno-document-"));
		const privateTempPath = join(privateTempDir, `input${extension}`);
		writeFileSync(privateTempPath, snapshot, { flag: "wx", mode: 0o600 });
		return parsedResult(await parser.parse(privateTempPath, true));
	} catch (error) {
		if (error instanceof DocumentParseError) throw error;
		throw new DocumentParseError("Document parsing failed.", "PARSE_ERROR");
	} finally {
		if (privateTempDir !== undefined) {
			try {
				rmSync(privateTempDir, {
					recursive: true,
					force: true,
					maxRetries: 3,
					retryDelay: 50,
				});
			} catch {
				// Temporary conversion input cleanup must not mask the parse result.
			}
		}
	}
}

/**
 * Generate PNG screenshots of document pages.
 */
export async function screenshotDocument(filePath: string, pageNumbers?: number[]): Promise<ScreenshotResult[]> {
	const resolved = resolve(filePath);
	validateFile(resolved);

	const parser = await getParser();

	try {
		return await parser.screenshot(resolved, pageNumbers, true);
	} catch (err) {
		throw new DocumentParseError(
			`截图生成失败: ${err instanceof Error ? err.message : String(err)}`,
			"PARSE_ERROR",
		);
	}
}

/** Check if a file extension is supported for parsing. */
export function isSupportedFormat(filePath: string): boolean {
	return SUPPORTED_EXTENSIONS.has(extname(filePath).toLowerCase());
}
