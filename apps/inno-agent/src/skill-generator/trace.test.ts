import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { ParsedSession } from "../server/session-parser.js";
import { createSkillTrace, extractSessionTrace, formatSkillTraces, sanitizeTraceText } from "./trace.js";

function session(messages: ParsedSession["messages"]): ParsedSession {
	return {
		summary: {
			id: "trace.jsonl", name: "生成周报", createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:01:00.000Z", messageCount: messages.length, preview: "生成周报", channels: ["web"],
		},
		messages,
	};
}

describe("skill trace extraction", () => {
	it("keeps reusable evidence while omitting thinking and redacting credentials", () => {
		const trace = createSkillTrace(session([
			{ role: "user", content: "请生成报表，不要复制原文，api_key=topsecret", timestamp: 1 },
			{
				role: "assistant", content: "已读取数据", thinking: "private chain", timestamp: 2,
				tools: [{ toolCallId: "1", toolName: "read", args: { path: "data.csv", token: "abc" }, result: { ok: true, authorization: "Bearer abc" } }],
			},
			{ role: "user", content: "不对，应该按周汇总", timestamp: 3 },
			{ role: "assistant", content: "已完成周报", timestamp: 4 },
		]));
		const formatted = formatSkillTraces([trace]);

		expect(trace.steps.map((step) => step.kind)).toEqual(["intent", "tool", "outcome", "feedback", "outcome"]);
		expect(trace.signals).toMatchObject({ userTurns: 2, toolCalls: 1, failedToolCalls: 0, corrections: 1, hasCompletion: true });
		expect(formatted).toContain("[S02] tool read success");
		expect(formatted).toContain("[REDACTED]");
		expect(formatted).not.toContain("topsecret");
		expect(formatted).not.toContain("private chain");
		expect(formatted).not.toContain("Bearer abc");
	});

	it("bounds long traces while preserving the initial intent and latest feedback", () => {
		const messages = Array.from({ length: 70 }, (_, index) => ({ role: "user" as const, content: `step-${index}`, timestamp: index }));
		const trace = createSkillTrace(session(messages));
		expect(trace.truncated).toBe(true);
		expect(trace.steps).toHaveLength(64);
		expect(trace.steps[0]?.text).toBe("step-0");
		expect(trace.steps.at(-1)?.text).toBe("step-69");
	});

	it("rejects traversal-like session ids before touching the filesystem", async () => {
		const root = mkdtempSync(join(tmpdir(), "inno-trace-test-"));
		await expect(extractSessionTrace(root, root, "../outside.jsonl")).resolves.toBeNull();
	});

	it("redacts common inline secrets and bounds output", () => {
		expect(sanitizeTraceText("password = 'secret-value'")).toBe("password = [REDACTED]");
		expect(sanitizeTraceText("x".repeat(30), 10)).toContain("truncated");
	});
});
