import { describe, expect, it } from "vitest";
import { StreamRegistry } from "./stream-registry.js";

function create(registry: StreamRegistry, sessionId = "session.jsonl") {
	return registry.createTurn({
		sessionId,
		clientRequestId: "client-1",
		workspaceId: "workspace-1",
		workspaceRoot: "/tmp/workspace-1",
		inputSnapshot: { prompt: "hello", submittedAt: new Date().toISOString(), images: [] },
		baselineMessageCount: 2,
		baselineSessionRevision: "10:1",
	});
}

describe("StreamRegistry", () => {
	it("assigns monotonic event ids and replays only events after the cursor", () => {
		const registry = new StreamRegistry();
		const state = create(registry);
		registry.publishStreamEvent(state, { type: "stream_state", status: "queued" });
		registry.publishStreamEvent(state, { type: "stream_state", status: "running" });
		registry.publishStreamEvent(state, { type: "text_delta", delta: "hello" });
		const replayed: number[] = [];
		registry.subscribe(state, 1, (event) => replayed.push(event.eventId))();
		expect(replayed).toEqual([2, 3]);
		expect(state.status).toBe("running");
	});

	it("reduces duplicate tool ids without duplicating aggregate state", () => {
		const registry = new StreamRegistry();
		const state = create(registry);
		registry.publishStreamEvent(state, { type: "stream_state", status: "running" });
		registry.publishStreamEvent(state, { type: "tool_start", toolCallId: "tool-1", toolName: "read", args: { path: "a" } });
		registry.publishStreamEvent(state, { type: "tool_start", toolCallId: "tool-1", toolName: "read", args: { path: "b" } });
		expect(state.activeTools).toHaveLength(1);
		registry.publishStreamEvent(state, { type: "tool_end", toolCallId: "tool-1", toolName: "read", result: "ok", isError: false });
		registry.publishStreamEvent(state, { type: "tool_end", toolCallId: "tool-1", toolName: "read", result: "ok", isError: false });
		expect(state.activeTools).toHaveLength(0);
		expect(state.completedTools).toHaveLength(1);
	});

	it("allows only the first terminal transition", () => {
		const registry = new StreamRegistry();
		const state = create(registry);
		registry.publishStreamEvent(state, { type: "stream_state", status: "running" });
		const first = registry.finishTurn(state, "completed", { type: "done", fullText: "ok" }, { persisted: true, finalMessageCount: 4, finalSessionRevision: "20:2" });
		const duplicate = registry.finishTurn(state, "error", { type: "error", message: "late" }, { persisted: false });
		expect(first?.eventId).toBe(2);
		expect(duplicate).toBeUndefined();
		expect(state.status).toBe("completed");
		expect(state.history).toHaveLength(2);
	});

	it("never expires active turns and keeps a newer latest mapping", () => {
		const registry = new StreamRegistry();
		const active = create(registry, "active.jsonl");
		expect(registry.cleanupExpiredTurns(Date.now() + 1_000_000, 1)).toBe(0);
		expect(registry.getLatest("active.jsonl")).toBe(active);

		const old = create(registry, "shared.jsonl");
		registry.publishStreamEvent(old, { type: "stream_state", status: "running" });
		registry.finishTurn(old, "completed", { type: "done", fullText: "" }, { persisted: true });
		old.finishedAt = new Date(0).toISOString();
		const latest = create(registry, "shared.jsonl");
		expect(registry.cleanupExpiredTurns(Date.now(), 1)).toBe(1);
		expect(registry.getLatest("shared.jsonl")).toBe(latest);
	});

	it("isolates failing subscribers and still records the terminal event", () => {
		const registry = new StreamRegistry();
		const state = create(registry);
		const received: number[] = [];
		registry.subscribe(state, 0, () => { throw new Error("closed response"); });
		registry.subscribe(state, 0, (event) => received.push(event.eventId));
		registry.publishStreamEvent(state, { type: "stream_state", status: "running" });
		registry.finishTurn(state, "completed", { type: "done", fullText: "ok" }, { persisted: true });
		expect(received).toEqual([1, 2]);
		expect(state.history.at(-1)?.event.type).toBe("done");
		expect(state.status).toBe("completed");
	});

	it("rejects illegal or duplicate transitions", () => {
		const registry = new StreamRegistry();
		const state = create(registry);
		expect(() => registry.finishTurn(state, "completed", { type: "done", fullText: "" }, { persisted: true })).toThrow(/invalid stream transition/);
		registry.publishStreamEvent(state, { type: "stream_state", status: "running" });
		expect(() => registry.publishStreamEvent(state, { type: "stream_state", status: "running" })).toThrow(/invalid stream transition/);
		expect(() => registry.publishStreamEvent(state, { type: "stream_state", status: "queued" })).toThrow(/invalid stream transition/);
		registry.finishTurn(state, "aborted", { type: "aborted" }, { persisted: false });
		expect(() => registry.publishStreamEvent(state, { type: "text_delta", delta: "late" })).toThrow(/after terminal/);
	});

	it("compacts terminal text and public image snapshots", () => {
		const registry = new StreamRegistry();
		const state = registry.createTurn({
			sessionId: "session.jsonl",
			clientRequestId: "client-1",
			workspaceId: "workspace one",
			workspaceRoot: "/private/workspace",
			inputSnapshot: {
				prompt: "hello",
				submittedAt: new Date().toISOString(),
				images: [{ mimeType: "image/png", workspacePath: ".chat-images/a.png" }],
			},
			baselineMessageCount: 0,
			baselineSessionRevision: "0:0",
		});
		registry.publishStreamEvent(state, { type: "stream_state", status: "running" });
		const terminal = registry.finishTurn(state, "completed", { type: "done", fullText: "x".repeat(300_000) }, { persisted: true });
		expect((terminal?.event.fullText as string).length).toBeLessThan(300_000);
		const snapshot = registry.toPublicSnapshot(state);
		expect(snapshot).not.toHaveProperty("workspaceRoot");
		expect(snapshot.inputSnapshot.images[0].previewUrl).toContain("/api/workspace/raw?");
		expect(snapshot.inputSnapshot.images[0].previewUrl).not.toContain("/private/workspace");
	});
});
