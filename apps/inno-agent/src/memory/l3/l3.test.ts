import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { indexAllSessions, indexSession } from "./indexer.js";
import { formatRecallForPrompt, recall } from "./recall.js";
import { openL3Store, segmentForFts, type L3Store } from "./sqlite-store.js";

/**
 * L3 tests. `segmentForFts` is a pure function and always runs. The store /
 * indexer / recall suites need node:sqlite with FTS5 enabled. Some Node builds
 * expose node:sqlite without compiling the FTS5 module; L3 intentionally
 * degrades to disabled in either case, so the integration suite must probe the
 * feature rather than infer it from the Node version.
 */
function nodeSqliteFts5Available(): boolean {
	let db: { exec(sql: string): void; close(): void } | undefined;
	try {
		const require = createRequire(import.meta.url);
		const { DatabaseSync } = require("node:sqlite") as {
			DatabaseSync: new (path: string) => { exec(sql: string): void; close(): void };
		};
		db = new DatabaseSync(":memory:");
		db.exec("CREATE VIRTUAL TABLE fts5_probe USING fts5(content)");
		return true;
	} catch {
		return false;
	} finally {
		db?.close();
	}
}

describe("segmentForFts (pure)", () => {
	it("splits CJK runs into overlapping bigrams", () => {
		expect(segmentForFts("学习计划")).toBe("学习 习计 计划");
	});

	it("keeps ASCII runs whole and lowercased", () => {
		expect(segmentForFts("Python AsyncIO")).toBe("python asyncio");
	});

	it("handles mixed CJK/ASCII and punctuation (single CJK chars stay unigrams)", () => {
		expect(segmentForFts("用Node.js写爬虫")).toBe("用 node js 写爬 爬虫");
	});

	it("returns empty string for empty input", () => {
		expect(segmentForFts("")).toBe("");
	});
});

