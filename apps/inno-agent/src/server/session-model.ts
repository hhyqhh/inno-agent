import type { PersistedQuestion } from "../agent/question-bridge.js";

/**
 * Session summary/metadata types shared between server.ts and the sessions
 * route domain. Extracted verbatim from server.ts during the P2 route split.
 */

export interface SessionMessageSummary {
	id?: string;
	role: "user" | "assistant";
	content: string;
	timestamp: number;
	thinking?: string;
	tools?: Array<{
		toolCallId: string;
		toolName: string;
		args: unknown;
		contentOffset?: number;
		result?: unknown;
		isError?: boolean;
	}>;
	channel?: SessionChannel;
	images?: Array<{ previewUrl: string; mimeType: string }>;
}

export type SessionChannel = "cli" | "web" | "feishu" | "qq" | "wechat" | "scheduler" | "unknown";

export interface SessionSummary {
	id: string;
	name: string;
	createdAt: string;
	updatedAt: string;
	messageCount: number;
	preview: string;
	channels: SessionChannel[];
	/** Immutable birthplace of the session (web/cli/feishu/wechat/scheduler). */
	origin?: SessionChannel;
	/** True once a topic (manual or auto-generated) has been recorded. */
	hasTopic?: boolean;
}

export type SessionTopicMetadata = Record<string, { topic: string; updatedAt: string; generated?: boolean; upgraded?: boolean }>;

export type SessionChannelMetadata = Record<string, { channels: SessionChannel[]; origin?: SessionChannel; updatedAt: string }>;

export type SessionQuestionMetadata = Record<string, PersistedQuestion>;

export function mergeChannels(a: SessionChannel[], b: SessionChannel[]): SessionChannel[] {
	return Array.from(new Set([...a, ...b])).sort();
}
