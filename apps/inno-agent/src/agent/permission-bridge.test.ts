import { describe, expect, it, vi } from "vitest";
import { PermissionBridge } from "./permission-bridge.js";

describe("PermissionBridge", () => {
	it("denies fail-closed when no turn is bound", async () => {
		const bridge = new PermissionBridge();
		await expect(bridge.authorize({ requestId: "r1", toolName: "bash", command: "rm -rf /tmp/x" }))
			.resolves.toMatchObject({ kind: "deny", reason: expect.stringContaining("no active web session") });
	});

	it("validates scope and accepts only the first response", async () => {
		const bridge = new PermissionBridge();
		const events: Array<Record<string, unknown>> = [];
		bridge.bindTurn({ sessionId: "s1", turnId: "t1", emit: (event) => events.push(event), timeoutMs: 10_000 });
		const verdictPromise = bridge.authorize({ requestId: "r1", toolName: "bash", command: "npm install" });
		expect(events[0]).toMatchObject({ type: "permission_request", requestId: "r1", command: "npm install" });

		expect(bridge.respond({ sessionId: "wrong", turnId: "t1", requestId: "r1", decision: "allow_once" })).toBe("scope_mismatch");
		expect(bridge.respond({ sessionId: "s1", turnId: "t1", requestId: "r1", decision: "allow_once" })).toBe("accepted");
		expect(bridge.respond({ sessionId: "s1", turnId: "t1", requestId: "r1", decision: "deny" })).toBe("already_resolved");
		await expect(verdictPromise).resolves.toEqual({ kind: "allow" });
		expect(events.at(-1)).toMatchObject({ type: "permission_resolved", requestId: "r1", allowed: true });
	});

	it("maps a deny decision to a teaching reason", async () => {
		const bridge = new PermissionBridge();
		bridge.bindTurn({ sessionId: "s1", turnId: "t1", emit: () => {}, timeoutMs: 10_000 });
		const verdictPromise = bridge.authorize({ requestId: "r1", toolName: "bash", command: "npm publish" });
		bridge.respond({ sessionId: "s1", turnId: "t1", requestId: "r1", decision: "deny", reason: "不要发布这个包" });
		await expect(verdictPromise).resolves.toEqual({ kind: "deny", reason: "不要发布这个包" });
	});

	it("times out a pending ask with a deny verdict", async () => {
		vi.useFakeTimers();
		try {
			const bridge = new PermissionBridge();
			bridge.bindTurn({ sessionId: "s1", turnId: "t1", emit: () => {}, timeoutMs: 25 });
			const verdictPromise = bridge.authorize({ requestId: "r1", toolName: "bash", command: "make test" });
			await vi.advanceTimersByTimeAsync(25);
			await expect(verdictPromise).resolves.toMatchObject({ kind: "deny", reason: expect.stringContaining("timed out") });
		} finally {
			vi.useRealTimers();
		}
	});

	it("denies a parked ask when the turn unbinds (abort/switch)", async () => {
		const bridge = new PermissionBridge();
		bridge.bindTurn({ sessionId: "s1", turnId: "t1", emit: () => {}, timeoutMs: 10_000 });
		const verdictPromise = bridge.authorize({ requestId: "r1", toolName: "bash", command: "make test" });
		bridge.unbindTurn({ sessionId: "s1", turnId: "t1", reason: "cancelled" });
		await expect(verdictPromise).resolves.toMatchObject({ kind: "deny", reason: expect.stringContaining("cancelled") });
	});

	it("replays session approvals without a new prompt", async () => {
		const bridge = new PermissionBridge();
		const events: Array<Record<string, unknown>> = [];
		bridge.bindTurn({ sessionId: "s1", turnId: "t1", emit: (event) => events.push(event), timeoutMs: 10_000 });

		const first = bridge.authorize({ requestId: "r1", toolName: "bash", command: "npm test" });
		bridge.respond({ sessionId: "s1", turnId: "t1", requestId: "r1", decision: "allow_session" });
		await expect(first).resolves.toEqual({ kind: "allow" });

		// Same (surface, value) → approved from cache even with no bound turn.
		bridge.unbindTurn({ sessionId: "s1", turnId: "t1", reason: "completed" });
		await expect(bridge.authorize({ requestId: "r2", toolName: "bash", command: "npm test" }))
			.resolves.toEqual({ kind: "allow" });
		// A different command still prompts/denies.
		await expect(bridge.authorize({ requestId: "r3", toolName: "bash", command: "npm publish" }))
			.resolves.toMatchObject({ kind: "deny" });
		expect(events.filter((event) => event.type === "permission_request")).toHaveLength(1);
	});

	it("does not carry a pending ask into a different turn", async () => {
		const bridge = new PermissionBridge();
		bridge.bindTurn({ sessionId: "s1", turnId: "t1", emit: () => {}, timeoutMs: 10_000 });
		const first = bridge.authorize({ requestId: "r1", toolName: "bash", command: "make test" });
		bridge.bindTurn({ sessionId: "s2", turnId: "t2", emit: () => {}, timeoutMs: 10_000 });
		await expect(first).resolves.toMatchObject({ kind: "deny", reason: expect.stringContaining("superseded") });
		expect(bridge.respond({ sessionId: "s2", turnId: "t2", requestId: "r1", decision: "allow_once" })).toBe("not_found");
	});
});
