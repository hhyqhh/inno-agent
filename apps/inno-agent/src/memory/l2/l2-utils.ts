import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, extname, join } from "node:path";

const TAG_SEPARATOR = /[\s,\uFF0C;\uFF1B\u3001|]+/;

export function splitTagText(value: string): string[] {
	return value
		.split(TAG_SEPARATOR)
		.map((tag) => tag.trim())
		.filter(Boolean);
}

export function canonicalizeTag(tag: string): string {
	return tag.trim().replace(/\s+/g, " ").toLowerCase();
}

export function normalizeTagList(tags: string[]): string[] {
	const byKey = new Map<string, string>();
	for (const rawTag of tags) {
		for (const displayName of splitTagText(rawTag)) {
			byKey.set(canonicalizeTag(displayName), displayName);
		}
	}
	return [...byKey.values()];
}

export function slugifyTitle(title: string, maxLength = 50, fallback?: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, maxLength);
	if (slug) return slug;
	return fallback ?? createHash("sha256").update(title).digest("hex").slice(0, 12);
}

export function quoteYamlScalar(value: string): string {
	if (/[:\[\]{},#&*!|>'"%@`\n]/.test(value) || value.trim() !== value || value === "") {
		return JSON.stringify(value);
	}
	return value;
}

export function uniqueUploadName(
	dir: string,
	fileName: string,
	mimeType: string,
	fallback = "upload",
): string {
	const safeName = fileName
		.replace(/[/\\?%*:|"<>]/g, "-")
		.replace(/\s+/g, " ")
		.trim() || fallback;
	const existingExtension = extname(safeName);
	const extension = existingExtension || extensionForMimeType(mimeType);
	const base = basename(safeName, extension).slice(0, 120) || fallback;
	let candidate = `${base}${extension}`;
	let index = 1;
	while (existsSync(join(dir, candidate))) {
		index += 1;
		candidate = `${base} (${index})${extension}`;
	}
	return candidate;
}

function extensionForMimeType(mimeType: string): string {
	if (mimeType === "application/pdf") return ".pdf";
	if (mimeType.includes("wordprocessingml")) return ".docx";
	if (mimeType.includes("spreadsheetml")) return ".xlsx";
	if (mimeType.includes("presentationml")) return ".pptx";
	if (mimeType === "text/markdown") return ".md";
	if (mimeType.startsWith("image/")) return `.${mimeType.slice("image/".length).replace("jpeg", "jpg")}`;
	if (mimeType.startsWith("text/")) return ".txt";
	return ".bin";
}
