import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import type { LiteParse, ParseResult, ScreenshotResult } from "@llamaindex/liteparse";

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

function readUInt24LE(buffer: Buffer, offset: number): number {
	return buffer[offset] + (buffer[offset + 1] << 8) + (buffer[offset + 2] << 16);
}

function getPngDimensions(buffer: Buffer): { width: number; height: number } | undefined {
	if (buffer.length < 24) return undefined;
	const signature = "89504e470d0a1a0a";
	if (buffer.subarray(0, 8).toString("hex") !== signature) return undefined;
	return {
		width: buffer.readUInt32BE(16),
		height: buffer.readUInt32BE(20),
	};
}

function getGifDimensions(buffer: Buffer): { width: number; height: number } | undefined {
	if (buffer.length < 10) return undefined;
	const header = buffer.subarray(0, 6).toString("ascii");
	if (header !== "GIF87a" && header !== "GIF89a") return undefined;
	return {
		width: buffer.readUInt16LE(6),
		height: buffer.readUInt16LE(8),
	};
}

function getJpegDimensions(buffer: Buffer): { width: number; height: number } | undefined {
	if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return undefined;
	let offset = 2;
	const sofMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
	while (offset + 4 < buffer.length) {
		while (buffer[offset] === 0xff) offset += 1;
		const marker = buffer[offset];
		offset += 1;
		if (marker === 0xd9 || marker === 0xda) break;
		const length = buffer.readUInt16BE(offset);
		if (length < 2 || offset + length > buffer.length) break;
		if (sofMarkers.has(marker) && offset + 7 < buffer.length) {
			return {
				height: buffer.readUInt16BE(offset + 3),
				width: buffer.readUInt16BE(offset + 5),
			};
		}
		offset += length;
	}
	return undefined;
}

function getWebpDimensions(buffer: Buffer): { width: number; height: number } | undefined {
	if (buffer.length < 30) return undefined;
	if (buffer.subarray(0, 4).toString("ascii") !== "RIFF" || buffer.subarray(8, 12).toString("ascii") !== "WEBP") {
		return undefined;
	}
	const chunk = buffer.subarray(12, 16).toString("ascii");
	if (chunk === "VP8X" && buffer.length >= 30) {
		return {
			width: readUInt24LE(buffer, 24) + 1,
			height: readUInt24LE(buffer, 27) + 1,
		};
	}
	return undefined;
}

function getTiffDimensions(buffer: Buffer): { width: number; height: number } | undefined {
	if (buffer.length < 8) return undefined;
	const endian = buffer.subarray(0, 2).toString("ascii");
	const little = endian === "II";
	if (!little && endian !== "MM") return undefined;
	const readUInt16 = (offset: number) => little ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
	const readUInt32 = (offset: number) => little ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
	if (readUInt16(2) !== 42) return undefined;
	const ifdOffset = readUInt32(4);
	if (ifdOffset + 2 > buffer.length) return undefined;
	const count = readUInt16(ifdOffset);
	let width: number | undefined;
	let height: number | undefined;
	for (let i = 0; i < count; i += 1) {
		const entry = ifdOffset + 2 + i * 12;
		if (entry + 12 > buffer.length) break;
		const tag = readUInt16(entry);
		const type = readUInt16(entry + 2);
		const value = type === 3 ? readUInt16(entry + 8) : readUInt32(entry + 8);
		if (tag === 256) width = value;
		if (tag === 257) height = value;
	}
	return width && height ? { width, height } : undefined;
}

function getImageDimensions(buffer: Buffer, ext: string): { width: number; height: number } | undefined {
	switch (ext) {
		case ".png":
			return getPngDimensions(buffer);
		case ".jpg":
		case ".jpeg":
			return getJpegDimensions(buffer);
		case ".gif":
			return getGifDimensions(buffer);
		case ".webp":
			return getWebpDimensions(buffer);
		case ".tif":
		case ".tiff":
			return getTiffDimensions(buffer);
		default:
			return undefined;
	}
}

function parseImageMetadata(filePath: string): ParsedDocumentResult {
	const buffer = readFileSync(filePath);
	const stat = statSync(filePath);
	const ext = extname(filePath).toLowerCase();
	const dimensions = getImageDimensions(buffer, ext);
	const sha256 = createHash("sha256").update(buffer).digest("hex");
	const dimensionText = dimensions ? `${dimensions.width} x ${dimensions.height}` : "未知";
	const text = [
		`# 图片资料：${basename(filePath)}`,
		"",
		"## 文件信息",
		`- 文件名：${basename(filePath)}`,
		`- 格式：${ext.replace(".", "").toUpperCase() || "未知"}`,
		`- 大小：${stat.size} bytes`,
		`- 尺寸：${dimensionText}`,
		`- SHA-256：${sha256}`,
		`- 本地路径：${filePath}`,
		"",
		"## 提取说明",
		"该图片已作为原始资料保存到 L2 raw 层。当前环境未执行 OCR 或视觉语义识别，因此正文只包含可稳定读取的文件元数据；如需更完整的知识摘要，请在归档时补充图片内容说明，或使用具备视觉能力的模型分析后再归档。",
	].join("\n");
	return {
		text,
		pageCount: 1,
		pages: [{ pageNumber: 1, text }],
	};
}

/**
 * Parse a document and extract text content.
 */
export async function parseDocument(filePath: string): Promise<ParsedDocumentResult> {
	const resolved = resolve(filePath);
	validateFile(resolved);

	const ext = extname(resolved).toLowerCase();
	if (IMAGE_EXTENSIONS.has(ext)) {
		return parseImageMetadata(resolved);
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
