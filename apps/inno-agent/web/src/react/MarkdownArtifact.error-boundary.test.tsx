// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const runtimeState = vi.hoisted(() => ({ shouldThrow: true }));

vi.mock("./MarkdownRuntime.js", () => ({
	MarkdownRuntime: ({ content }: { content: string }) => {
		if (runtimeState.shouldThrow) throw new Error("simulated cold-start markdown failure");
		return <div data-testid="mock-markdown-runtime">{content}</div>;
	},
}));

import { MarkdownArtifact } from "./MarkdownArtifact.js";

afterEach(() => {
	cleanup();
	runtimeState.shouldThrow = true;
	vi.restoreAllMocks();
});

describe("MarkdownArtifact error recovery", () => {
	it("retries a transient cold-start failure when the source does not change", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const source = ["说明", "", "```python", "print(1)", "```"].join("\n");
		const { container } = render(<MarkdownArtifact content={source} />);

		expect(container.querySelector('[data-testid="mock-markdown-runtime"]')).toBeNull();
		expect(container.querySelector('[role="status"]')?.textContent).toContain("正在恢复");

		// The runtime becomes available after the failed first paint, while the
		// persisted message source remains byte-for-byte identical.
		runtimeState.shouldThrow = false;
		await waitFor(() => {
			expect(container.querySelector('[data-testid="mock-markdown-runtime"]')).not.toBeNull();
		}, { timeout: 1_000 });

		expect(container.querySelector("pre")).toBeNull();
		expect(error).toHaveBeenCalledWith(
		"[inno] Markdown rendering failed; falling back to plain text",
		expect.any(Error),
		);
	});
});
