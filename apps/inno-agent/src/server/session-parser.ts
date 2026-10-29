import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { readTextAsync } from "../storage/file-store.js";
import { loadSessionAgentCommandsAsync, mergeSessionAgentCommands } from "./agent-command-store.js";
import { selectActiveSessionEntries, type SessionChannel, type SessionMessageSummary, type SessionSummary } from "./session-model.js";

export interface ParsedSession {
	summary: SessionSummary;
	messages: SessionMessageSummary[];
}

/** Use the same presentation parser for HTTP search and the session endpoints. */
export async function parseSessionFileAsync(dataDir: string, filePath: string): Promise<ParsedSession | null> {
	try {
		const [raw, info] = await Promise.all([readTextAsync(filePath), stat(filePath)]);
		// Warm the owner's cache asynchronously so summary and messages both see
		// original commands, without a synchronous sidecar read during search.
		await loadSessionAgentCommandsAsync(dataDir);
		return parseSessionContent(filePath, raw, info.mtime.toISOString(),
			(messages) => mergeSessionAgentCommands(dataDir, basename(filePath), messages));
	} catch {
		return null;
	}
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const record = part as Record<string, unknown>;
			return record.type === "text" && typeof record.text === "string" ? record.text : "";
		})
		.filter(Boolean)
		.join("\n")
		.trim();
}

function imagesFromContent(content: unknown): Array<{ previewUrl: string; mimeType: string }> {
	if (!Array.isArray(content)) return [];
	const result: Array<{ previewUrl: string; mimeType: string }> = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const record = part as Record<string, unknown>;
		if (
			record.type === "image" &&
			typeof record.data === "string" &&
			typeof record.mimeType === "string"
		) {
			result.push({
				previewUrl: `data:${record.mimeType};base64,${record.data}`,
				mimeType: record.mimeType,
			});
		}
	}
	return result;
}

