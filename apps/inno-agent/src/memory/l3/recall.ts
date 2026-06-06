/**
 * L3 recall service.
 *
 * High-level cross-conversation retrieval on top of the L3 store. Applies a
 * relevance threshold so the agent only ever sees genuinely related history
 * (per the design goal: "带阈值，不要什么都检索"), excludes the active
 * session, dedups, and renders an injectable prompt section.
 *
 * Lexical (FTS5/BM25) is the only backend today; the vector cosine path is
 * reserved behind the same interface for when an embedding provider is added.
 */

import { segmentForFts, type L3SearchHit, type L3Store } from "./sqlite-store.js";

export interface RecallOptions {
	/**
	 * Minimum query-token coverage to keep a hit (0..1): the fraction of the
	 * query's distinct tokens that appear in the chunk. Default 0.5 — at least
	 * half the query terms must be present, so unrelated turns inject nothing.
	 */
	threshold?: number;
	/** Max snippets to return after filtering. Default 4. */
	limit?: number;
	/** Session id to exclude from results (the active conversation). */
	excludeSessionId?: string;
}

export interface RecallResult {
	sessionId: string;
	role: "user" | "assistant";
	text: string;
	ts: number;
	/** Query-token coverage in [0,1]; higher = more of the query was matched. */
	score: number;
}

const DEFAULT_THRESHOLD = 0.5;
const DEFAULT_LIMIT = 4;
/** Trim each injected snippet so the prompt stays compact. */
const SNIPPET_MAX_CHARS = 320;

/** Distinct lexical tokens for a string, using the same segmentation as the index. */
function tokenize(input: string): string[] {
	return Array.from(new Set(segmentForFts(input).split(" ").filter((t) => t.length > 0)));
}

/**
 * Whether a query is substantial enough to search. Rejects single CJK
 * characters and lone ASCII letters (too noisy after bigram segmentation),
 * while allowing 2-char CJK words like 飞机 and ASCII words like Python.
 */
function isQuerySearchable(query: string): boolean {
	const cjkChars = (query.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) ?? []).length;
	const asciiWords = (query.match(/[a-zA-Z0-9]{2,}/g) ?? []).length;
	return cjkChars >= 2 || asciiWords >= 1;
}

/**
 * Absolute relevance: fraction of the query's distinct tokens that occur in the
 * chunk. This is comparable across queries (unlike within-result bm25
 * normalization), so a fixed threshold reliably gates "is this related at all".
 */
function coverage(queryTokens: string[], chunkText: string): number {
	if (queryTokens.length === 0) return 0;
	const chunkTokens = new Set(segmentForFts(chunkText).split(" ").filter(Boolean));
	let present = 0;
	for (const t of queryTokens) if (chunkTokens.has(t)) present++;
	return present / queryTokens.length;
}

/**
 * Retrieve relevant past-conversation snippets for a query. Returns [] when the
 * store is unavailable, the query is too short, or nothing clears the
 * threshold — callers can then inject nothing.
 */
export function recall(store: L3Store | null, query: string, opts: RecallOptions = {}): RecallResult[] {
	if (!store) return [];
	const q = (query ?? "").trim();
	if (!q || !isQuerySearchable(q)) return [];

	const queryTokens = tokenize(q);
	if (queryTokens.length === 0) return [];

	const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
	const limit = opts.limit ?? DEFAULT_LIMIT;

	// Over-fetch candidates by bm25, then gate by absolute token coverage.
	const raw: L3SearchHit[] = store.searchLexical(q, Math.max(limit * 4, 16));

	const scored = raw
		.map((hit) => ({ hit, score: coverage(queryTokens, hit.text) }))
		.filter(({ score }) => score >= threshold)
		// Higher coverage first; bm25 (more negative) breaks ties.
		.sort((a, b) => (b.score - a.score) || (a.hit.bm25 - b.hit.bm25));

	const seen = new Set<string>();
	const results: RecallResult[] = [];
	for (const { hit, score } of scored) {
		if (opts.excludeSessionId && hit.sessionId === opts.excludeSessionId) continue;
		const key = hit.text.replace(/\s+/g, " ").trim().slice(0, 80).toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		results.push({
			sessionId: hit.sessionId,
			role: hit.role,
			text: hit.text,
			ts: hit.ts,
			score,
		});
		if (results.length >= limit) break;
	}
	return results;
}

function clip(text: string): string {
	const t = text.replace(/\s+/g, " ").trim();
	return t.length > SNIPPET_MAX_CHARS ? `${t.slice(0, SNIPPET_MAX_CHARS)}…` : t;
}

function formatWhen(ts: number): string {
	if (!Number.isFinite(ts) || ts <= 0) return "";
	try {
		return new Date(ts).toISOString().slice(0, 10);
	} catch {
		return "";
	}
}

/**
 * Render recall results as an injectable system-prompt section. Returns "" when
 * there is nothing to inject, so the caller can append unconditionally.
 */
export function formatRecallForPrompt(results: RecallResult[]): string {
	if (results.length === 0) return "";
	const lines: string[] = [
		"# 相关历史对话（来自过往会话，仅供参考）",
		"",
		"以下片段来自你与该用户的早期对话，按相关度排序。若与当前问题相关可参考，不相关请忽略：",
		"",
	];
	results.forEach((r, i) => {
		const who = r.role === "user" ? "用户" : "你";
		const when = formatWhen(r.ts);
		const meta = [who, when].filter(Boolean).join(" · ");
		lines.push(`${i + 1}. [${meta}] ${clip(r.text)}`);
	});
	return lines.join("\n");
}
