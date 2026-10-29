import { describe, expect, it, vi } from "vitest";
import {
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
