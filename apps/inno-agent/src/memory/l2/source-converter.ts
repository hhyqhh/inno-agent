import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ensureDir, writeText } from "../../storage/file-store.js";
import type { RawSourceType } from "./types.js";
import { logger } from "../../logger.js";
import { normalizeMarkdownForMilkdown } from "./markdown-normalizer.js";

/**
 * Convert raw content to extracted markdown and save to data/l2/extracted/.
 * Returns the relative path from l2DataDir.
 */
export function convertToExtracted(
	l2DataDir: string,
	title: string,
	content: string,
	sourceType: RawSourceType,
): string {
	const markdown = convertContent(content, sourceType);
	const dir = join(l2DataDir, "extracted");
	ensureDir(dir);
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 50);
	const filename = `${slug}-${randomUUID().slice(0, 6)}.md`;
	writeText(join(dir, filename), markdown);
	return join("extracted", filename);
}

function convertContent(content: string, sourceType: RawSourceType): string {
	switch (sourceType) {
		case "text":
			return content;
		case "markdown":
			return normalizeMarkdownForMilkdown(content);
		case "conversation":
			return normalizeMarkdownForMilkdown(formatConversation(content));
		case "pdf":
		case "word":
		case "image":
			// 文本已由 LiteParse 在上游提取，此处直接透传
			return content;
	}
}

/**
 * Format a conversation snippet into readable markdown.
 * Supports JSON array [{role, content}] or plain text.
 */
function formatConversation(content: string): string {
	try {
		const messages = JSON.parse(content) as Array<{ role: string; content: string }>;
		if (Array.isArray(messages)) {
			const formatted = messages
				.filter((m) => m && typeof m.role === "string" && typeof m.content === "string")
				.map((m) => `**${m.role}**: ${m.content}`)
				.join("\n\n");
			if (formatted) return formatted;
		}
	} catch (err) {
		logger.warn({ err }, "failed to parse conversation JSON, treating as plain text");
		// Not JSON, treat as plain text conversation
	}
	return content;
}
