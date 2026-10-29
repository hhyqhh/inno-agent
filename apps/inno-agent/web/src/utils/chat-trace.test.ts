import { describe, expect, it } from "vitest";
import type { ChatStreamEvent, ChatTraceStep } from "../types/chat.js";
import {
	applyChatTraceEvent,
	finalizeTraceSteps,
	hasVisibleTraceSteps,
	traceStepsFromEvents,
	traceTerminalState,
	visibleTraceSteps,
} from "./chat-trace.js";

const at = (seconds: number): string => `2026-09-01T00:00:${String(seconds).padStart(2, "0")}.000Z`;

function apply(events: Array<[ChatStreamEvent, number]>): ChatTraceStep[] {
	return events.reduce(
		(steps, [event, seconds]) => applyChatTraceEvent(steps, event, at(seconds)),
		[] as ChatTraceStep[],
	);
}

describe("PI chat trace reducer", () => {
	it("keeps native thinking blocks separate and measures only native boundaries", () => {
		const steps = apply([
			[{ type: "thinking_start", contentIndex: 0 }, 0],
			[{ type: "thinking_delta", contentIndex: 0, delta: "先判断" }, 1],
			[{ type: "thinking_end", contentIndex: 0 }, 2],
			[{ type: "thinking_start", contentIndex: 1 }, 3],
			[{ type: "thinking_delta", contentIndex: 1, delta: "再验证" }, 4],
			[{ type: "thinking_end", contentIndex: 1 }, 5],
		]);

		expect(steps).toHaveLength(2);
		expect(steps[0]).toMatchObject({ kind: "thinking", text: "先判断", status: "completed", durationMs: 2_000 });
		expect(steps[1]).toMatchObject({ kind: "thinking", text: "再验证", status: "completed", durationMs: 2_000 });
	});

	it("keeps a streamed tool call in one row through preparation and execution", () => {
		const preparing = apply([
			[{ type: "tool_call_start", toolCallId: "t1", toolName: "read_file" }, 0],
			[{ type: "tool_call_delta", toolCallId: "t1", toolName: "read_file", argsDelta: '{"path":"notes' }, 1],
			[{ type: "tool_call_delta", toolCallId: "t1", toolName: "read_file", argsDelta: '.md"}' }, 2],
		]);
		expect(preparing).toHaveLength(1);
		expect(preparing[0]).toMatchObject({ status: "preparing", argsText: '{"path":"notes.md"}' });

		const completed = apply([
			[{ type: "tool_call_start", toolCallId: "t1", toolName: "read_file" }, 0],
			[{ type: "tool_call_delta", toolCallId: "t1", toolName: "read_file", argsDelta: '{"path":"notes.md"}' }, 1],
			[{ type: "tool_call_end", toolCallId: "t1", toolName: "read_file", args: { path: "notes.md" } }, 2],
			[{ type: "tool_start", toolCallId: "t1", toolName: "read_file", args: { path: "notes.md" } }, 3],
			[{ type: "tool_update", toolCallId: "t1", toolName: "read_file", partialResult: { content: [{ type: "text", text: "正在读取" }] } }, 4],
			[{ type: "tool_end", toolCallId: "t1", toolName: "read_file", result: "contents", isError: false }, 6],
		]);
		expect(completed).toHaveLength(1);
		expect(completed[0]).toMatchObject({
			status: "completed",
			args: { path: "notes.md" },
			partialResult: { content: [{ type: "text", text: "正在读取" }] },
			result: "contents",
			durationMs: 3_000,
		});
	});

	it("stops a thinking timer when final text starts without thinking_end", () => {
		const steps = apply([
			[{ type: "thinking_start", contentIndex: 0 }, 0],
			[{ type: "thinking_delta", contentIndex: 0, delta: "先分析" }, 1],
			[{ type: "text_start", contentIndex: 1 }, 2],
			[{ type: "text_delta", contentIndex: 1, delta: "最终答案" }, 3],
		]);

		expect(steps[0]).toMatchObject({
			kind: "thinking",
			status: "completed",
			endedAt: Date.parse(at(2)),
			durationMs: 2_000,
		});
		expect(steps[1]).toMatchObject({ kind: "answer", text: "最终答案", status: "active" });
	});

	it("separates progress text before the last tool from the final answer", () => {
		const steps = apply([
			[{ type: "text_start", contentIndex: 0 }, 0],
			[{ type: "text_delta", contentIndex: 0, delta: "先查资料" }, 1],
			[{ type: "text_end", contentIndex: 0 }, 2],
			[{ type: "tool_call_start", toolCallId: "t1", toolName: "search" }, 3],
			[{ type: "tool_start", toolCallId: "t1", toolName: "search" }, 4],
			[{ type: "tool_end", toolCallId: "t1", toolName: "search", result: [], isError: false }, 5],
			[{ type: "text_start", contentIndex: 1 }, 6],
			[{ type: "text_delta", contentIndex: 1, delta: "最终结论" }, 7],
			[{ type: "text_end", contentIndex: 1 }, 8],
		]);
		const finalized = finalizeTraceSteps(steps);

		expect(finalized.map((step) => step.kind)).toEqual(["progress", "tool", "answer"]);
	});

	it("preserves each retry attempt instead of overwriting a failed tool row", () => {
		const steps = finalizeTraceSteps(apply([
			[{ type: "tool_call_start", toolCallId: "retry", toolName: "search" }, 0],
			[{ type: "tool_start", toolCallId: "retry", toolName: "search" }, 1],
			[{ type: "tool_end", toolCallId: "retry", toolName: "search", result: "timeout", isError: true }, 2],
			[{ type: "system_event", eventType: "auto_retry_start", phase: "start", attempt: 2 }, 3],
			[{ type: "tool_call_start", toolCallId: "retry", toolName: "search" }, 4],
			[{ type: "tool_start", toolCallId: "retry", toolName: "search" }, 5],
			[{ type: "tool_end", toolCallId: "retry", toolName: "search", result: "ok", isError: false }, 6],
		]));
		const tools = steps.filter((step) => step.kind === "tool");

		expect(tools).toHaveLength(2);
		expect(tools[0]).toMatchObject({ status: "error", result: "timeout", isError: true });
		expect(tools[1]).toMatchObject({ status: "completed", result: "ok", attempt: 2 });
		expect(steps.some((step) => step.kind === "system" && step.attempt === 2)).toBe(true);
	});

	it("attaches questions, skills, system events, and workspace changes to the timeline", () => {
		const steps = finalizeTraceSteps(apply([
			[{ type: "skill_loaded", count: 2, skills: [{ name: "docs" }] }, 0],
			[{ type: "skill_invoked", skillName: "docs", args: "read report", source: "workspace" }, 1],
			[{ type: "system_event", eventType: "compaction_start", phase: "start" }, 2],
			[{ type: "system_event", eventType: "compaction_end", phase: "end", success: true }, 3],
			[{ type: "tool_call_start", toolCallId: "ask", toolName: "ask_user_question" }, 4],
			[{ type: "tool_start", toolCallId: "ask", toolName: "ask_user_question" }, 5],
			[{ type: "question", questionId: "q1", toolCallId: "ask", params: { questions: [] } }, 6],
			[{ type: "workspace_change", toolCallId: "ask", changes: [{ path: "report.md", change: "modified" }] }, 7],
			[{ type: "question_resolved", questionId: "q1" }, 8],
			[{ type: "tool_end", toolCallId: "ask", toolName: "ask_user_question", result: "answer", isError: false }, 9],
		]));

		expect(steps.find((step) => step.id === "skill:loaded")).toMatchObject({ title: "已预载 2 个技能" });
		expect(steps.find((step) => step.kind === "skill" && step.skillState === "expanded")).toMatchObject({ skillName: "docs" });
		expect(steps.some((step) => step.kind === "system" && step.eventType === "compaction_start" && step.durationMs === 1_000)).toBe(true);
		expect(steps.find((step) => step.toolCallId === "ask")).toMatchObject({ status: "completed", workspaceChanges: [{ path: "report.md", change: "modified" }] });
	});

	it("reuses the open question tool when a question event has no tool id", () => {
		const waiting = apply([
			[{ type: "tool_start", toolCallId: "ask", toolName: "ask_user_question", args: { questions: [] } }, 0],
			[{ type: "question", questionId: "q1", params: { questions: [] } }, 1],
			[{ type: "question_resolved", questionId: "q1" }, 2],
		]);

		expect(waiting.filter((step) => step.kind === "tool")).toHaveLength(1);
		expect(waiting[0]).toMatchObject({
			toolCallId: "ask",
			questionId: "q1",
			status: "running",
		});

		const completed = applyChatTraceEvent(
			waiting,
			{ type: "tool_end", toolCallId: "ask", toolName: "ask_user_question", result: "answer", isError: false },
			at(3),
		);
		expect(completed).toHaveLength(1);
		expect(completed[0]).toMatchObject({ toolCallId: "ask", status: "completed", result: "answer" });
	});

	it("does not create a row for an empty skill inventory and hides PI bookkeeping", () => {
		const steps = apply([
			[{ type: "skill_loaded", count: 0, skills: [] }, 0],
			[{ type: "system_event", eventType: "turn_start", phase: "start" }, 1],
			[{ type: "system_event", eventType: "agent_start", phase: "start" }, 2],
			[{ type: "system_event", eventType: "message_start", phase: "start" }, 3],
			[{ type: "system_event", eventType: "message_start", summary: "Request was aborted", detail: { stopReason: "aborted" } }, 4],
		]);

		expect(steps.some((step) => step.kind === "skill")).toBe(false);
		expect(visibleTraceSteps(steps).map((step) => step.title)).toEqual(["Request was aborted"]);
	});

	it.each([false, true])("retains settlement metadata without a live or historical card (aborted=%s)", (aborted) => {
		const records = [{ event: {
			type: "system_event" as const, eventType: "agent_settled",
			summary: aborted ? "aborted" : "settled", detail: { aborted },
		} }];
		const live = traceStepsFromEvents(records);
		expect(live).toHaveLength(1);
		expect(live[0]?.eventDetail).toEqual({ aborted });
		expect(visibleTraceSteps(live)).toEqual([]);
		expect(hasVisibleTraceSteps(live)).toBe(false);
		expect(visibleTraceSteps(finalizeTraceSteps(live))).toEqual([]);
	});

	it("keeps actual cancellation visible when hiding its settlement event", () => {
		const records = [
			{ event: { type: "system_event" as const, eventType: "agent_settled", summary: "aborted", detail: { aborted: true } } },
			{ event: { type: "aborted" as const, message: "Stopped by user", persisted: false } },
		];
		const visible = visibleTraceSteps(traceStepsFromEvents(records));
		expect(visible).toHaveLength(1);
		expect(visible[0]).toMatchObject({ kind: "error", text: "Stopped by user" });
		expect(traceTerminalState(records)).toEqual({ status: "aborted", reason: "Stopped by user" });
	});

	it("keeps content when native boundaries are missing without inventing its duration", () => {
		const steps = finalizeTraceSteps(traceStepsFromEvents([
			{ eventId: 1, occurredAt: at(0), event: { type: "thinking_delta", delta: "fallback" } },
			{ eventId: 2, occurredAt: at(2), event: { type: "thinking_end" } },
			{ eventId: 3, occurredAt: at(3), event: { type: "system_event", eventType: "queue_update", phase: "update" } },
		]));

		expect(steps.find((step) => step.kind === "thinking")).toMatchObject({ text: "fallback", status: "completed" });
		expect(steps.find((step) => step.kind === "thinking")?.durationMs).toBeUndefined();
		expect(steps.find((step) => step.kind === "system")?.durationMs).toBeUndefined();
	});

	it("keeps terminal status separate from an incomplete trace", () => {
		expect(traceTerminalState([
			{ eventId: 1, event: { type: "aborted", message: "Stopped by user", persisted: false } },
		])).toEqual({ status: "aborted", reason: "Stopped by user" });
		expect(traceTerminalState([
			{ eventId: 1, event: { type: "system_event", eventType: "message_start" } },
		])).toEqual({ status: "unknown" });
		expect(traceTerminalState([])).toBeUndefined();
	});

	it("restores terminal status for legacy traces during cold start", () => {
		expect(traceTerminalState([
			{
				eventId: 1,
				event: {
					type: "system_event",
					eventType: "message_end",
					summary: "stopReason: stop",
					detail: { stopReason: "stop" },
				},
			},
		])).toEqual({ status: "completed" });
		expect(traceTerminalState([
			{
				eventId: 1,
				event: { type: "system_event", eventType: "message_end", summary: "stopReason: toolUse", detail: { stopReason: "toolUse" } },
			},
		])).toEqual({ status: "unknown" });
		expect(traceTerminalState([
			{
				eventId: 1,
				event: { type: "system_event", eventType: "message_end", summary: "stopReason: error", detail: { stopReason: "error" } },
			},
		])).toMatchObject({ status: "error" });
		expect(traceTerminalState(undefined, "stop")).toEqual({ status: "completed" });
		expect(traceTerminalState(undefined, "length")).toMatchObject({ status: "error" });
	});

});
