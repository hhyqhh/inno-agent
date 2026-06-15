import { existsSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { parseDocument, DocumentParseError } from "./document-parser.js";
import { readText } from "../../storage/file-store.js";
import { RawArchiveError } from "./archive-errors.js";
import { safeL2RawPath } from "./source-resolver.js";
import type { RawSourceType } from "./types.js";

export function titleFromRawFileName(fileName: string): string {
	const base = basename(fileName, extname(fileName));
	return (
		base
			.replace(/^\d{4}-\d{2}-\d{2}T[\d-]+Z?-/, "")
			.replace(/-\d{4}-\d{2}-\d{2}-[a-f0-9]{6}$/i, "")
			.replace(/-/g, " ")
			.trim() || fileName
	);
}

export function inferSourceTypeFromFileName(fileName: string): RawSourceType | null {
	const ext = extname(fileName).toLowerCase();
	switch (ext) {
		case ".pdf":
			return "pdf";
		case ".doc":
		case ".docx":
			return "word";
		case ".png":
		case ".jpg":
		case ".jpeg":
		case ".gif":
		case ".webp":
		case ".tiff":
			return "image";
		case ".md":
			return "markdown";
		case ".txt":
		case ".csv":
			return "text";
		default:
			return null;
	}
}

async function extractContent(filePath: string, sourceType: RawSourceType): Promise<string> {
	const isFileType = sourceType === "pdf" || sourceType === "word" || sourceType === "image";
	if (isFileType) {
		const parsed = await parseDocument(filePath);
		if (!parsed.text.trim()) {
			throw new RawArchiveError("文件解析结果为空", "EMPTY");
		}
		return parsed.text;
	}
	const text = readText(filePath);
	if (!text.trim()) {
		throw new RawArchiveError("文件内容为空", "EMPTY");
	}
	return text;
}

/** Extract text from a raw file under data/l2/raw/. */
export async function extractRawFileContent(
	l2DataDir: string,
	rawPath: string,
): Promise<{ content: string; sourceType: RawSourceType; fileName: string }> {
	const normalized = rawPath.replace(/^\/+/, "");
	const filePath = safeL2RawPath(l2DataDir, normalized);
	if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
		throw new RawArchiveError("原始文件不存在", "NOT_FOUND");
	}
	const fileName = basename(filePath);
	const sourceType = inferSourceTypeFromFileName(fileName);
	if (!sourceType) {
		throw new RawArchiveError(`不支持的文件格式: ${extname(fileName) || "(无扩展名)"}`, "UNSUPPORTED");
	}
	try {
		const content = await extractContent(filePath, sourceType);
		return { content, sourceType, fileName };
	} catch (err) {
		if (err instanceof RawArchiveError) throw err;
		const msg = err instanceof DocumentParseError ? err.message : String(err);
		throw new RawArchiveError(`文件解析失败: ${msg}`, "PARSE_ERROR");
	}
}
