import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimePaths } from "../../runtime.js";
import { streamRegistry } from "../../chat/stream-registry.js";
import { WorkspaceRegistry } from "../../workspace/workspace-registry.js";
import { recordWorkspaceFileAccess, resetWorkspaceActivityStoreForTests } from "../workspace-activity-store.js";
import { handleWorkspacesRoutes, type WorkspacesRouteContext } from "./workspaces.js";

vi.mock("../../agent/pi-runner.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../agent/pi-runner.js")>();
	return { ...original, getCurrentSessionId: () => "other-session.jsonl" };
});

function fakeReq(payload: unknown): HttpReq & PassThrough {
	const stream = new PassThrough() as HttpReq & PassThrough;
	stream.headers = {};
	stream.end(JSON.stringify(payload));
	return stream;
}

function fakeRes(): ServerResponse & { statusCode: number; body: () => unknown } {
	let body = "";
	const res = {
		statusCode: 0,
		writeHead(status: number) {
			res.statusCode = status;
			return res;
		},
		end(chunk?: string) {
			body = chunk ?? "";
			return res;
		},
		body: () => (body ? JSON.parse(body) : undefined),
	} as unknown as ServerResponse & { statusCode: number; body: () => unknown };
	return res;
}

let dir: string;
let dataDir: string;
let sessionId: string;
let sessionPath: string;
let registry: WorkspaceRegistry;
let sourceRoot: string;
let targetId: string;
let ctx: WorkspacesRouteContext;

beforeEach(() => {
	dir = mkdtempSync(`${tmpdir()}/workspace-route-`);
	dataDir = `${dir}/data`;
	const workspaceDir = `${dir}/workspaces`;
	registry = new WorkspaceRegistry(workspaceDir, dataDir);
	registry.ensureBootstrapped();
	const source = registry.createWorkspace({ name: "源工作区" });
	const target = registry.createWorkspace({ name: "目标工作区" });
	targetId = target.id;
	sessionId = "route-session.jsonl";
	registry.bindSession(sessionId, source.id);
	sourceRoot = registry.resolveWorkspaceDir(source.id)!;
	sessionPath = `${dataDir}/sessions/${sessionId}`;
	mkdirSync(`${dataDir}/sessions`, { recursive: true });
	writeFileSync(sessionPath, "history\n");
	resetWorkspaceActivityStoreForTests();
	ctx = {
		workspaceRegistry: registry,
		dataDir,
		paths: {} as RuntimePaths,
		installSkillZip: () => { throw new Error("not used"); },
		installSkillMarkdown: () => { throw new Error("not used"); },
		importWorkspaceZip: () => { throw new Error("not used"); },
		scheduleSkillsReload: () => undefined,
		sessionFileFromId: (_sessionDir, id) => id === sessionId ? sessionPath : null,
		releaseQueueFromQuestionBlockedTurn: () => undefined,
		runQueueOpWithTimeout: async () => null,
	};
});

afterEach(() => {
	resetWorkspaceActivityStoreForTests();
	rmSync(dir, { recursive: true, force: true });
});

describe("session workspace switch routes", () => {
	it("previews tracked files and binds only after the confirmed switch", async () => {
		writeFileSync(`${sourceRoot}/notes.md`, "keep me");
		writeFileSync(`${sourceRoot}/move.md`, "move me");
		recordWorkspaceFileAccess(dataDir, {
			sessionId,
			workspaceId: registry.getSessionWorkspaceId(sessionId),
			workspaceRoot: sourceRoot,
			paths: ["notes.md", "move.md"],
			access: "read_write",
		});

		const previewResponse = fakeRes();
		await handleWorkspacesRoutes(
			fakeReq({}),
			previewResponse,
			"GET",
			`/api/sessions/${encodeURIComponent(sessionId)}/workspace/switch-preview?targetWorkspaceId=${encodeURIComponent(targetId)}`,
			ctx,
		);
		expect(previewResponse.statusCode).toBe(200);
		expect(previewResponse.body()).toMatchObject({
			sourceWorkspace: { name: "源工作区" },
			targetWorkspace: { name: "目标工作区" },
		});
		const previewBody = previewResponse.body() as { files: unknown[] };
		expect(previewBody.files).toEqual(expect.arrayContaining([
			expect.objectContaining({ path: "notes.md", access: "read_write", exists: true, selectable: true }),
			expect.objectContaining({ path: "move.md", access: "read_write", exists: true, selectable: true }),
		]));
		expect(registry.getSessionWorkspaceId(sessionId)).not.toBe(targetId);

		const switchResponse = fakeRes();
		await handleWorkspacesRoutes(
			fakeReq({ targetWorkspaceId: targetId, fileActions: { "notes.md": "copy", "move.md": "move" } }),
			switchResponse,
			"POST",
			`/api/sessions/${encodeURIComponent(sessionId)}/workspace/switch`,
			ctx,
		);
		expect(switchResponse.statusCode).toBe(200);
		expect(switchResponse.body()).toMatchObject({ switched: true, statistics: { success: 2, selected: 2 } });
		const switchBody = switchResponse.body() as { files: unknown[] };
		expect(switchBody.files).toEqual(expect.arrayContaining([
			expect.objectContaining({ path: "notes.md", action: "copy", status: "copied" }),
			expect.objectContaining({ path: "move.md", action: "move", status: "moved" }),
		]));
		expect(registry.getSessionWorkspaceId(sessionId)).toBe(targetId);
		expect(readFileSync(`${sourceRoot}/notes.md`, "utf8")).toBe("keep me");
		expect(() => readFileSync(`${sourceRoot}/move.md`, "utf8")).toThrow();
		expect(readFileSync(`${registry.resolveWorkspaceDir(targetId)}/notes.md`, "utf8")).toBe("keep me");
		expect(readFileSync(`${registry.resolveWorkspaceDir(targetId)}/move.md`, "utf8")).toBe("move me");
	});

	it("rejects active sessions before preview or file mutation", async () => {
		const active = streamRegistry.createTurn({
			sessionId,
			clientRequestId: "client-1",
			workspaceId: registry.getSessionWorkspaceId(sessionId),
			workspaceRoot: sourceRoot,
			inputSnapshot: { prompt: "", submittedAt: new Date().toISOString(), images: [] },
			baselineMessageCount: 0,
			baselineSessionRevision: "initial",
		});
		const response = fakeRes();
		await handleWorkspacesRoutes(
			fakeReq({}),
			response,
			"GET",
			`/api/sessions/${encodeURIComponent(sessionId)}/workspace/switch-preview?targetWorkspaceId=${encodeURIComponent(targetId)}`,
			ctx,
		);
		expect(response.statusCode).toBe(409);
		expect(response.body()).toMatchObject({ error: "Cannot rebind a session with an active chat turn" });
		streamRegistry.finishTurn(active, "aborted", { type: "aborted", reason: "test" }, { persisted: false });
		streamRegistry.cleanupExpiredTurns(Date.now(), 0);
	});
});
