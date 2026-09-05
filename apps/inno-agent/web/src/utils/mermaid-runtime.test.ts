import { describe, expect, it, vi } from "vitest";

// The chunk load is stateful per test: first attempt rejects (e.g. a hashed
// chunk missing after a redeploy), the retry succeeds.
const state = vi.hoisted(() => ({ fail: true }));

vi.mock("../react/MermaidMarkdownRuntime.js", () => {
	if (state.fail) throw new Error("simulated missing chunk");
	return { default: () => null };
});
vi.mock("../react/markdown/MermaidArtifactRenderer.js", () => ({ MermaidArtifactRenderer: () => null }));

import { getMermaidMarkdownRuntime, preloadMermaidMarkdownRuntime } from "./mermaid-runtime.js";

describe("mermaid runtime preload", () => {
	it("retries after a failed chunk load instead of disabling Mermaid for the session", async () => {
		// A throwing mock factory surfaces vitest's module-mock error wrapper;
		// what matters is that the preload rejects and does not poison the cache.
		await expect(preloadMermaidMarkdownRuntime()).rejects.toThrow();
		expect(getMermaidMarkdownRuntime()).toBeNull();

		state.fail = false;
		await preloadMermaidMarkdownRuntime();
		expect(getMermaidMarkdownRuntime()).not.toBeNull();
	});
});
