import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildBtwContextDigest, handleBtwRoutes, type BtwRouteContext } from "./btw.js";
import { completeSideQuestion, appendAssistantNotificationInSession } from "../../agent/pi-runner.js";

vi.mock("../../agent/pi-runner.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../agent/pi-runner.js")>();
	return {
		...original,
		completeSideQuestion: vi.fn(),
		appendAssistantNotificationInSession: vi.fn(),
	};
});

const mockedComplete = vi.mocked(completeSideQuestion);
const mockedAppend = vi.mocked(appendAssistantNotificationInSession);

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

let dataDir: string;
let sessionFile: string;
let ctx: BtwRouteContext;

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "btw-routes-"));
	sessionFile = join(dataDir, "sessions", "sess-1.jsonl");
	mkdirSync(join(dataDir, "sessions"), { recursive: true });
	writeFileSync(sessionFile, "");
	ctx = {
		dataDir,
		sessionFileFromId: (_dir, id) => (id === "sess-1" ? sessionFile : null),
		parseSessionFile: () => ({
			messages: [
				{ role: "user", content: "什么是闭包？" } as never,
				{ role: "assistant", content: "闭包是能记住外层作用域的函数。" } as never,
			],
		}),
	};
	mockedComplete.mockReset();
	mockedAppend.mockReset();
});

afterEach(() => {
	rmSync(dataDir, { recursive: true, force: true });
});

describe("buildBtwContextDigest", () => {
	it("keeps recent user/assistant messages with role labels", () => {
		const digest = buildBtwContextDigest([
			{ role: "user", content: "问题一" },
			{ role: "assistant", content: "回答一" },
			{ role: "system", content: "系统提示" },
			{ role: "user", content: "  " },
		] as never);
		expect(digest).toContain("学生: 问题一");
		expect(digest).toContain("助教: 回答一");
		expect(digest).not.toContain("系统提示");
		expect(digest).toContain("只读参考");
	});

	it("samples only the most recent messages and truncates long ones", () => {
		const messages = Array.from({ length: 20 }, (_, i) => ({ role: "user", content: `m${i}` }));
		const digest = buildBtwContextDigest(messages as never);
		expect(digest).not.toContain("m0");
		expect(digest).not.toContain("m7");
		expect(digest).toContain("m8");
		expect(digest).toContain("m19");

		const long = buildBtwContextDigest([{ role: "assistant", content: "x".repeat(2000) }] as never);
		expect(long).toContain(`${"x".repeat(800)}…`);
		expect(long).not.toContain("x".repeat(801));
	});

	it("returns an empty digest when there is nothing to sample", () => {
		expect(buildBtwContextDigest([])).toBe("");
	});
});

describe("handleBtwRoutes /api/btw/ask", () => {
	it("answers a side question with the digest and thread", async () => {
		mockedComplete.mockResolvedValue("词法作用域决定的。");
		const res = fakeRes();
		const handled = await handleBtwRoutes(fakeReq({
			sessionId: "sess-1",
			question: "那自由变量呢？",
			thread: [{ question: "什么是闭包？", answer: "闭包是…" }],
		}), res as ServerResponse, "POST", "/api/btw/ask", ctx);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		expect(res.body()).toEqual({ answer: "词法作用域决定的。" });
		const input = mockedComplete.mock.calls[0][0];
		expect(input.question).toBe("那自由变量呢？");
		expect(input.thread).toEqual([{ question: "什么是闭包？", answer: "闭包是…" }]);
		expect(input.contextDigest).toContain("什么是闭包？");
	});

	it("rejects malformed bodies with 400", async () => {
		for (const payload of [
			{},
			{ sessionId: "sess-1" },
			{ sessionId: "sess-1", question: "   " },
			{ sessionId: "sess-1", question: "q", thread: "nope" },
			{ sessionId: "sess-1", question: "q", thread: [{ question: "q" }] },
			{ sessionId: "sess-1", question: "x".repeat(4001) },
		]) {
			const res = fakeRes();
			await handleBtwRoutes(fakeReq(payload), res as ServerResponse, "POST", "/api/btw/ask", ctx);
			expect(res.statusCode).toBe(400);
		}
		expect(mockedComplete).not.toHaveBeenCalled();
	});

	it("returns 404 for an unknown session", async () => {
		const res = fakeRes();
		await handleBtwRoutes(fakeReq({ sessionId: "missing", question: "q" }), res as ServerResponse, "POST", "/api/btw/ask", ctx);
		expect(res.statusCode).toBe(404);
		expect(mockedComplete).not.toHaveBeenCalled();
	});

	it("returns 502 when the side completion fails", async () => {
		mockedComplete.mockResolvedValue("");
		const res = fakeRes();
		await handleBtwRoutes(fakeReq({ sessionId: "sess-1", question: "q" }), res as ServerResponse, "POST", "/api/btw/ask", ctx);
		expect(res.statusCode).toBe(502);
	});
});

describe("handleBtwRoutes /api/btw/bring-back", () => {
	it("appends the confirmed Q/A as a session notification", async () => {
		mockedAppend.mockResolvedValue(undefined);
		const res = fakeRes();
		await handleBtwRoutes(fakeReq({
			sessionId: "sess-1",
			question: "什么是闭包？",
			answer: "闭包是…",
		}), res as ServerResponse, "POST", "/api/btw/bring-back", ctx);
		expect(res.statusCode).toBe(200);
		expect(res.body()).toEqual({ ok: true });
		const [path, text] = mockedAppend.mock.calls[0];
		expect(path).toBe(sessionFile);
		expect(text).toContain("📌 旁注问答");
		expect(text).toContain("Q: 什么是闭包？");
		expect(text).toContain("A: 闭包是…");
	});

	it("returns 500 when the append fails", async () => {
		mockedAppend.mockRejectedValue(new Error("queue busy"));
		const res = fakeRes();
		await handleBtwRoutes(fakeReq({ sessionId: "sess-1", question: "q", answer: "a" }), res as ServerResponse, "POST", "/api/btw/bring-back", ctx);
		expect(res.statusCode).toBe(500);
	});

	it("ignores unrelated routes", async () => {
		const res = fakeRes();
		expect(await handleBtwRoutes(fakeReq({}), res as ServerResponse, "GET", "/api/btw/ask", ctx)).toBe(false);
		expect(await handleBtwRoutes(fakeReq({}), res as ServerResponse, "POST", "/api/other", ctx)).toBe(false);
	});
});
