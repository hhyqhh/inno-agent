/**
 * L3 cross-conversation memory store, backed by node:sqlite.
 *
 * Stores chunks extracted from PI session JSONL files and exposes lexical
 * (FTS5/BM25) retrieval. The schema reserves an `embeddings` table and a
 * cosine-similarity path so a future embedding provider can be plugged in
 * without a migration.
 *
 * Design notes:
 * - node:sqlite ships with Node >= 22.5. On older runtimes (the package
 *   engines field allows >=20.6) the import throws; callers must treat a null
 *   store as "L3 retrieval disabled" and degrade silently.
 * - FTS5's default unicode61 tokenizer treats a run of CJK characters as a
 *   single token, so we segment CJK to single characters before indexing and
 *   before querying. ASCII words are kept whole and lowercased.
 */

import { join } from "node:path";
import { mkdirSync } from "node:fs";

/** A single retrievable unit of past conversation. */
export interface L3Chunk {
	/** Stable id: `${sessionId}:${ordinal}` so re-indexing is idempotent. */
	id: string;
	sessionId: string;
	role: "user" | "assistant";
	text: string;
	/** Epoch millis of the source message. */
	ts: number;
}

/** A lexical search hit. `bm25` is the raw FTS5 score (lower = more relevant). */
export interface L3SearchHit {
	id: string;
	sessionId: string;
	role: "user" | "assistant";
	text: string;
	ts: number;
	/** Raw bm25() value from FTS5; more negative = stronger lexical match. */
	bm25: number;
}

// node:sqlite has no stable public type export across Node versions; we keep
// the surface we use minimal and locally typed.
interface SqliteStatement {
	run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
	get(...params: unknown[]): Record<string, unknown> | undefined;
	all(...params: unknown[]): Record<string, unknown>[];
}
interface SqliteDatabase {
	exec(sql: string): void;
	prepare(sql: string): SqliteStatement;
	close(): void;
}

/**
 * Segment text for FTS indexing/search.
 *
 * CJK runs are split into overlapping **bigrams** (e.g. 学习计划 → 学习 习计
 * 计划); ASCII/Latin/digit runs are kept whole and lowercased. Bigrams are far
 * more discriminative than single CJK characters — unigram tokens like 的/我/学
 * occur in nearly every chunk and make coverage scoring match everything —
 * while needing no external word-segmentation dictionary.
 *
 * The same function is used at index and query time so tokens line up.
 */
export function segmentForFts(input: string): string {
	if (!input) return "";
	const tokens: string[] = [];
	const re = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+|[a-zA-Z0-9]+/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(input)) !== null) {
		const run = m[0];
		if (/[a-zA-Z0-9]/.test(run[0])) {
			tokens.push(run.toLowerCase());
		} else if (run.length === 1) {
			tokens.push(run);
		} else {
			for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
		}
	}
	return tokens.join(" ");
}

/**
 * Turn a user query into an FTS5 MATCH expression. Tokens are OR-combined so
 * partial overlaps still recall; each token is quoted to avoid FTS operator
 * injection from raw user text.
 */