export function parseSessionContent(filePath: string, raw: string, fallbackTime: string, restoreCommands: (messages: SessionMessageSummary[]) => SessionMessageSummary[]): ParsedSession | null {
	try {
		const lines = raw.split("\n").filter((line) => line.trim().length > 0);
		const entries = selectActiveSessionEntries(lines.map((line) => JSON.parse(line) as Record<string, unknown>));
		const messages: SessionMessageSummary[] = [];
		const channels = new Set<SessionChannel>();
		let createdAt = "";
		let lastMessageAt = "";

		// Aggregator for the in-progress assistant turn. PI splits one assistant
		// turn into multiple JSONL entries (thinking + toolCalls + toolResults
		// + final text), so we merge them back into a single bubble.
		let pendingAssistant: SessionMessageSummary | null = null;
		const finalizeAssistant = () => {
			if (pendingAssistant) {
				messages.push(pendingAssistant);
				pendingAssistant = null;
			}
		};
		const ensureAssistant = (timestamp: number, entryId?: string): SessionMessageSummary => {
			if (!pendingAssistant) {
				pendingAssistant = { role: "assistant", content: "", timestamp, entryId };
			} else if (entryId) {
				pendingAssistant.entryId = entryId;
			}
			return pendingAssistant;
		};

		for (const entry of entries) {
			const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : "";
			if (!createdAt && timestamp) createdAt = timestamp;
			// Detect channel ONLY from structured JSON fields written by the system
			// (message.channel / message.source / message.api / message.model).
			// We intentionally do NOT substring-match the raw line for natural-language
			// keywords like "飞书" / "scheduled" — those appear in ordinary user/assistant
			// text and would falsely tag a web session as a feishu/scheduler session.
			// Verified on unmodified code: a learner asking "飞书的英文名?" (user text)
			// or a reply that merely mentions "飞书" (assistant text) both got mislabeled
			// as channel=feishu even though origin stayed web. The authoritative channel
			// record lives in channels.json (via recordCurrentSessionChannel); this
			// detection is only a best-effort hint for legacy sessions that predate it.
			let entryChannel: SessionChannel | undefined;
			const msgObj = entry.type === "message" && entry.message && typeof entry.message === "object"
				? entry.message as Record<string, unknown>
				: undefined;
			const channelField = typeof msgObj?.channel === "string" ? (msgObj.channel as string) : "";
			const sourceField = typeof msgObj?.source === "string" ? (msgObj.source as string) : "";
			const apiField = typeof msgObj?.api === "string" ? (msgObj.api as string) : "";
			const modelField = typeof msgObj?.model === "string" ? (msgObj.model as string) : "";
			if (channelField === "feishu") {
				channels.add("feishu");
				entryChannel = "feishu";
			}
			if (channelField === "wechat" || channelField === "wecom") {
				channels.add("wechat");
				entryChannel = entryChannel ?? "wechat";
			}
			if (channelField === "qq") {
				channels.add("qq");
				entryChannel = entryChannel ?? "qq";
			}
			if (sourceField === "web" || channelField === "web") {
				channels.add("web");
				entryChannel = entryChannel ?? "web";
			}
			// Scheduler-authored assistant messages carry a synthetic api/model marker.
			if (apiField === "inno-background" || modelField === "scheduler") {
				channels.add("scheduler");
				entryChannel = entryChannel ?? "scheduler";
			}

			if (!msgObj) continue;
			if (timestamp) lastMessageAt = timestamp;
			const message = msgObj;
			const role = message.role;
			const ts = timestamp ? Date.parse(timestamp) : Date.now();

			if (role === "user") {
				finalizeAssistant();
				const content = textFromContent(message.content);
				if (!content) continue;
				const images = imagesFromContent(message.content);
				const msg: SessionMessageSummary = {
					role: "user",
					content,
					timestamp: ts,
					channel: entryChannel,
					entryId: typeof entry.id === "string" ? entry.id : undefined,
					parentEntryId: typeof entry.parentId === "string" ? entry.parentId : null,
				};
				if (images.length > 0) msg.images = images;
				messages.push(msg);
				continue;
			}

			if (role === "assistant") {
				const pending = ensureAssistant(ts, typeof entry.id === "string" ? entry.id : undefined);
				if (entryChannel && !pending.channel) pending.channel = entryChannel;
				const content = message.content;
				if (Array.isArray(content)) {
					for (const part of content) {
						if (!part || typeof part !== "object") continue;
						const block = part as Record<string, unknown>;
						if (block.type === "text" && typeof block.text === "string") {
							pending.content = pending.content
								? `${pending.content}\n${block.text}`
								: block.text;
						} else if (block.type === "thinking" && typeof block.thinking === "string") {
							pending.thinking = pending.thinking
								? `${pending.thinking}\n${block.thinking}`
								: block.thinking;
						} else if (block.type === "toolCall") {
							const toolCallId = typeof block.id === "string" ? block.id : "";
							const toolName = typeof block.name === "string" ? block.name : "tool";
							const args = block.arguments;
							pending.tools = pending.tools ?? [];
							pending.tools.push({
								toolCallId,
								toolName,
								args,
								contentOffset: pending.content.length,
							});
						}
					}
				} else if (typeof content === "string" && content) {
					pending.content = pending.content ? `${pending.content}\n${content}` : content;
				}
				pending.timestamp = ts;
				if (typeof message.stopReason === "string") pending.stopReason = message.stopReason;
				// If this assistant entry ended the turn (stopReason "stop"), finalize.
				if (typeof message.stopReason === "string" && message.stopReason !== "toolUse") {
					finalizeAssistant();
				}
				continue;
			}

			if (role === "toolResult") {
				const pending = ensureAssistant(ts);
				const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : "";
				const toolName = typeof message.toolName === "string" ? message.toolName : "tool";
				// PI keeps a tool's structured details alongside its text content. Keep
				// those details in session history so completed questionnaires can be
				// rendered with the selected options, and the todo widget can rebuild
				// its task list, after the session is reopened.
				const result = (toolName === "ask_user_question" || toolName === "todo") && message.details !== undefined
					? message.details
					: textFromContent(message.content) || message.content;
				const isError = Boolean(message.isError);
				pending.tools = pending.tools ?? [];
				const existing = pending.tools.find((t) => t.toolCallId === toolCallId);
				if (existing) {
					existing.result = result;
					existing.isError = isError;
				} else {
					pending.tools.push({ toolCallId, toolName, args: undefined, result, isError });
				}
				continue;
			}
		}
		finalizeAssistant();

		// Filter out empty assistant entries (no text, no thinking, no tools).
		const filtered = messages.filter((m) =>
			m.role === "user" ? !!m.content : (m.content || m.thinking || (m.tools && m.tools.length > 0)),
		);

		const displayMessages = restoreCommands(filtered);
		const firstUser = displayMessages.find((message) => message.role === "user");
		const latestUser = displayMessages.slice().reverse().find((message) => message.role === "user");
		const firstPrompt = firstUser?.content.trim() ?? "";
		const preview = latestUser?.content.trim() ?? firstPrompt;
		const name = firstPrompt ? (firstPrompt.length > 48 ? `${firstPrompt.slice(0, 45)}...` : firstPrompt) : basename(filePath);
		return {
			summary: {
				id: basename(filePath),
				name,
				createdAt: createdAt || fallbackTime,
				updatedAt: lastMessageAt || createdAt || fallbackTime,
				messageCount: filtered.length,
				preview,
				channels: channels.size > 0 ? Array.from(channels) : [],
			},
			messages: displayMessages,
		};
	} catch (err) {
		return null;
	}
}
