import { describe, expect, it } from "vitest";
import { jobStreamEventFromAgent } from "./jobs.js";

/** The manual job run must forward every live agent event the chat bubble
 * renders — text, thinking and the tool lifecycle — otherwise the run looks
 * frozen until the final result arrives. */
describe("jobStreamEventFromAgent", () => {
	it("maps text and thinking deltas", () => {
		expect(jobStreamEventFromAgent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "你好", contentIndex: 0 },
		})).toEqual({ type: "text_delta", delta: "你好", contentIndex: 0 });
		expect(jobStreamEventFromAgent({
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", delta: "思考" },
		})).toEqual({ type: "thinking_delta", delta: "思考" });
		expect(jobStreamEventFromAgent({
			type: "message_update",
			assistantMessageEvent: { type: "text_start", contentIndex: 1 },
		})).toEqual({ type: "text_start", contentIndex: 1 });
	});

	it("maps the tool execution lifecycle", () => {
		expect(jobStreamEventFromAgent({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "read_file",
			args: { path: "a.md" },
		})).toEqual({ type: "tool_start", toolCallId: "t1", toolName: "read_file", args: { path: "a.md" } });
		expect(jobStreamEventFromAgent({
			type: "tool_execution_update",
			toolCallId: "t1",
			toolName: "read_file",
			partialResult: "chunk",
		})).toEqual({ type: "tool_update", toolCallId: "t1", toolName: "read_file", partialResult: "chunk" });
		expect(jobStreamEventFromAgent({
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "read_file",
			result: "ok",
			isError: true,
		})).toEqual({ type: "tool_end", toolCallId: "t1", toolName: "read_file", result: "ok", isError: true });
	});

	it("ignores events the job bubble does not render", () => {
		expect(jobStreamEventFromAgent({ type: "auto_retry_start", attempt: 1 })).toBeNull();
		expect(jobStreamEventFromAgent({ type: "message_update" })).toBeNull();
		expect(jobStreamEventFromAgent(null)).toBeNull();
	});

	it("truncates oversized tool payloads so SSE frames stay small", () => {
		const event = jobStreamEventFromAgent({
			type: "tool_execution_end",
			toolCallId: "t2",
			toolName: "bash",
			result: "x".repeat(20_000),
			isError: false,
		}) as { result: string };
		expect(event.result.length).toBeLessThan(10_000);
		expect(event.result.endsWith("…[truncated]")).toBe(true);
	});
});
