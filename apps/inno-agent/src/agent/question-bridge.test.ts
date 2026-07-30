import { describe, expect, it, vi } from "vitest";
import { QuestionBridge } from "./question-bridge.js";

describe("QuestionBridge", () => {
	it("validates session, turn and question ids and accepts only the first response", async () => {
		const bridge = new QuestionBridge();
		const events: Array<Record<string, unknown>> = [];
		bridge.bindTurn({ sessionId: "s1", turnId: "t1", emit: (event) => events.push(event), timeoutMs: 10_000 });
		const answerPromise = bridge.ask({ questions: [] });
		const questionId = events[0].questionId as string;

		expect(bridge.respond({ sessionId: "wrong", turnId: "t1", questionId, result: { answers: [], cancelled: false } })).toBe("scope_mismatch");
		expect(bridge.respond({ sessionId: "s1", turnId: "t1", questionId, result: { answers: [], cancelled: false } })).toBe("accepted");
		expect(bridge.respond({ sessionId: "s1", turnId: "t1", questionId, result: { answers: [], cancelled: false } })).toBe("already_resolved");
		await expect(answerPromise).resolves.toEqual({ answers: [], cancelled: false });
		expect(events.at(-1)).toMatchObject({ type: "question_resolved", questionId });
	});

	it("times out a pending question and releases it", async () => {
		vi.useFakeTimers();
		try {
			const bridge = new QuestionBridge();
			bridge.bindTurn({ sessionId: "s1", turnId: "t1", emit: () => {}, timeoutMs: 25 });
			const answerPromise = bridge.ask({ questions: [] });
			await vi.advanceTimersByTimeAsync(25);
			await expect(answerPromise).resolves.toMatchObject({ cancelled: true, error: "timeout" });
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not carry a pending question into a different turn", async () => {
		const bridge = new QuestionBridge();
		const firstEvents: Array<Record<string, unknown>> = [];
		bridge.bindTurn({ sessionId: "s1", turnId: "t1", emit: (event) => firstEvents.push(event), timeoutMs: 10_000 });
		const firstAnswer = bridge.ask({ questions: [] });
		const oldQuestionId = firstEvents[0].questionId as string;
		bridge.bindTurn({ sessionId: "s2", turnId: "t2", emit: () => {}, timeoutMs: 10_000 });
		await expect(firstAnswer).resolves.toMatchObject({ cancelled: true, error: "superseded" });
		expect(bridge.respond({ sessionId: "s2", turnId: "t2", questionId: oldQuestionId, result: { answers: [], cancelled: false } })).toBe("not_found");
	});

	it("persists a pending question on ask and removes it on any resolution", async () => {
		const bridge = new QuestionBridge();
		const saved = new Map<string, unknown>();
		bridge.setPersistence({
			save: (sessionId, question) => saved.set(sessionId, question),
			remove: (sessionId) => saved.delete(sessionId),
		});
		bridge.bindTurn({ sessionId: "s1", turnId: "t1", emit: () => {}, timeoutMs: 10_000 });
		const answerPromise = bridge.ask({ questions: [{ question: "q?" }] });
		expect(saved.has("s1")).toBe(true);
		expect(saved.get("s1")).toMatchObject({ turnId: "t1", params: { questions: [{ question: "q?" }] } });

		bridge.respond({ sessionId: "s1", turnId: "t1", questionId: (saved.get("s1") as { questionId: string }).questionId, result: { answers: [], cancelled: false } });
		await answerPromise;
		expect(saved.has("s1")).toBe(false);
	});

	it("removes the persisted record when the turn is unbound (abort)", async () => {
		const bridge = new QuestionBridge();
		const saved = new Map<string, unknown>();
		bridge.setPersistence({
			save: (sessionId, question) => saved.set(sessionId, question),
			remove: (sessionId) => saved.delete(sessionId),
		});
		bridge.bindTurn({ sessionId: "s1", turnId: "t1", emit: () => {}, timeoutMs: 10_000 });
		const answerPromise = bridge.ask({ questions: [] });
		expect(saved.has("s1")).toBe(true);

		bridge.unbindTurn({ sessionId: "s1", turnId: "t1", reason: "cancelled" });
		await expect(answerPromise).resolves.toMatchObject({ cancelled: true, error: "cancelled" });
		expect(saved.has("s1")).toBe(false);
	});
});
