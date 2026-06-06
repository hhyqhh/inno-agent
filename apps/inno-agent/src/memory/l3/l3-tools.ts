/**
 * L3 cross-conversation memory integration.
 *
 * Owns the lazily-opened L3 store and exposes:
 * - {@link createL3Tools}: an `l3_recall` tool the agent can call to search
 *   past conversations on demand.
 * - {@link recallForInjection}: threshold-gated retrieval used by the
 *   before_agent_start hook to auto-inject relevant history.
 * - {@link indexCurrentSession} / {@link backfillIndex}: keep the index fresh.
 *
 * Everything degrades to a no-op when node:sqlite is unavailable so the agent
 * keeps working on older runtimes.
 */

import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { openL3Store, type L3Store } from "./sqlite-store.js";
import { indexAllSessions, indexSession } from "./indexer.js";
import { recall, formatRecallForPrompt, type RecallResult } from "./recall.js";
import { join } from "node:path";

/**
 * Holds the singleton store for a runtime. The store opens lazily on first use
 * so startup cost is only paid when L3 is actually exercised.
 */
export class L3Memory {
	private store: L3Store | null = null;
	private opened = false;
	private backfilled = false;

	constructor(
		private readonly l3DataDir: string,
		private readonly sessionDir: string,
	) {}

	private async ensureStore(): Promise<L3Store | null> {
		if (this.opened) return this.store;
		this.opened = true;
		this.store = await openL3Store(this.l3DataDir);
		if (!this.store) {
			console.warn("[L3] node:sqlite unavailable — cross-conversation recall disabled.");
		}
		return this.store;
	}

	/** One-time backfill of all existing sessions (cheap: skips unchanged files). */
	async backfill(): Promise<void> {
		if (this.backfilled) return;
		const store = await this.ensureStore();
		if (!store) return;
		this.backfilled = true;
		try {
			const { sessions, chunks } = indexAllSessions(store, this.sessionDir);
			if (sessions > 0) console.log(`[L3] indexed ${chunks} chunks from ${sessions} session(s).`);
		} catch (err) {
			console.warn(`[L3] backfill failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** Incrementally (re)index a single session file by id. */
	async indexById(sessionId: string): Promise<void> {
		if (!sessionId) return;
		const store = await this.ensureStore();
		if (!store) return;
		try {
			indexSession(store, join(this.sessionDir, sessionId));
		} catch (err) {
			console.warn(`[L3] index ${sessionId} failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** Threshold-gated recall for prompt injection. */
	async recall(query: string, excludeSessionId?: string): Promise<RecallResult[]> {
		const store = await this.ensureStore();
		if (!store) return [];
		return recall(store, query, { excludeSessionId });
	}
}

/**
 * Register the `l3_recall` tool. The agent calls this to deliberately search
 * its memory of past conversations (separate from the automatic injection).
 */
export function createL3Tools(memory: L3Memory, getCurrentSessionId?: () => string): ToolDefinition[] {
	const recallTool = defineTool({
		name: "l3_recall",
		label: "回忆历史对话",
		description:
			"在过往会话记录（L3）中按语义/关键词检索，召回与当前问题相关的历史对话片段。" +
			"当用户提到「上次」「之前聊过」「我们讨论过」「你还记得吗」等指向过去对话的线索，" +
			"或你需要跨对话的上下文来连续地帮助用户时调用。结果带相关度，仅返回足够相关的片段。",
		parameters: Type.Object({
			query: Type.String({
				description: "检索关键词或问题，如「上次说的学习计划」「之前的 Python 报错」。",
			}),
			limit: Type.Optional(
				Type.Number({ description: "最多返回片段数，默认 4。", default: 4 }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const query = String((params as { query?: string }).query ?? "").trim();
			const limit = Number((params as { limit?: number }).limit ?? 4);
			if (!query) {
				return {
					content: [{ type: "text" as const, text: "请提供检索关键词或问题。" }],
					details: { results: 0 },
				};
			}
			// Resolve current session id from ctx (preferred) or the provided getter.
			let current = "";
			try {
				const sid = ctx.sessionManager.getSessionFile?.();
				if (sid) current = sid.split(/[\\/]/).pop() ?? "";
			} catch {
				// ignore
			}
			if (!current && getCurrentSessionId) {
				try {
					current = getCurrentSessionId();
				} catch {
					// ignore
				}
			}

			const results = (await memory.recall(query, current || undefined)).slice(0, Math.max(1, limit));
			if (results.length === 0) {
				return {
					content: [{ type: "text" as const, text: `未在历史对话中找到与「${query}」足够相关的内容。` }],
					details: { results: 0 },
				};
			}
			const body = formatRecallForPrompt(results);
			return {
				content: [{ type: "text" as const, text: body }],
				details: { results: results.length },
			};
		},
	});

	return [recallTool];
}

export { formatRecallForPrompt } from "./recall.js";
