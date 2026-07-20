/**
 * L2 wiki retrieval index, backed by node:sqlite.
 *
 * A SEPARATE database from L3 (`index.db` here vs L3's `memory.db`): L2 indexes
 * durable wiki *pages* (knowledge), L3 indexes past *conversations* — different
 * corpora, kept isolated. This store provides lexical (FTS5/BM25) retrieval
 * over pages and holds an `embeddings` table for optional vector search
 * (see l2-search.ts).
 *
 * Reuses {@link segmentForFts} from the L3 store so index/query CJK bigram
 * tokenization stays identical across both layers. Degrades to null on
 * Node < 22.5 (where node:sqlite is unavailable) exactly like the L3 store, so
 * callers must treat a null store as "L2 index disabled" and fall back.
 */

import { logger } from "../../logger.js";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { segmentForFts } from "../l3/sqlite-store.js";

/** One indexed wiki page (the document unit for retrieval — whole page). */
export interface L2PageDoc {
	/** Wiki-relative path, e.g. `wiki/entities/foo.md`. Primary key. */
	path: string;
	title: string;
	/** WikiPageType as a string (source-summary | entity | concept | analysis). */
	type: string;
	tags: string[];
	sourceIds: string[];
	body: string;
	/** sha256[:16] of the raw page file — detects staleness for re-embedding. */
	contentHash: string;
	mtimeMs: number;
}

/** Page metadata as read back from the index (no body-less variant needed at our scale). */
export interface L2PageMeta {
	path: string;
	title: string;
	type: string;
	tags: string[];
	sourceIds: string[];
	body: string;
}

/** A lexical search hit. `bm25` is the raw FTS5 score (lower = more relevant). */
export interface L2LexHit {
	path: string;
	title: string;
	type: string;
	tags: string[];
	sourceIds: string[];
	bm25: number;
}

/** A stored embedding row. */
export interface L2EmbeddingRow {
	path: string;
	dim: number;
	vec: Float32Array;
	model: string;
	contentHash: string;
}

// node:sqlite has no stable public type export across Node versions; we keep
// the surface we use minimal and locally typed (mirrors l3/sqlite-store.ts).
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
 * Turn a user query into an FTS5 MATCH expression. Tokens are OR-combined so
 * partial overlaps still recall; each token is quoted to avoid FTS operator
 * injection from raw user text. (Copied from the L3 store, which keeps it
 * private.)
 */
function buildMatchExpression(query: string): string {
	const tokens = segmentForFts(query)
		.split(" ")
		.filter((t) => t.length > 0)
		.map((t) => `"${t.replace(/"/g, '""')}"`);
	return tokens.join(" OR ");
}

function parseJsonArray(value: unknown): string[] {
	if (typeof value !== "string" || !value) return [];
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed) ? parsed.map((x) => String(x)) : [];
	} catch {
		return [];
	}
}

/** Copy a sqlite BLOB (Uint8Array/Buffer) into a fresh Float32Array. */
function blobToFloat32(v: unknown): Float32Array {
	if (v instanceof Uint8Array) {
		const u8 = Uint8Array.from(v); // copy → buffer aligned at offset 0
		return new Float32Array(u8.buffer, 0, Math.floor(u8.byteLength / 4));
	}
	return new Float32Array(0);
}

/** Serialize a Float32Array to a Buffer for BLOB storage (copy to be safe). */
function float32ToBlob(vec: Float32Array): Buffer {
	return Buffer.from(new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength));
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pages (
	path TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	type TEXT NOT NULL,
	tags TEXT NOT NULL,        -- JSON array
	source_ids TEXT NOT NULL,  -- JSON array
	body TEXT NOT NULL,
	content_hash TEXT NOT NULL,
	mtime_ms INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

-- Regular (non-contentless) FTS5 table: rowid mirrors pages.rowid for joins.
CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
	tokens,
	tokenize='unicode61'
);

-- Optional vector search. content_hash detects staleness; model detects a
-- provider/model switch that requires re-embedding.
CREATE TABLE IF NOT EXISTS embeddings (
	path TEXT PRIMARY KEY,
	dim INTEGER NOT NULL,
	vec BLOB NOT NULL,
	model TEXT NOT NULL,
	content_hash TEXT NOT NULL,
	FOREIGN KEY(path) REFERENCES pages(path) ON DELETE CASCADE
);

