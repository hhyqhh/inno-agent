import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import { writeText } from "../../storage/file-store.js";
import type { L2Memory } from "./l2-memory.js";
import { normalizeMarkdownForMilkdown } from "./markdown-normalizer.js";
import { archiveRawFile, type ArchiveRawResult } from "./sources-service.js";

export interface ConversationArchiveMessage {
	id?: string;
	role: "user" | "assistant";
	content: string;
	timestamp: number;
}

export interface ArchiveConversationOptions {
	sessionId: string;
	title: string;
	tags?: string[];
	messageIds?: string[];
	messages: ConversationArchiveMessage[];
	model?: Model<any>;
	modelRegistry?: ModelRegistry;
	memory?: L2Memory;
}

function yamlQuote(value: string): string {
	return JSON.stringify(value);
}

function slugifyTitle(title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 50);
	return slug || createHash("sha256").update(title).digest("hex").slice(0, 12);
}

function formatTime(timestamp: number): string {
	const date = new Date(timestamp);
	return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function formatConversationMarkdown(options: {
	title: string;
	sessionId: string;
	messageIds: string[];
	messages: ConversationArchiveMessage[];
	archivedAt: string;
	contentHash: string;
}): string {
	const lines = [
		"---",
		"notebook_type: conversation",
		`session_id: ${yamlQuote(options.sessionId)}`,
		...(options.messageIds.length > 0
			? ["message_ids:", ...options.messageIds.map((id) => `  - ${yamlQuote(id)}`)]
			: ["message_ids: []"]),
		`archived_at: ${yamlQuote(options.archivedAt)}`,
		`sha256: ${yamlQuote(options.contentHash)}`,
		"source_type: conversation",
		`ingested: ${yamlQuote(options.archivedAt.slice(0, 10))}`,
		"---",
		"",
		`# 对话归档：${options.title}`,
		"",
		"## 消息记录",
		"",
	];
	for (const message of options.messages) {
		const roleLabel = message.role === "user" ? "User" : "Assistant";
		lines.push(`### ${roleLabel} · ${formatTime(message.timestamp)}`, "", message.content.trim(), "");
	}
	return normalizeMarkdownForMilkdown(lines.join("\n"));
}

export async function archiveConversation(
	l2DataDir: string,
	options: ArchiveConversationOptions,
): Promise<ArchiveRawResult> {
	const selectedIds = new Set((options.messageIds ?? []).map((id) => id.trim()).filter(Boolean));
	const selectedMessages = selectedIds.size > 0
		? options.messages.filter((message) => message.id && selectedIds.has(message.id))
		: options.messages;
	if (selectedMessages.length === 0) throw new Error("没有可归档的对话消息");

	const title = options.title.trim() || "Conversation";
	const rawBody = selectedMessages
		.map((message) => `${message.role}:${message.id ?? ""}:${message.timestamp}:${message.content}`)
		.join("\n\n");
	const contentHash = createHash("sha256").update(rawBody).digest("hex");
	const archivedAt = new Date().toISOString();
	const messageIds = selectedMessages.map((message) => message.id).filter((id): id is string => Boolean(id));
	const markdown = formatConversationMarkdown({
		title,
		sessionId: options.sessionId,
		messageIds,
		messages: selectedMessages,
		archivedAt,
		contentHash,
	});

	const fileName = `${archivedAt.slice(0, 10)}-${slugifyTitle(title)}-${randomUUID().slice(0, 8)}.md`;
	const rawPath = join("raw", "conversations", fileName).replace(/\\/g, "/");
	writeText(join(l2DataDir, rawPath), markdown);

	return archiveRawFile(l2DataDir, rawPath, {
		title,
		tags: options.tags?.map((tag) => tag.trim()).filter(Boolean),
		model: options.model,
		modelRegistry: options.modelRegistry,
		memory: options.memory,
	});
}
