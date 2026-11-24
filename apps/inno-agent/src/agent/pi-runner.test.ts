import { describe, expect, it, vi } from "vitest";
import type { AgentSession, AgentSessionEvent, CompactionResult } from "@earendil-works/pi-coding-agent";
import {
	compactSessionManually,
	finalizePromptRun,
	getSession,
	getSessionIfInitialized,
	getCurrentSessionId,
	isNativeImageCapabilityError,
	isNativeImagePayloadError,
	isOversizedPayloadError,
	nativeImageModelKey,
	type PromptRunLifecycle,
	type PromptRunOutcome,
} from "./pi-runner.js";

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

describe("native image fallback classification", () => {
	it.each([
		"unknown variant 'image_url', expected 'text'",
		"This model does not support image input",
		"Vision content is unsupported by this endpoint",
		"400 Model only support text input Request id: 0217855120827721",
	])("recognizes provider capability rejection: %s", (message) => {
		expect(isNativeImagePayloadError(message)).toBe(true);
		expect(isNativeImageCapabilityError(message)).toBe(true);
	});

	it.each([
		"invalid image content: unsupported MIME format",
		"image_url base64 decode failed",
		"image input is too large",
	])("retries a bad payload without permanently disabling the model: %s", (message) => {
		expect(isNativeImagePayloadError(message)).toBe(true);
		expect(isNativeImageCapabilityError(message)).toBe(false);
	});

	it.each([
		"401 unauthorized",
		"413 context length exceeded",
		"rate limit exceeded",
	])("does not treat unrelated provider errors as image failures: %s", (message) => {
		expect(isNativeImagePayloadError(message)).toBe(false);
		expect(isNativeImageCapabilityError(message)).toBe(false);
	});

	it("isolates capability cache identities by endpoint", () => {
		const first = nativeImageModelKey({
			model: { provider: "custom", baseUrl: "https://one.example/v1", id: "vision" },
		} as never);
		const second = nativeImageModelKey({
			model: { provider: "custom", baseUrl: "https://two.example/v1", id: "vision" },
		} as never);
		expect(first).not.toBe(second);
	});
});

describe("oversized payload classification", () => {
	it.each([
		"413 <html><head><title>413 Request Entity Too Large</title></head></html>",
		"413 Request Entity Too Large",
		"request entity too large",
		"Payload Too Large",
	])("recognizes a proxy-level oversized rejection: %s", (message) => {
		expect(isOversizedPayloadError(message)).toBe(true);
		// Never a capability rejection: the model may still accept smaller images.
		expect(isNativeImageCapabilityError(message)).toBe(false);
	});

	it.each([
		"401 unauthorized",
		"rate limit exceeded",
		"unknown variant 'image_url', expected 'text'",
		undefined,
	])("ignores unrelated errors: %s", (message) => {
		expect(isOversizedPayloadError(message)).toBe(false);
	});
});


describe("read-only access before Agent initialization", () => {
	it("reports no active runtime without making data routes initialize the Agent", () => {
		expect(getSessionIfInitialized()).toBeNull();
		expect(getCurrentSessionId()).toBe("");
		expect(() => getSession()).toThrow("Session not initialized");
	});
});

describe("manual compaction execution", () => {
	const result: CompactionResult = {
		summary: "summary",
		firstKeptEntryId: "entry-1",
		tokensBefore: 300_000,
		estimatedTokensAfter: 40_000,
	};

	function fakeSession() {
		const listeners = new Set<(event: AgentSessionEvent) => void>();
		const session = {
			subscribe: vi.fn((listener: (event: AgentSessionEvent) => void) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			}),
			prompt: vi.fn(),
			compact: vi.fn(),
		};
		return {
			session: session as unknown as AgentSession,
			mock: session,
			emit(event: AgentSessionEvent) {
				for (const listener of listeners) listener(event);
			},
			listenerCount: () => listeners.size,
		};
	}

	it("uses native compaction when Smart Compact is unavailable", async () => {
		const fake = fakeSession();
		const events: AgentSessionEvent[] = [];
		fake.mock.compact.mockImplementation(async () => {
			fake.emit({ type: "compaction_start", reason: "manual" } as AgentSessionEvent);
			fake.emit({ type: "compaction_end", reason: "manual", result, aborted: false, willRetry: false } as AgentSessionEvent);
			return result;
		});
		await expect(compactSessionManually(fake.session, false, (event) => events.push(event))).resolves.toBe(result);
		expect(fake.mock.compact).toHaveBeenCalledOnce();
		expect(fake.mock.prompt).not.toHaveBeenCalled();
		expect(events.map((event) => event.type)).toEqual(["compaction_start", "compaction_end"]);
		expect(fake.listenerCount()).toBe(0);
	});

	it("waits for the real manual compaction_end after the Smart command returns", async () => {
		const fake = fakeSession();
		fake.mock.prompt.mockImplementation(async (command: string) => {
			expect(command).toBe("/smart-compact fast");
			// Model preparation has finished, but ctx.compact() starts on a later
			// event-loop turn; command return alone is not completion.
			await new Promise((resolve) => setTimeout(resolve, 0));
			fake.emit({ type: "compaction_start", reason: "manual" } as AgentSessionEvent);
			fake.emit({ type: "compaction_end", reason: "manual", result, aborted: false, willRetry: false } as AgentSessionEvent);
		});
		await expect(compactSessionManually(fake.session, true, () => {})).resolves.toBe(result);
		expect(fake.mock.prompt).toHaveBeenCalledWith("/smart-compact fast");
		expect(fake.mock.compact).not.toHaveBeenCalled();
	});

	it("fails instead of hanging when the Smart command never starts compaction", async () => {
		const fake = fakeSession();
		fake.mock.prompt.mockResolvedValue(undefined);
		await expect(compactSessionManually(fake.session, true, () => {})).rejects.toThrow("did not start compaction");
		expect(fake.listenerCount()).toBe(0);
	});

	it("surfaces a failed manual compaction_end", async () => {
		const fake = fakeSession();
		fake.mock.prompt.mockImplementation(async () => {
			fake.emit({ type: "compaction_start", reason: "manual" } as AgentSessionEvent);
			fake.emit({
				type: "compaction_end",
				reason: "manual",
				result: undefined,
				aborted: false,
				willRetry: false,
				errorMessage: "Compaction failed: provider unavailable",
			} as AgentSessionEvent);
		});
		await expect(compactSessionManually(fake.session, true, () => {})).rejects.toThrow("provider unavailable");
	});
});
