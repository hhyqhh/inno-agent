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

import { logger } from "../../logger.js";
import { readdir, stat as statFile } from "node:fs/promises";
import { readJsonlAsync } from "../../storage/file-store.js";
import { resolveContainedPathAsync } from "../../utils/path-safety.js";
import { basename } from "node:path";
import { selectActiveSessionEntries } from "../../server/session-model.js";
import type { L3Chunk, L3Store } from "./sqlite-store.js";

/** Bump when the indexed conversation branch/message metadata changes. */
const SESSION_INDEX_VERSION = 3;
/** Cap a single chunk so one huge message can't dominate the index. */
const MAX_CHUNK_CHARS = 4000;

interface ExtractedMessage {
	role: "user" | "assistant";
	text: string;
	ts: number;
	entryId?: string;
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
function extractMessages(entries: Record<string, unknown>[]): ExtractedMessage[] {
	const out: ExtractedMessage[] = [];

	let pendingAssistant: { text: string; ts: number; entryId?: string } | null = null;
	const flushAssistant = () => {
		if (pendingAssistant && pendingAssistant.text.trim()) {
			out.push({ role: "assistant", text: pendingAssistant.text.trim(), ts: pendingAssistant.ts, entryId: pendingAssistant.entryId });
		}
		pendingAssistant = null;
	};

	for (const entry of selectActiveSessionEntries(entries)) {
		if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
		const message = entry.message as Record<string, unknown>;
		const entryId = typeof entry.id === "string" ? entry.id : undefined;
		const role = message.role;
		const tsStr = typeof entry.timestamp === "string" ? entry.timestamp : "";
		const ts = tsStr ? Date.parse(tsStr) : Date.now();

		if (role === "user") {
			flushAssistant();
			const text = textFromMessageContent(message.content);
			if (text) out.push({ role: "user", text, ts, entryId });
			continue;
		}
		if (role === "assistant") {
			const text = textFromMessageContent(message.content);
			if (text) {
				if (!pendingAssistant) pendingAssistant = { text, ts, entryId };
				else pendingAssistant.text += `\n${text}`;
			}
			if (pendingAssistant) {
				// The visible session parser uses the last assistant entry even when
				// it has no text. Keeping an earlier ID makes UI search drop the hit.
				pendingAssistant.ts = ts;
				pendingAssistant.entryId = entryId ?? pendingAssistant.entryId;
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
			chunks.push({
				id: `${sessionId}:${ordinal}`,
				sessionId,
				role: m.role,
				text: piece,
				ts: m.ts,
				entryId: m.entryId,
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
export async function indexSession(store: L3Store, filePath: string): Promise<number> {
	let stat;
	try {
		stat = await statFile(filePath);
	} catch (err) {
		logger.warn("failed to stat session file for indexing");
		return 0;
	}
	if (!stat.isFile() || stat.size === 0) return 0;

	const sessionId = basename(filePath);
	const mtimeMs = Math.floor(stat.mtimeMs);
	const prev = store.getIndexState(sessionId);
	if (prev && prev.lastMtimeMs === mtimeMs && prev.indexVersion === SESSION_INDEX_VERSION) return 0; // unchanged

	let messages: ExtractedMessage[];
	try {
		messages = extractMessages(await readJsonlAsync<Record<string, unknown>>(filePath));
	} catch (err) {
		logger.warn("[L3] failed to read session for indexing");
		return 0;
	}

	const chunks = buildChunks(sessionId, messages);
	// Re-index cleanly: drop old chunks for this session, then insert current.
	store.deleteSession(sessionId);
	if (chunks.length > 0) store.upsertChunks(chunks);
	store.setIndexState(sessionId, stat.size, mtimeMs, chunks.length, SESSION_INDEX_VERSION);
	return chunks.length;
}

/**
 * Backfill the store from all session files in the directory. Returns a summary
 * of how many sessions were (re)indexed and total chunks written.
 */
export async function indexAllSessions(store: L3Store, sessionDir: string): Promise<{ sessions: number; chunks: number }> {
	let entries: string[];
	try {
		entries = await readdir(sessionDir);
	} catch (err) {
		logger.warn("failed to read session directory for backfill");
		return { sessions: 0, chunks: 0 };
	}
	let sessions = 0;
	let chunks = 0;
	for (const name of entries) {
		if (!name.endsWith(".jsonl")) continue;
		const path = await resolveContainedPathAsync(sessionDir, name);
		if (!path) continue;
		const written = await indexSession(store, path);
		if (written > 0) {
			sessions++;
			chunks += written;
		}
	}
	return { sessions, chunks };
}
