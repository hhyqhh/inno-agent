import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StreamEventEnvelope } from "../chat/stream-registry.js";
import type { SessionMessageSummary } from "./session-model.js";
import {
	clearSessionTraces,
	mergeSessionTraces,
	recordSessionTrace,
	resetTraceStoreForTests,
	traceMetadataPath,
} from "./trace-store.js";
import { readJson } from "../storage/file-store.js";

let dataDir: string;

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "inno-traces-"));
	resetTraceStoreForTests();
});

afterEach(() => {
	resetTraceStoreForTests();
	rmSync(dataDir, { recursive: true, force: true });
});

function envelope(eventId: number, event: Record<string, unknown>): StreamEventEnvelope {
	return {
		eventId,
		sessionId: "session-1",
		turnId: "turn-1",
		clientRequestId: "request-1",
		traceId: "turn-1",
		occurredAt: `2026-09-01T00:00:0${eventId}.000Z`,
		event: { type: event.type as string, ...event },
	};
}

describe("session UI trace sidecar", () => {
	it("persists normalized events and merges them by assistant message index", () => {
		recordSessionTrace(dataDir, "session-1", {
			assistantIndex: 1,
			assistantMessageId: "assistant-entry",
			startedAt: "2026-09-01T00:00:00.000Z",
			finishedAt: "2026-09-01T00:00:03.000Z",
			events: [envelope(1, { type: "thinking_start" }), envelope(2, { type: "thinking_end" })],
		});

		const messages: SessionMessageSummary[] = [
			{ role: "user", content: "hello", timestamp: 1 },
			{ role: "assistant", content: "answer", timestamp: 2, entryId: "assistant-entry" },
		];
		const merged = mergeSessionTraces(dataDir, "session-1", messages);

		expect(merged[0]?.traceEvents).toBeUndefined();
			expect(merged[1]).toMatchObject({
			traceStartedAt: "2026-09-01T00:00:00.000Z",
			traceFinishedAt: "2026-09-01T00:00:03.000Z",
		});
		expect(merged[1]?.traceEvents).toEqual([
			{ eventId: 1, traceId: "turn-1", occurredAt: "2026-09-01T00:00:01.000Z", event: { type: "thinking_start" } },
			{ eventId: 2, traceId: "turn-1", occurredAt: "2026-09-01T00:00:02.000Z", event: { type: "thinking_end" } },
		]);
		expect(readJson(traceMetadataPath(dataDir), null)).toBeTruthy();
 	});

	it("can be dropped without changing canonical messages", () => {
		recordSessionTrace(dataDir, "session-1", {
			assistantIndex: 0,
			events: [envelope(1, { type: "text_delta", delta: "answer" })],
		});
		clearSessionTraces(dataDir, "session-1");

		const messages: SessionMessageSummary[] = [{ role: "assistant", content: "answer", timestamp: 1 }];
		expect(mergeSessionTraces(dataDir, "session-1", messages)).toEqual(messages);
	});

	it("persists the active workspace on trace events", () => {
		recordSessionTrace(dataDir, "session-1", {
			assistantIndex: 0,
			workspaceId: "workspace-1",
			events: [envelope(1, { type: "tool_start", toolName: "read_file", args: { path: "notes.md" } })],
		});

		const messages: SessionMessageSummary[] = [{ role: "assistant", content: "answer", timestamp: 1 }];
		expect(mergeSessionTraces(dataDir, "session-1", messages)[0]?.traceEvents?.[0]?.event.workspaceId)
			.toBe("workspace-1");
	});

	it("prefers the persisted PI message id when a branch changes message indexes", () => {
		recordSessionTrace(dataDir, "session-1", {
			assistantIndex: 4,
			assistantMessageId: "stable-assistant-entry",
			events: [envelope(1, { type: "text_delta", delta: "answer" })],
		});

		const messages: SessionMessageSummary[] = [
			{ role: "assistant", content: "answer", timestamp: 1, entryId: "stable-assistant-entry" },
		];
		expect(mergeSessionTraces(dataDir, "session-1", messages)[0]?.traceEvents).toHaveLength(1);
	});

	it("compacts consecutive delta runs into single events before persisting", () => {
		recordSessionTrace(dataDir, "session-1", {
			assistantIndex: 0,
			events: [
				envelope(1, { type: "thinking_start" }),
				envelope(2, { type: "thinking_delta", delta: "th" }),
				envelope(3, { type: "thinking_delta", delta: "inking" }),
				envelope(4, { type: "thinking_end" }),
				envelope(5, { type: "text_start" }),
				envelope(6, { type: "text_delta", delta: "an" }),
				envelope(7, { type: "text_delta", delta: "swer" }),
				envelope(8, { type: "tool_call_delta", toolCallId: "call-1", argsDelta: "{\"pa" }),
				envelope(9, { type: "tool_call_delta", toolCallId: "call-2", argsDelta: "{\"x" }),
				envelope(10, { type: "tool_call_delta", toolCallId: "call-1", argsDelta: "th\"}" }),
			],
		});

		const messages: SessionMessageSummary[] = [{ role: "assistant", content: "answer", timestamp: 1 }];
		const events = mergeSessionTraces(dataDir, "session-1", messages)[0]?.traceEvents ?? [];
		// Runs merge by kind (and by toolCallId for tool_call_delta); boundaries stay.
		expect(events.map((item) => item.event.type)).toEqual([
			"thinking_start",
			"thinking_delta",
			"thinking_end",
			"text_start",
			"text_delta",
			"tool_call_delta",
			"tool_call_delta",
			"tool_call_delta",
		]);
		expect(events[1]?.event.delta).toBe("thinking");
		expect(events[4]?.event.delta).toBe("answer");
		// call-2 interrupts the call-1 run, so the two call-1 deltas must not merge.
		expect(events[5]?.event.argsDelta).toBe("{\"pa");
		expect(events[6]?.event.argsDelta).toBe("{\"x");
		expect(events[7]?.event.argsDelta).toBe("th\"}");
		// The merged run keeps the first envelope's id and timestamp.
		expect(events[1]?.eventId).toBe(2);
		expect(events[4]?.occurredAt).toBe("2026-09-01T00:00:06.000Z");
	});
});