function buildMatchExpression(query: string): string {
	const tokens = segmentForFts(query)
		.split(" ")
		.filter((t) => t.length > 0)
		// Escape embedded double quotes, then wrap as an FTS string token.
		.map((t) => `"${t.replace(/"/g, '""')}"`);
	return tokens.join(" OR ");
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chunks (
	id TEXT PRIMARY KEY,
	session_id TEXT NOT NULL,
	role TEXT NOT NULL,
	text TEXT NOT NULL,
	ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_session ON chunks(session_id);

-- Regular (non-contentless) FTS5 table: stores its own copy of the segmented
-- tokens so plain DELETE works. The rowid mirrors chunks.rowid for joins.
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
	tokens,
	tokenize='unicode61'
);

-- Reserved for a future embedding provider. dim records the vector size so
-- mismatched models can be detected and re-embedded.
CREATE TABLE IF NOT EXISTS embeddings (
	chunk_id TEXT PRIMARY KEY,
	dim INTEGER NOT NULL,
	vec BLOB NOT NULL,
	FOREIGN KEY(chunk_id) REFERENCES chunks(id) ON DELETE CASCADE
);

-- Tracks how far each session file has been indexed (incremental re-index).
CREATE TABLE IF NOT EXISTS index_state (
	session_id TEXT PRIMARY KEY,
	last_offset INTEGER NOT NULL,
	last_mtime_ms INTEGER NOT NULL,
	chunk_count INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
`;

/**
 * The L3 store. Construct via {@link openL3Store}, which returns null when
 * node:sqlite is unavailable so callers can degrade gracefully.
 */
export class L3Store {
	private db: SqliteDatabase;
	// Maps FTS rowid <-> chunk id. FTS5 with content='' needs an explicit
	// rowid; we keep an integer mapping table-free by reusing chunks.rowid.
	private constructor(db: SqliteDatabase) {
		this.db = db;
		this.db.exec(SCHEMA);
	}

	static async open(l3DataDir: string): Promise<L3Store | null> {
		let DatabaseSync: (new (path: string) => SqliteDatabase) | undefined;
		try {
			const mod = (await import("node:sqlite")) as unknown as {
				DatabaseSync: new (path: string) => SqliteDatabase;
			};
			DatabaseSync = mod.DatabaseSync;
		} catch {
			// node:sqlite not available on this runtime → L3 disabled.
			return null;
		}
		if (!DatabaseSync) return null;
		try {
			mkdirSync(l3DataDir, { recursive: true });
			const db = new DatabaseSync(join(l3DataDir, "memory.db"));
			db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
			return new L3Store(db);
		} catch (err) {
			console.warn(`[L3] failed to open sqlite store: ${err instanceof Error ? err.message : String(err)}`);
			return null;
		}
	}

	/** Insert or replace a chunk and its FTS row. */
	upsertChunk(chunk: L3Chunk): void {
		// chunks.rowid is the implicit integer key; we derive a stable integer
		// from insertion order by letting sqlite assign it, then mirror to FTS.
		const existing = this.db
			.prepare("SELECT rowid FROM chunks WHERE id = ?")
			.get(chunk.id) as { rowid?: number } | undefined;

		const segmented = segmentForFts(chunk.text);
		if (existing && typeof existing.rowid === "number") {
			this.db
				.prepare("UPDATE chunks SET session_id = ?, role = ?, text = ?, ts = ? WHERE id = ?")
				.run(chunk.sessionId, chunk.role, chunk.text, chunk.ts, chunk.id);
			this.db.prepare("DELETE FROM chunks_fts WHERE rowid = ?").run(existing.rowid);
			this.db.prepare("INSERT INTO chunks_fts(rowid, tokens) VALUES (?, ?)").run(existing.rowid, segmented);
			return;
		}

		const info = this.db
			.prepare("INSERT INTO chunks(id, session_id, role, text, ts) VALUES (?, ?, ?, ?, ?)")
			.run(chunk.id, chunk.sessionId, chunk.role, chunk.text, chunk.ts);
		const rowid = Number(info.lastInsertRowid);
		this.db.prepare("INSERT INTO chunks_fts(rowid, tokens) VALUES (?, ?)").run(rowid, segmented);
	}

	/** Insert many chunks inside a single transaction. */
	upsertChunks(chunks: L3Chunk[]): void {
		if (chunks.length === 0) return;
		this.db.exec("BEGIN");
		try {
			for (const c of chunks) this.upsertChunk(c);
			this.db.exec("COMMIT");
		} catch (err) {
			this.db.exec("ROLLBACK");
			throw err;
		}
	}

	/** Remove all chunks (and FTS rows) for a session. */
	deleteSession(sessionId: string): void {
		const rows = this.db
			.prepare("SELECT rowid FROM chunks WHERE session_id = ?")
			.all(sessionId) as { rowid: number }[];
		this.db.exec("BEGIN");
		try {
			for (const r of rows) {
				this.db.prepare("DELETE FROM chunks_fts WHERE rowid = ?").run(r.rowid);
			}
			this.db.prepare("DELETE FROM chunks WHERE session_id = ?").run(sessionId);
			this.db.prepare("DELETE FROM index_state WHERE session_id = ?").run(sessionId);
			this.db.exec("COMMIT");
		} catch (err) {
			this.db.exec("ROLLBACK");
			throw err;
		}
	}

	/**
	 * Lexical search over indexed chunks. Returns candidate hits ordered by
	 * raw bm25 relevance (most relevant first). Score thresholding is the
	 * caller's responsibility (see recall.ts), so we expose the raw bm25 value
	 * rather than a within-result-set normalization.
	 */
	searchLexical(query: string, limit = 8): L3SearchHit[] {
		const match = buildMatchExpression(query);
		if (!match) return [];
		let rows: Record<string, unknown>[];
		try {
			rows = this.db
				.prepare(
					`SELECT c.id AS id, c.session_id AS session_id, c.role AS role,
					        c.text AS text, c.ts AS ts, bm25(chunks_fts) AS bm25
					 FROM chunks_fts
					 JOIN chunks c ON c.rowid = chunks_fts.rowid
					 WHERE chunks_fts MATCH ?
					 ORDER BY bm25
					 LIMIT ?`,
				)
				.all(match, limit);
		} catch (err) {
			console.warn(`[L3] search failed: ${err instanceof Error ? err.message : String(err)}`);
			return [];
		}
		return rows.map((r) => ({
			id: String(r.id),
			sessionId: String(r.session_id),
			role: r.role === "assistant" ? "assistant" : "user",
			text: String(r.text),
			ts: Number(r.ts),
			bm25: Number(r.bm25),
		}));
	}

	/** Read incremental-index bookkeeping for a session file. */
	getIndexState(sessionId: string): { lastOffset: number; lastMtimeMs: number; chunkCount: number } | null {
		const row = this.db
			.prepare("SELECT last_offset, last_mtime_ms, chunk_count FROM index_state WHERE session_id = ?")
			.get(sessionId) as { last_offset?: number; last_mtime_ms?: number; chunk_count?: number } | undefined;
		if (!row) return null;
		return {
			lastOffset: Number(row.last_offset ?? 0),
			lastMtimeMs: Number(row.last_mtime_ms ?? 0),
			chunkCount: Number(row.chunk_count ?? 0),
		};
	}

	/** Persist incremental-index bookkeeping for a session file. */
	setIndexState(sessionId: string, lastOffset: number, lastMtimeMs: number, chunkCount: number): void {
		this.db
			.prepare(
				`INSERT INTO index_state(session_id, last_offset, last_mtime_ms, chunk_count, updated_at)
				 VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(session_id) DO UPDATE SET
				   last_offset = excluded.last_offset,
				   last_mtime_ms = excluded.last_mtime_ms,
				   chunk_count = excluded.chunk_count,
				   updated_at = excluded.updated_at`,
			)
			.run(sessionId, lastOffset, lastMtimeMs, chunkCount, Date.now());
	}

	/** Total indexed chunk count (for diagnostics). */
	chunkCount(): number {
		const row = this.db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n?: number } | undefined;
		return Number(row?.n ?? 0);
	}

	close(): void {
		try {
			this.db.close();
		} catch {
			// already closed
		}
	}
}

/**
 * Open the L3 store, returning null when node:sqlite is unavailable so callers
 * can disable cross-conversation recall without failing the agent.
 */
export function openL3Store(l3DataDir: string): Promise<L3Store | null> {
	return L3Store.open(l3DataDir);
}
