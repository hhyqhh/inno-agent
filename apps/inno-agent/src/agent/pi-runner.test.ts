import { describe, expect, it, vi } from "vitest";
import { finalizePromptRun, type PromptRunLifecycle, type PromptRunOutcome } from "./pi-runner.js";

const completed: PromptRunOutcome = { type: "completed", fullText: "ok" };

describe("prompt run finalization", () => {
	it("waits for onFinish before resolving the finalization boundary", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		let resolved = false;
		const lifecycle: PromptRunLifecycle = {
			onFinish: () => gate,
			onFinalizeFailure: vi.fn(),
		};
		const finalizing = finalizePromptRun(completed, lifecycle).then(() => { resolved = true; });
		await Promise.resolve();
		expect(resolved).toBe(false);
		release();
		await finalizing;
		expect(resolved).toBe(true);
	});

	it("runs forced finalization when the primary finalizer throws", async () => {
		const failure = new Error("persistence failed");
		const fallback = vi.fn().mockResolvedValue(undefined);
		await finalizePromptRun(completed, {
			onFinish: vi.fn().mockRejectedValue(failure),
			onFinalizeFailure: fallback,
		});
		expect(fallback).toHaveBeenCalledWith(completed, failure);
	});
});
