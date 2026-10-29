import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveRuntimePaths } from "../../runtime.js";
import { closeL2Memory, getL2Memory } from "../../memory/l2/l2-memory.js";
import { closeL3Memory, getL3Memory } from "../../memory/l3/l3-tools.js";
import { WorkspaceRegistry } from "../../workspace/workspace-registry.js";
import { resetAgentCommandStoreForTests } from "../agent-command-store.js";
import type { SearchResponse } from "../../shared/search.js";
import { handleSearchRoutes, type SearchRouteContext } from "./search.js";

describe("global search", () => {
	let dir: string;
	let ctx: SearchRouteContext;
	let workspace: string;
	const message = (id: string, parentId: string | null, text: string, role = "user") => ({
		type: "message", id, parentId, timestamp: "2026-10-01T12:00:00.000Z",
		message: { role, content: [{ type: "text", text }], stopReason: "stop" },
	});
	const writeSession = (id: string, entries: unknown[]) => {
		writeFileSync(join(ctx.paths.sessionDir, id), entries.map((entry) => JSON.stringify(entry)).join("\n"));
	};

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "inno-search-"));
		const paths = resolveRuntimePaths({ home: dir, dataDir: join(dir, "data"), workspaceDir: join(dir, "workspaces") });
		mkdirSync(paths.sessionDir, { recursive: true });
		mkdirSync(join(paths.l2DataDir, "wiki", "concepts"), { recursive: true });
		const workspaceRegistry = new WorkspaceRegistry(paths.workspaceDir, paths.dataDir);
		workspaceRegistry.ensureBootstrapped();
		const ws = workspaceRegistry.createWorkspace({ name: "Needle workspace" });
		workspace = workspaceRegistry.resolveWorkspaceDir(ws.id)!;
		ctx = { dataDir: paths.dataDir, paths, workspaceRegistry };
		resetAgentCommandStoreForTests();
	});
	afterEach(() => {
		vi.restoreAllMocks();
		closeL2Memory(ctx.paths.l2DataDir);
		closeL3Memory(ctx.paths.l3DataDir);
		resetAgentCommandStoreForTests();
		rmSync(dir, { recursive: true, force: true });
	});

	async function search(query: string, category = "all", offset = 0): Promise<SearchResponse> {
		const res = { writeHead: vi.fn(), end: vi.fn() };
		const handled = await handleSearchRoutes({} as IncomingMessage, res as unknown as ServerResponse,
			"GET", `/api/search?query=${encodeURIComponent(query)}&category=${category}&offset=${offset}`, ctx);
		expect(handled).toBe(true);
		expect(res.writeHead.mock.calls[0][0]).toBe(200);
		return JSON.parse(res.end.mock.calls[0][0]) as SearchResponse;
	}

	it("finds actual content across all four categories, including archived conversations", async () => {
		writeSession("visible.jsonl", [message("q", null, "Needle conversation")]);
		writeFileSync(join(ctx.paths.sessionDir, "archives.json"), JSON.stringify({ "visible.jsonl": true }));
		writeFileSync(join(workspace, "needle.txt"), "file");
		writeFileSync(join(ctx.paths.l2DataDir, "wiki/concepts/needle.md"), "---\ntitle: Needle knowledge\ntags: [needle]\n---\nNeedle body");
		const { results } = await search("needle");
		expect(new Set(results.map((result) => result.category))).toEqual(new Set(["conversation", "workspace", "file", "knowledge"]));
		expect(results.find((result) => result.category === "conversation")).toMatchObject({ archived: true, entryId: "q", sessionId: "visible.jsonl" });
	});

	it("ranks exact names first and exposes every match through category pagination", async () => {
		ctx.workspaceRegistry.createWorkspace({ name: "needle" });
		for (let i = 0; i < 15; i++) ctx.workspaceRegistry.createWorkspace({ name: `needle ${i}` });
		const { results, total, nextOffset } = await search("  NEEDLE  ", "workspace");
		expect(results).toHaveLength(12);
		expect(total).toBe(17);
		expect(nextOffset).toBe(12);
		expect(results[0].title).toBe("needle");
		expect(results.every((result) => result.category === "workspace")).toBe(true);
		const next = await search("needle", "workspace", nextOffset);
		expect(next.results).toHaveLength(5);
		expect(next.nextOffset).toBeUndefined();
		expect(new Set([...results, ...next.results].map((result) => result.id)).size).toBe(17);
		expect((await search("needle")).counts.workspace).toBe(17);
	});

	it("finds all short Chinese messages and paginates beyond the first twelve", async () => {
		for (let i = 0; i < 15; i++) writeSession(`hello-${i}.jsonl`, [message(`q-${i}`, null, i % 2 ? "你好" : "你好，很高兴见到你")]);
		const first = await search("你好", "conversation");
		const next = await search("你好", "conversation", first.nextOffset);
		expect(first.total).toBe(15);
		expect(first.results).toHaveLength(12);
		expect(next.results).toHaveLength(3);
		expect(new Set([...first.results, ...next.results].map((result) => result.id)).size).toBe(15);
	});

	it("sees newly created sessions and edited messages after an earlier search", async () => {
		writeSession("existing.jsonl", [message("q", null, "old text")]);
		expect((await search("你好", "conversation")).results).toEqual([]);
		writeSession("existing.jsonl", [message("q", null, "你好 updated")]);
		writeSession("new.jsonl", [message("new", null, "你好")]);
		expect((await search("你好", "conversation")).total).toBe(2);
	});

	it("matches literal substrings, single Chinese characters, punctuation and chunk boundaries", async () => {
		writeSession("literal.jsonl", [message("q", null, `${"甲".repeat(3999)}你好 ReactDOM a+b`)]);
		for (const query of ["你好", "你", "actdo", "a+b"]) {
			expect((await search(query, "conversation")).results).toMatchObject([{ entryId: "q" }]);
		}
		expect((await search("你 好", "conversation")).results).toEqual([]);
	});

	it("finds current knowledge contents after edits, including literal punctuation", async () => {
		const path = join(ctx.paths.l2DataDir, "wiki/concepts/current.md");
		writeFileSync(path, "old text");
		expect((await search("你好", "knowledge")).results).toEqual([]);
		writeFileSync(path, "你好 a+b ReactDOM");
		for (const query of ["你好", "你", "actdo", "a+b"]) {
			expect((await search(query, "knowledge")).results).toHaveLength(1);
		}
	});

	it("searches file names below the file tree's display depth", async () => {
		const deep = join(workspace, ...Array.from({ length: 10 }, (_, i) => `level-${i}`));
		mkdirSync(deep, { recursive: true });
		writeFileSync(join(deep, "needle.txt"), "deep file");
		expect((await search("needle", "file")).results).toHaveLength(1);
	});

	it("excludes abandoned branches and merges assistant tool continuations", async () => {
		writeSession("branch.jsonl", [
			message("q", null, "question"), message("old", "q", "needle abandoned", "assistant"),
			{ ...message("part", "q", "needle part", "assistant"), message: { role: "assistant", content: "needle part", stopReason: "toolUse" } },
			message("final", "part", "needle final", "assistant"),
		]);
		const { results } = await search("needle", "conversation");
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({ entryId: "final", role: "assistant" });
		expect(results[0].snippet).toContain("needle part needle final");
		expect(results[0].snippet).not.toContain("abandoned");
	});

	it("ignores dependency folders, escaping symlinks and symlink cycles", async () => {
		mkdirSync(join(workspace, "node_modules"));
		writeFileSync(join(workspace, "node_modules/needle-hidden.txt"), "ignored");
		writeFileSync(join(workspace, "needle-visible.txt"), "visible");
		writeFileSync(join(dir, "needle-secret.txt"), "outside");
		symlinkSync(join(dir, "needle-secret.txt"), join(workspace, "needle-escape.txt"));
		symlinkSync(workspace, join(workspace, "cycle"), "dir");
		const { results } = await search("needle", "file");
		expect(results.map((result) => result.path)).toEqual(["needle-visible.txt"]);
	});

	it("uses asynchronous registry reads even when synchronous registry access is forbidden", async () => {
		vi.spyOn(ctx.workspaceRegistry, "listWorkspaces").mockImplementation(() => { throw new Error("synchronous read"); });
		vi.spyOn(ctx.workspaceRegistry, "resolveWorkspaceDir").mockImplementation(() => { throw new Error("synchronous read"); });
		writeFileSync(join(workspace, "needle.txt"), "file");
		expect((await search("needle", "file")).results).toHaveLength(1);
	});

	it("performs the first complete search without synchronous filesystem calls", async () => {
		writeSession("async.jsonl", [message("q", null, "needle conversation")]);
		writeFileSync(join(workspace, "needle.txt"), "file");
		writeFileSync(join(ctx.paths.l2DataDir, "wiki/concepts/async.md"), "needle knowledge");
		for (const method of ["readFileSync", "readdirSync", "statSync", "realpathSync", "existsSync", "mkdirSync"] as const) {
			vi.spyOn(fs, method).mockImplementation((() => { throw new Error(`Blocking filesystem call: ${method}`); }) as never);
		}
		expect(new Set((await search("needle")).results.map((result) => result.category)).size).toBe(4);
	});

	it("searches visible conversations and knowledge independently of recall index availability", async () => {
		vi.spyOn(getL3Memory(ctx.paths.l3DataDir, ctx.paths.sessionDir), "searchLexical").mockRejectedValue(new Error("recall unavailable"));
		const l2 = getL2Memory(ctx.paths.l2DataDir);
		vi.spyOn(l2, "backfill").mockResolvedValue();
		vi.spyOn(l2, "getStore").mockRejectedValue(new Error("recall unavailable"));
		writeSession("fallback.jsonl", [message("old", null, "needle hidden"), message("new", null, "needle current")]);
		writeFileSync(join(ctx.paths.l2DataDir, "wiki/concepts/fallback.md"), "---\ntitle: Custom page\n---\nneedle knowledge fallback");
		expect((await search("needle", "conversation")).results).toMatchObject([{ entryId: "new" }]);
		expect((await search("needle", "knowledge")).results[0]).toMatchObject({ title: "Custom page" });
	});

	it("returns empty results for blank queries and ignores unrelated routes", async () => {
		expect((await search("   ")).results).toEqual([]);
		expect(await handleSearchRoutes({} as IncomingMessage, {} as ServerResponse, "POST", "/api/search", ctx)).toBe(false);
	});
});
