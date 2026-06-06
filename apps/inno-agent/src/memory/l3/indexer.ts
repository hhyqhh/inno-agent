/**
 * L3 session indexer.
 *
 * Reads PI session JSONL files from the session directory, extracts user and
 * assistant text into retrievable chunks, and upserts them into the L3 store.
 *
 * PI owns the JSONL format (external package), so we only read it. Each line is
 * an event; we care about `message` events with role user/assistant and pull
 * their text blocks (thinking and toolCall noise are skipped — they bloat the
 * index and rarely help cross-conversation recall).
 *
 * Indexing is incremental at the file level: a session is re-indexed only when
 * its mtime changes. Chunk ids are stable (`${sessionId}:${ordinal}`) and
 * upserts are idempotent, so a full re-index of a changed file is safe and
 * cheap at personal scale.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { L3Chunk, L3Store } from "./sqlite-store.js";

/** Minimum characters for a chunk to be worth indexing. */
const MIN_CHUNK_CHARS = 8;
/** Cap a single chunk so one huge message can't dominate the index. */
const MAX_CHUNK_CHARS = 4000;

interface ExtractedMessage {
	role: "user" | "assistant";
	text: string;
	ts: number;
}

/** Pull plain text out of a PI message content value (array of blocks or string). */
function textFromMessageContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as Record<string, unknown>;
		// Index user-visible text only; skip thinking / toolCall / toolResult.
		if (block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		}
	}
	return parts.join("\n").trim();
}

/**
 * Parse a session JSONL file into ordered user/assistant text messages.
 * Consecutive assistant text fragments (PI splits a turn across several lines)
 * are merged into one message per turn boundary.
 */
function extractMessages(filePath: string): ExtractedMessage[] {
	const raw = readFileSync(filePath, "utf-8");
	const lines = raw.split("\n").filter((l) => l.trim().length > 0);
	const out: ExtractedMessage[] = [];

	let pendingAssistant: { text: string; ts: number } | null = null;
	const flushAssistant = () => {
		if (pendingAssistant && pendingAssistant.text.trim()) {
			out.push({ role: "assistant", text: pendingAssistant.text.trim(), ts: pendingAssistant.ts });
		}
		pendingAssistant = null;
	};

	for (const line of lines) {
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
		const message = entry.message as Record<string, unknown>;
		const role = message.role;
		const tsStr = typeof entry.timestamp === "string" ? entry.timestamp : "";
		const ts = tsStr ? Date.parse(tsStr) : Date.now();

		if (role === "user") {
			flushAssistant();
			const text = textFromMessageContent(message.content);
			if (text) out.push({ role: "user", text, ts });
			continue;
		}
		if (role === "assistant") {
			const text = textFromMessageContent(message.content);
			if (text) {
				if (!pendingAssistant) pendingAssistant = { text, ts };
				else pendingAssistant.text += `\n${text}`;
				pendingAssistant.ts = ts;
			}
			// Turn ended (not a tool-use continuation) → flush.
			if (typeof message.stopReason === "string" && message.stopReason !== "toolUse") {
				flushAssistant();
			}
			continue;
		}
		// toolResult and other roles are ignored for L3 indexing.
	}
	flushAssistant();
	return out;
}

/** Split overly long text into bounded chunks on paragraph/sentence edges. */
function splitLong(text: string): string[] {
	if (text.length <= MAX_CHUNK_CHARS) return [text];
	const pieces: string[] = [];
	let rest = text;
	while (rest.length > MAX_CHUNK_CHARS) {
		// Prefer a break near the limit (newline, then space).
		const window = rest.slice(0, MAX_CHUNK_CHARS);
		const nl = window.lastIndexOf("\n");
		const sp = window.lastIndexOf(" ");
		const cut = nl > MAX_CHUNK_CHARS * 0.6 ? nl : sp > MAX_CHUNK_CHARS * 0.6 ? sp : MAX_CHUNK_CHARS;
		pieces.push(rest.slice(0, cut).trim());
		rest = rest.slice(cut).trim();
	}
	if (rest) pieces.push(rest);
	return pieces.filter((p) => p.length > 0);
}

/** Build stable chunks for a single session file. */
function buildChunks(sessionId: string, messages: ExtractedMessage[]): L3Chunk[] {
	const chunks: L3Chunk[] = [];
	let ordinal = 0;
	for (const m of messages) {
		for (const piece of splitLong(m.text)) {
			if (piece.length < MIN_CHUNK_CHARS) {
				ordinal++;
				continue;
			}
			chunks.push({
				id: `${sessionId}:${ordinal}`,
				sessionId,
				role: m.role,
				text: piece,
				ts: m.ts,
			});
			ordinal++;
		}
	}
	return chunks;
}

/**
 * Index a single session file into the store. Skips work when the file's mtime
 * is unchanged since the last index. Returns the number of chunks written
 * (0 when skipped or empty).
 */
export function indexSession(store: L3Store, filePath: string): number {
	let stat;
	try {
		stat = statSync(filePath);
	} catch {
		return 0;
	}
	if (!stat.isFile() || stat.size === 0) return 0;

	const sessionId = basename(filePath);
	const mtimeMs = Math.floor(stat.mtimeMs);
	const prev = store.getIndexState(sessionId);
	if (prev && prev.lastMtimeMs === mtimeMs) return 0; // unchanged

	let messages: ExtractedMessage[];
	try {
		messages = extractMessages(filePath);
	} catch (err) {
		console.warn(`[L3] failed to parse ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
		return 0;
	}

	const chunks = buildChunks(sessionId, messages);
	// Re-index cleanly: drop old chunks for this session, then insert current.
	store.deleteSession(sessionId);
	if (chunks.length > 0) store.upsertChunks(chunks);
	store.setIndexState(sessionId, stat.size, mtimeMs, chunks.length);
	return chunks.length;
}

/**
 * Backfill the store from all session files in the directory. Returns a summary
 * of how many sessions were (re)indexed and total chunks written.
 */
export function indexAllSessions(store: L3Store, sessionDir: string): { sessions: number; chunks: number } {
	let entries: string[];
	try {
		entries = readdirSync(sessionDir);
	} catch {
		return { sessions: 0, chunks: 0 };
	}
	let sessions = 0;
	let chunks = 0;
	for (const name of entries) {
		if (!name.endsWith(".jsonl")) continue;
		const written = indexSession(store, join(sessionDir, name));
		if (written > 0) {
			sessions++;
			chunks += written;
		}
	}
	return { sessions, chunks };
}
