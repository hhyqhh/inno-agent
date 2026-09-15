import type { PersistedQuestion } from "../agent/question-bridge.js";
import type { ChatAttachments } from "./attachments.js";

/**
 * Session summary/metadata types shared between server.ts and the sessions
 * route domain. Extracted verbatim from server.ts during the P2 route split.
 */

export interface SessionMessageSummary {
	role: "user" | "assistant";
	content: string;
	timestamp: number;
	/** PI session-tree entry backing this visible message. User entry IDs let
	 * the Web UI branch immediately before a question when it is edited. */
	entryId?: string;
	parentEntryId?: string | null;
	thinking?: string;
	/** PI's final reason for ending the assistant message. Kept so cold-start
	 * history can classify legacy traces whose sidecar predates terminal events. */
	stopReason?: string;
	tools?: Array<{
		toolCallId: string;
		toolName: string;
		args: unknown;
		contentOffset?: number;
		result?: unknown;
		isError?: boolean;
	}>;
	/** Normalized PI stream records restored from the UI-only trace sidecar. */
	traceEvents?: SessionTraceEvent[];
	traceStartedAt?: string;
	traceFinishedAt?: string;
	channel?: SessionChannel;
	images?: Array<{ previewUrl: string; mimeType: string }>;
	/** Structured chat attachments (bubble bindings + loose files) merged in
	 * from the attachments sidecar; not stored in the session JSONL itself. */
	attachments?: ChatAttachments;
}

export interface SessionTraceEvent {
	eventId?: number;
	traceId?: string;
	occurredAt?: string;
	event: Record<string, unknown>;
}

export type SessionChannel = "cli" | "web" | "feishu" | "qq" | "wechat" | "scheduler" | "unknown";

export const TOPIC_UPGRADE_MESSAGE_THRESHOLD = 6;

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
	/** True while an auto-generated preview is waiting for its richer summary. */
	topicPendingUpgrade?: boolean;
}

export type SessionTopicMetadata = Record<string, { topic: string; updatedAt: string; generated?: boolean; upgraded?: boolean }>;

export type SessionChannelMetadata = Record<string, { channels: SessionChannel[]; origin?: SessionChannel; updatedAt: string }>;

export type SessionQuestionMetadata = Record<string, PersistedQuestion>;

export function mergeChannels(a: SessionChannel[], b: SessionChannel[]): SessionChannel[] {
	return Array.from(new Set([...a, ...b])).sort();
}

/**
 * Select the currently active path from PI's append-only session tree.
 *
 * Branching never deletes abandoned entries: a replacement turn is appended
 * later with its parent pointing to the entry before the edited question. The
 * newest entry is the persisted leaf, so walking its parent chain gives the
 * only history that should be rendered and sent back to the learner.
 */
export function selectActiveSessionEntries(entries: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
	const treeEntries = entries.filter((entry) => entry.type !== "session" && typeof entry.id === "string");
	const leaf = treeEntries.at(-1);
	if (!leaf) return entries;

	const byId = new Map(treeEntries.map((entry) => [entry.id as string, entry]));
	const activeIds = new Set<string>();
	let current: Record<string, unknown> | undefined = leaf;
	while (current && typeof current.id === "string" && !activeIds.has(current.id)) {
		activeIds.add(current.id);
		current = typeof current.parentId === "string" ? byId.get(current.parentId) : undefined;
	}

	return entries.filter((entry) => entry.type === "session" || (typeof entry.id === "string" && activeIds.has(entry.id)));
}
