import { extname } from "node:path";

const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
	"application/pdf": ".pdf",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
	"image/bmp": ".bmp",
	"image/gif": ".gif",
	"image/jpeg": ".jpg",
	"image/png": ".png",
	"image/tiff": ".tiff",
	"image/webp": ".webp",
	"text/markdown": ".md",
	"text/plain": ".txt",
};

export function sanitizeUploadedFileName(name: string, fallback: string): string {
	const cleaned = name
		.replace(/[/\\?%*:|"<>]/g, "-")
		.replace(/\s+/g, " ")
		.trim();
	return cleaned || fallback;
}

export function uploadExtension(fileName: string, mimeType: string): string {
	const extension = extname(fileName).toLowerCase();
	if (/^\.[a-z0-9]{1,10}$/.test(extension)) return extension;
	return MIME_EXTENSIONS[mimeType.trim().toLowerCase()] ?? ".bin";
}
