import { describe, expect, it } from "vitest";
import type { SessionStreamState } from "../../chat/stream-registry.js";
import type { SessionMessageSummary } from "../session-model.js";
import { confirmCompactionPersistence } from "./chat.js";

const notification = "上下文压缩完成：约 300,000 → 40,000 tokens。";
const state = {
	sessionId: "session-1",
	turnId: "turn-1",
	baselineSessionRevision: "before",
} as SessionStreamState;

function message(role: SessionMessageSummary["role"], content: string): SessionMessageSummary {
	return { role, content, timestamp: 1 };
}

function parsed(messages: SessionMessageSummary[]) {
	return {
		summary: {} as never,
		messages,
	};
}

describe("manual compaction persistence confirmation", () => {
	it("accepts a changed revision with the exact final assistant notification", () => {
		const result = confirmCompactionPersistence(
			() => parsed([message("user", "kept turn"), message("assistant", notification)]),
			() => "after",
			state,
			"/tmp/session.jsonl",
			notification,
		);
		expect(result).toEqual({ persisted: true, finalMessageCount: 2, finalSessionRevision: "after" });
	});

	it("rejects an unchanged revision even when the notification is visible", () => {
		const result = confirmCompactionPersistence(
			() => parsed([message("assistant", notification)]),
			() => "before",
			state,
			"/tmp/session.jsonl",
			notification,
		);
		expect(result.persisted).toBe(false);
		expect(result.finalMessageCount).toBe(1);
	});

	it.each([
		["missing notification", [message("assistant", "other response")]],
		["non-assistant final entry", [message("user", notification)]],
		["empty compacted history", []],
	])("rejects %s", (_name, messages) => {
		const result = confirmCompactionPersistence(
			() => parsed(messages),
			() => "after",
			state,
			"/tmp/session.jsonl",
			notification,
		);
		expect(result.persisted).toBe(false);
	});

	it("rejects an unreadable session file", () => {
		const result = confirmCompactionPersistence(
			() => null,
			() => "after",
			state,
			"/tmp/session.jsonl",
			notification,
		);
		expect(result).toEqual({ persisted: false, finalMessageCount: undefined, finalSessionRevision: "after" });
	});
});