describe.skipIf(!nodeSqliteFts5Available())("L3 store + recall (node:sqlite + FTS5)", () => {
	let l3Dir: string;
	let sessionDir: string;
	let store: L3Store | null;

	beforeEach(async () => {
		l3Dir = mkdtempSync(join(tmpdir(), "inno-l3-db-"));
		sessionDir = mkdtempSync(join(tmpdir(), "inno-l3-sess-"));
		store = await openL3Store(l3Dir);
		expect(store).not.toBeNull();
	});

	afterEach(() => {
		store?.close();
		rmSync(l3Dir, { recursive: true, force: true });
		rmSync(sessionDir, { recursive: true, force: true });
	});

	function upsert(sessionId: string, texts: string[], role: "user" | "assistant" = "user") {
		store!.upsertChunks(
			texts.map((text, i) => ({
				id: `${sessionId}:${i}`,
				sessionId,
				role,
				text,
				ts: Date.parse("2026-08-01T10:00:00Z") + i,
			})),
		);
	}

	it("upserts chunks and finds them via CJK bigram search", () => {
		upsert("s1", ["我们在整理机器学习的学习笔记和公式推导"]);
		const hits = store!.searchLexical("机器学习");
		expect(hits).toHaveLength(1);
		expect(hits[0].sessionId).toBe("s1");
		expect(hits[0].bm25).toBeLessThan(0);
	});

	it("returns no hits for lexically absent queries", () => {
		upsert("s1", ["我们在整理机器学习的学习笔记和公式推导"]);
		expect(store!.searchLexical("烹饪食谱")).toHaveLength(0);
	});

	it("recall gates on coverage: unrelated queries inject nothing", () => {
		upsert("s1", ["我们在整理机器学习的学习笔记和公式推导"]);
		expect(recall(store, "机器学习")).toHaveLength(1);
		expect(recall(store, "烹饪食谱")).toHaveLength(0);
	});

	it("recall rejects too-short queries (single CJK char)", () => {
		upsert("s1", ["我们在整理机器学习的学习笔记和公式推导"]);
		expect(recall(store, "机")).toHaveLength(0);
	});

	it("recall excludes the active session", () => {
		upsert("s1", ["我们在整理机器学习的学习笔记和公式推导"]);
		expect(recall(store, "机器学习", { excludeSessionId: "s1" })).toHaveLength(0);
	});

	it("recall dedups near-identical snippets", () => {
		const text = "我们在整理机器学习的学习笔记和公式推导";
		upsert("s1", [text]);
		upsert("s2", [text]);
		const results = recall(store, "机器学习");
		expect(results).toHaveLength(1);
	});

	it("recall on a null store degrades to empty", () => {
		expect(recall(null, "机器学习")).toEqual([]);
	});

	it("deleteSession removes chunks, FTS rows, and index state", () => {
		upsert("s1", ["我们在整理机器学习的学习笔记和公式推导"]);
		store!.setIndexState("s1", 100, 200, 1);
		expect(store!.chunkCount()).toBe(1);

		store!.deleteSession("s1");

		expect(store!.chunkCount()).toBe(0);
		expect(store!.searchLexical("机器学习")).toHaveLength(0);
		expect(store!.getIndexState("s1")).toBeNull();
	});

	it("index state round-trips", () => {
		expect(store!.getIndexState("s1")).toBeNull();
		store!.setIndexState("s1", 123, 456, 7);
		expect(store!.getIndexState("s1")).toEqual({ lastOffset: 123, lastMtimeMs: 456, chunkCount: 7, indexVersion: 0 });
	});

	function writeSession(name: string, lines: unknown[]): string {
		const path = join(sessionDir, name);
		writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");
		return path;
	}

	function messageEvent(role: string, text: string, stopReason?: string) {
		return {
			type: "message",
			timestamp: "2026-08-01T10:00:00Z",
			message: { role, content: [{ type: "text", text }], ...(stopReason ? { stopReason } : {}) },
		};
	}

	it("indexSession extracts user/assistant text and skips thinking/toolCall noise", async () => {
		const path = writeSession("sess_a.jsonl", [
			messageEvent("user", "今天学习了机器学习的基础概念"),
			{
				type: "message",
				timestamp: "2026-08-01T10:00:01Z",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "内部推理不应进索引" },
						{ type: "text", text: "好的，我们从梯度下降开始复习" },
					],
					stopReason: "stop",
				},
			},
			{ type: "message", timestamp: "2026-08-01T10:00:02Z", message: { role: "toolResult", content: "noise" } },
		]);

		const written = await indexSession(store!, path);
		expect(written).toBe(2);
		expect(store!.chunkCount()).toBe(2);
		expect(store!.searchLexical("机器学习")).toHaveLength(1);
		expect(store!.searchLexical("内部推理")).toHaveLength(0);
	});

	it("indexSession skips unchanged files (mtime-gated incremental indexing)", async () => {
		const path = writeSession("sess_b.jsonl", [messageEvent("user", "今天学习了机器学习的基础概念")]);
		expect(await indexSession(store!, path)).toBe(1);
		// Same mtime → skipped entirely.
		expect(await indexSession(store!, path)).toBe(0);
	});

	it("indexAllSessions backfills a directory of session files", async () => {
		writeSession("sess_c.jsonl", [messageEvent("user", "今天学习了机器学习的基础概念")]);
		writeSession("sess_d.jsonl", [messageEvent("user", "晚上复习了线性代数的特征值分解")]);
		writeFileSync(join(sessionDir, "not-a-session.txt"), "ignored", "utf-8");

		const summary = await indexAllSessions(store!, sessionDir);
		expect(summary).toEqual({ sessions: 2, chunks: 2 });
	});

	it("end-to-end: indexed history is recallable from a later session", async () => {
		writeSession("sess_old.jsonl", [messageEvent("user", "上周我们讨论了机器学习的学习笔记")]);
		await indexAllSessions(store!, sessionDir);

		const results = recall(store, "机器学习", { excludeSessionId: "sess_new.jsonl" });
		expect(results).toHaveLength(1);
		const promptSection = formatRecallForPrompt(results);
		expect(promptSection).toContain("相关历史对话");
		expect(promptSection).toContain("机器学习");
	});

	it("formatRecallForPrompt returns empty string when there is nothing to inject", () => {
		expect(formatRecallForPrompt([])).toBe("");
	});

	it("reindexes an unchanged file when its stored index version is obsolete", async () => {
		const path = writeSession("version.jsonl", [messageEvent("user", "needle upgrade")]);
		await indexSession(store!, path);
		const previous = store!.getIndexState("version.jsonl")!;
		store!.setIndexState("version.jsonl", previous.lastOffset, previous.lastMtimeMs, 1, 2);
		expect(await indexSession(store!, path)).toBe(1);
		expect(store!.getIndexState("version.jsonl")!.indexVersion).toBe(3);
		expect(await indexSession(store!, path)).toBe(0);
	});

	it("indexes only the active branch and preserves its visible message entry IDs", async () => {
		const path = writeSession("branch.jsonl", [
			{ ...messageEvent("user", "original question"), id: "q", parentId: null },
			{ ...messageEvent("assistant", "abandoned branch", "stop"), id: "old", parentId: "q" },
			{ ...messageEvent("assistant", "current branch", "stop"), id: "new", parentId: "q" },
		]);
		expect(await indexSession(store!, path)).toBe(2);
		expect(store!.searchLexical("abandoned")).toEqual([]);
		expect(store!.searchLexical("current")[0]).toMatchObject({ entryId: "new", role: "assistant" });
	});

	it("keeps short messages searchable in the UI while excluding them from prompt recall", async () => {
		const path = writeSession("short.jsonl", [{ ...messageEvent("user", "你好"), id: "short", parentId: null }]);
		await indexSession(store!, path);
		expect(store!.searchLexical("你好", 12, 1)).toMatchObject([{ entryId: "short", text: "你好" }]);
		expect(recall(store, "你好")).toEqual([]);
	});

	it("keeps the final visible entry ID when a tool continuation ends without more text", async () => {
		const path = writeSession("continuation.jsonl", [
			{ ...messageEvent("assistant", "needle before tool", "toolUse"), id: "part", parentId: null },
			{ ...messageEvent("assistant", "", "stop"), id: "final", parentId: "part" },
		]);
		await indexSession(store!, path);
		expect(store!.searchLexical("needle")[0]).toMatchObject({ entryId: "final", text: "needle before tool" });
	});

	it("migrates a legacy SQLite database without losing existing indexed content", async () => {
		upsert("legacy", ["needle legacy content"]);
		store!.setIndexState("legacy", 123, 456, 1);
		store!.close();
		store = null;
		const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
		const legacy = new DatabaseSync(join(l3Dir, "memory.db"));
		legacy.exec("ALTER TABLE chunks DROP COLUMN entry_id; ALTER TABLE index_state DROP COLUMN index_version;");
		legacy.close();
		store = await openL3Store(l3Dir);
		expect(store!.searchLexical("needle")[0].sessionId).toBe("legacy");
		expect(store!.getIndexState("legacy")).toMatchObject({ indexVersion: 0, chunkCount: 1 });
		store!.upsertChunk({ id: "new:0", sessionId: "new", role: "user", text: "needle migrated content", ts: 1, entryId: "entry" });
		expect(store!.searchLexical("migrated")[0].entryId).toBe("entry");
	});
});
