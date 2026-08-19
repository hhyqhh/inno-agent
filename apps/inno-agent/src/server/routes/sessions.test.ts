import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const archiveConversationMock = vi.hoisted(() => vi.fn());
vi.mock("../../agent/pi-runner.js", () => ({
	applyWorkspaceCwd: vi.fn(),
	createNewSession: vi.fn(),
	getCurrentSessionId: vi.fn(() => "session.jsonl"),
	switchSessionFile: vi.fn(),
}));
vi.mock("../../memory/l2/conversation-archive-service.js", () => ({
	archiveConversation: archiveConversationMock,
}));

import { handleSessionsRoutes, type SessionsRouteContext } from "./sessions.js";

const roots: string[] = [];
afterEach(() => {
	archiveConversationMock.mockReset();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function request(body: unknown): IncomingMessage {
	const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
	req.headers = {};
	return req;
}

function response(): { res: ServerResponse; result: { status: number; body: string } } {
	const result = { status: 0, body: "" };
	const res = {
		writeHead(status: number) {
			result.status = status;
			return res;
		},
		end(body: string) {
			result.body = body;
			return res;
		},
	} as unknown as ServerResponse;
	return { res, result };
}

describe("conversation archive route", () => {
	it("loads the requested session and forwards selected message IDs", async () => {
		const root = mkdtempSync(join(tmpdir(), "inno-session-route-"));
		roots.push(root);
		const sessionPath = join(root, "session.jsonl");
		writeFileSync(sessionPath, "{}\n", "utf-8");
		archiveConversationMock.mockResolvedValue({ status: "indexed", rawPath: "raw/conversations/chat.md" });
		const ctx = {
			dataDir: root,
			l2DataDir: join(root, "l2"),
			sessionFileFromId: () => sessionPath,
			parseSessionFile: () => ({
				summary: { id: "session.jsonl", name: "Session title" },
				messages: [
					{ id: "user-1", role: "user", content: "question", timestamp: 1 },
					{ id: "assistant-1", role: "assistant", content: "answer", timestamp: 2 },
				],
			}),
			getArchiveRuntime: () => ({}),
		} as unknown as SessionsRouteContext;
		const { res, result } = response();

		await expect(handleSessionsRoutes(
			request({ sessionId: "session.jsonl", messageIds: ["assistant-1"], tags: ["study"] }),
			res,
			"POST",
			"/api/l2/conversations/archive",
			ctx,
		)).resolves.toBe(true);

		expect(result.status).toBe(201);
		expect(archiveConversationMock).toHaveBeenCalledWith(ctx.l2DataDir, expect.objectContaining({
			sessionId: "session.jsonl",
			title: "Session title",
			messageIds: ["assistant-1"],
			tags: ["study"],
			messages: expect.arrayContaining([expect.objectContaining({ id: "assistant-1" })]),
		}));
	});
});