-- Tracks how far each page file has been indexed (incremental skip).
CREATE TABLE IF NOT EXISTS index_state (
	path TEXT PRIMARY KEY,
	content_hash TEXT NOT NULL,
	mtime_ms INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
`;

/**
 * The L2 index store. Construct via {@link openL2IndexStore}, which returns
 * null when node:sqlite is unavailable so callers can degrade gracefully.
 */
export class L2IndexStore {
	private db: SqliteDatabase;

	private constructor(db: SqliteDatabase) {
		this.db = db;
		this.db.exec(SCHEMA);
	}

	static async open(l2DataDir: string): Promise<L2IndexStore | null> {
		let DatabaseSync: (new (path: string) => SqliteDatabase) | undefined;
		try {
			const mod = (await import("node:sqlite")) as unknown as {
				DatabaseSync: new (path: string) => SqliteDatabase;
			};
			DatabaseSync = mod.DatabaseSync;
		} catch (err) {
			logger.warn({ err }, "[L2] node:sqlite not available on this runtime");
			return null;
		}
		if (!DatabaseSync) return null;
		try {
			mkdirSync(l2DataDir, { recursive: true });
			const db = new DatabaseSync(join(l2DataDir, "index.db"));
			db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
			return new L2IndexStore(db);
		} catch (err) {
			logger.warn({ err }, `[L2] failed to open sqlite index: ${err instanceof Error ? err.message : String(err)}`);
			return null;
		}
	}

	/** Insert or replace a page and its FTS row; drop stale embedding on change. */
	upsertPage(doc: L2PageDoc): void {
		const existing = this.db
			.prepare("SELECT rowid, content_hash FROM pages WHERE path = ?")
			.get(doc.path) as { rowid?: number; content_hash?: string } | undefined;

		const tokens = segmentForFts([doc.title, doc.tags.join(" "), doc.body].join(" "));
		const tagsJson = JSON.stringify(doc.tags);
		const idsJson = JSON.stringify(doc.sourceIds);
		const now = Date.now();

		if (existing && typeof existing.rowid === "number") {
			this.db
				.prepare(
					"UPDATE pages SET title=?, type=?, tags=?, source_ids=?, body=?, content_hash=?, mtime_ms=?, updated_at=? WHERE path=?",
				)
				.run(doc.title, doc.type, tagsJson, idsJson, doc.body, doc.contentHash, doc.mtimeMs, now, doc.path);
			this.db.prepare("DELETE FROM pages_fts WHERE rowid = ?").run(existing.rowid);
			this.db.prepare("INSERT INTO pages_fts(rowid, tokens) VALUES (?, ?)").run(existing.rowid, tokens);
			if (existing.content_hash !== doc.contentHash) {
				this.db.prepare("DELETE FROM embeddings WHERE path = ?").run(doc.path);
			}
			return;
		}

		const info = this.db
			.prepare(
				"INSERT INTO pages(path,title,type,tags,source_ids,body,content_hash,mtime_ms,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
			)
			.run(doc.path, doc.title, doc.type, tagsJson, idsJson, doc.body, doc.contentHash, doc.mtimeMs, now);
		const rowid = Number(info.lastInsertRowid);
		this.db.prepare("INSERT INTO pages_fts(rowid, tokens) VALUES (?, ?)").run(rowid, tokens);
	}

	/** Insert many pages inside a single transaction. */
	upsertPages(docs: L2PageDoc[]): void {
		if (docs.length === 0) return;
		this.db.exec("BEGIN");
		try {
			for (const d of docs) this.upsertPage(d);
			this.db.exec("COMMIT");
		} catch (err) {
			this.db.exec("ROLLBACK");
			throw err;
		}
	}

	/** Remove a page, its FTS row, its embedding (via cascade), and index state. */
	deletePage(path: string): void {
		const row = this.db.prepare("SELECT rowid FROM pages WHERE path = ?").get(path) as
			| { rowid?: number }
			| undefined;
		this.db.exec("BEGIN");
		try {
			if (row && typeof row.rowid === "number") {
				this.db.prepare("DELETE FROM pages_fts WHERE rowid = ?").run(row.rowid);
			}
			this.db.prepare("DELETE FROM pages WHERE path = ?").run(path); // cascade → embeddings
			this.db.prepare("DELETE FROM index_state WHERE path = ?").run(path);
			this.db.exec("COMMIT");
		} catch (err) {
			this.db.exec("ROLLBACK");
			throw err;
		}
	}

	/** Lexical search over indexed pages, ordered by bm25 (most relevant first). */
	searchLexical(query: string, limit = 30): L2LexHit[] {
		const match = buildMatchExpression(query);
		if (!match) return [];
		try {
			const rows = this.db
				.prepare(
					`SELECT p.path AS path, p.title AS title, p.type AS type, p.tags AS tags,
					        p.source_ids AS source_ids, bm25(pages_fts) AS bm25
					 FROM pages_fts
					 JOIN pages p ON p.rowid = pages_fts.rowid
					 WHERE pages_fts MATCH ?
					 ORDER BY bm25
					 LIMIT ?`,
				)
				.all(match, limit);
			return rows.map((r) => ({
				path: String(r.path),
				title: String(r.title),
				type: String(r.type),
				tags: parseJsonArray(r.tags),
				sourceIds: parseJsonArray(r.source_ids),
				bm25: Number(r.bm25),
			}));
		} catch (err) {
			logger.warn({ err }, `[L2] lexical search failed: ${err instanceof Error ? err.message : String(err)}`);
			return [];
		}
	}

	/** All page metadata (incl. body) — used to build the query-time link graph. */
	getAllPages(): L2PageMeta[] {
		const rows = this.db
			.prepare("SELECT path, title, type, tags, source_ids, body FROM pages")
			.all();
		return rows.map((r) => ({
			path: String(r.path),
			title: String(r.title),
			type: String(r.type),
			tags: parseJsonArray(r.tags),
			sourceIds: parseJsonArray(r.source_ids),
			body: String(r.body),
		}));
	}

	/** All stored embeddings (in-memory cosine at personal scale). */
	getEmbeddings(): L2EmbeddingRow[] {
		const rows = this.db.prepare("SELECT path, dim, vec, model, content_hash FROM embeddings").all();
		return rows.map((r) => ({
			path: String(r.path),
			dim: Number(r.dim),
			vec: blobToFloat32(r.vec),
			model: String(r.model),
			contentHash: String(r.content_hash),
		}));
	}

	upsertEmbedding(path: string, dim: number, vec: Float32Array, model: string, contentHash: string): void {
		this.db
			.prepare(
				`INSERT INTO embeddings(path, dim, vec, model, content_hash) VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(path) DO UPDATE SET
				   dim = excluded.dim, vec = excluded.vec, model = excluded.model, content_hash = excluded.content_hash`,
			)
			.run(path, dim, float32ToBlob(vec), model, contentHash);
	}

	/** Pages that need (re)embedding for the given model: missing, stale, or wrong model. */
	getPagesMissingEmbedding(model: string): { path: string; title: string; body: string; contentHash: string }[] {
		const rows = this.db
			.prepare(
				`SELECT p.path AS path, p.title AS title, p.body AS body, p.content_hash AS content_hash
				 FROM pages p
				 LEFT JOIN embeddings e ON e.path = p.path
				 WHERE e.path IS NULL OR e.content_hash != p.content_hash OR e.model != ?`,
			)
			.all(model);
		return rows.map((r) => ({
			path: String(r.path),
			title: String(r.title),
			body: String(r.body),
			contentHash: String(r.content_hash),
		}));
	}

	getIndexState(path: string): { contentHash: string; mtimeMs: number } | null {
		const row = this.db
			.prepare("SELECT content_hash, mtime_ms FROM index_state WHERE path = ?")
			.get(path) as { content_hash?: string; mtime_ms?: number } | undefined;
		if (!row) return null;
		return { contentHash: String(row.content_hash ?? ""), mtimeMs: Number(row.mtime_ms ?? 0) };
	}

	setIndexState(path: string, contentHash: string, mtimeMs: number): void {
		this.db
			.prepare(
				`INSERT INTO index_state(path, content_hash, mtime_ms, updated_at) VALUES (?, ?, ?, ?)
				 ON CONFLICT(path) DO UPDATE SET
				   content_hash = excluded.content_hash, mtime_ms = excluded.mtime_ms, updated_at = excluded.updated_at`,
			)
			.run(path, contentHash, mtimeMs, Date.now());
	}

	listIndexedPaths(): string[] {
		const rows = this.db.prepare("SELECT path FROM pages").all();
		return rows.map((r) => String(r.path));
	}

	pageCount(): number {
		const row = this.db.prepare("SELECT COUNT(*) AS n FROM pages").get() as { n?: number } | undefined;
		return Number(row?.n ?? 0);
	}

	close(): void {
		try {
			this.db.close();
		} catch (err) {
			logger.warn({ err }, "[L2] failed to close sqlite index (may already be closed)");
		}
	}
}

/**
 * Open the L2 index store, returning null when node:sqlite is unavailable so
 * callers can disable index-backed retrieval without failing the agent.
 */
export function openL2IndexStore(l2DataDir: string): Promise<L2IndexStore | null> {
	return L2IndexStore.open(l2DataDir);
}
