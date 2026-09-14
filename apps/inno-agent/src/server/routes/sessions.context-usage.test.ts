import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleSessionsRoutes, type SessionsRouteContext } from "./sessions.js";
import { getSession, getCurrentSessionId } from "../../agent/pi-runner.js";
vi.mock("../../agent/pi-runner.js", () => ({
	getSession: vi.fn(), getCurrentSessionId: vi.fn(), applyWorkspaceCwd: vi.fn(),
	branchSessionBeforeUserMessage: vi.fn(), createNewSession: vi.fn(), SessionEditError: class extends Error {}, switchSessionFile: vi.fn(),
}));
let dir: string;
let ctx: SessionsRouteContext;
beforeEach(() => {
	vi.clearAllMocks();
	dir = mkdtempSync(join(tmpdir(), "context-usage-route-"));
	mkdirSync(join(dir, "sessions"));
	writeFileSync(join(dir, "sessions", "s1.jsonl"), "");
	ctx = { dataDir: dir, sessionFileFromId: (_dir: string, id: string) => id === "s1.jsonl" ? join(dir, "sessions", id) : null } as SessionsRouteContext;
	vi.mocked(getCurrentSessionId).mockReturnValue("s1.jsonl");
	vi.mocked(getSession).mockReturnValue({
		getContextUsage: () => ({ tokens: null, percent: null, contextWindow: 1000 }),
	} as never);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
async function request(id: string) {
	let body = "";
	const res = { statusCode: 0, setHeader: vi.fn(), writeHead(code: number) { this.statusCode = code; }, end(chunk: string) { body = chunk; } };
	const handled = await handleSessionsRoutes({} as IncomingMessage, res as unknown as ServerResponse, "GET", `/api/sessions/${id}/context-usage`, ctx);
	return { ...res, handled, data: JSON.parse(body) };
}
describe("GET session context usage", () => {
	it("returns a no-store, session-scoped payload", async () => {
		const res = await request("s1.jsonl");
		expect(res.handled).toBe(true);
		expect(res.statusCode).toBe(200);
		expect(res.data).toMatchObject({ sessionId: "s1.jsonl", status: "pending", tokens: null });
		expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
	});
	it("never reads another session's live runtime", async () => {
		vi.mocked(getCurrentSessionId).mockReturnValue("other.jsonl");
		const res = await request("s1.jsonl");
		expect(res.data.status).toBe("inactive");
		expect(res.data.tokens).toBeNull();
		expect(getSession).not.toHaveBeenCalled();
	});
	it("rejects nonexistent sessions", async () => {
		expect((await request("missing.jsonl")).statusCode).toBe(404);
		expect(getSession).not.toHaveBeenCalled();
	});
});
