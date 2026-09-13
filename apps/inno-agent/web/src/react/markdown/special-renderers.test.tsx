// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (_key: string, fallback?: string) => fallback ?? _key,
	}),
}));

// A renderer chunk can reject after Streamdown has already committed the
// message. Keep this test isolated from the real artifact implementation so
// the per-block boundary is exercised rather than the preview itself.
vi.mock("./ArtifactRenderers.js", () => ({
	HtmlArtifactRenderer: () => { throw new Error("simulated artifact chunk failure"); },
}));

vi.mock("./EnhancedCodeRenderer.js", () => ({
	EnhancedCodeRenderer: () => { throw new Error("simulated cold-start code renderer failure"); },
}));

import { MarkdownArtifact } from "../MarkdownArtifact.js";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("special markdown renderer failures", () => {
	it("keeps surrounding Markdown when the generic code renderer fails", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const source = [
			"前置文本仍然可见。",
			"",
			"```python",
			"print(1)",
			"```",
			"",
			"后置文本仍然可见。",
		].join("\n");

		const { container } = render(<MarkdownArtifact content={source} />);

		await waitFor(() => {
			expect(container.querySelector(".inno-markdown-code-fallback")?.textContent).toContain("print(1)");
		});
		expect(container.textContent).toContain("前置文本仍然可见。");
		expect(container.textContent).toContain("后置文本仍然可见。");
		expect(container.querySelector(".inno-markdown > pre")).toBeNull();
		expect(error).toHaveBeenCalled();
	});

	it("keeps the rest of the message and shows HTML source when its renderer fails", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const source = [
			"前置文本仍然可见。",
			"",
			"```html",
			"<!doctype html><html><body><h1>故障回退</h1></body></html>",
			"```",
			"",
			"后置文本仍然可见。",
		].join("\n");

		const { container } = render(<MarkdownArtifact content={source} />);

		// Suspense should show only the preview loading surface. Source is a
		// recovery path for a failed renderer, not a transient first paint.
		expect(container.querySelector('[data-inno-source-fallback]')).toBeNull();

		await waitFor(() => {
			expect(container.querySelector('[data-inno-content-block="artifact"]')).not.toBeNull();
		});
		await waitFor(() => expect(error).toHaveBeenCalled());

		expect(container.textContent).toContain("前置文本仍然可见。");
		expect(container.textContent).toContain("后置文本仍然可见。");
		expect(container.querySelector('[data-inno-source-fallback]')?.textContent).toContain("故障回退");
		expect(container.querySelector(".inno-markdown > pre")).toBeNull();
		expect(error).toHaveBeenCalled();
	});

	it("survives a renderer failure while the fence flips from streaming to complete", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const incomplete = ["前置文本仍然可见。", "", "```html", "<h1>故障回退</h1>", ""].join("\n");
		const complete = `${incomplete}\`\`\``;

		const { container, rerender } = render(<MarkdownArtifact content={incomplete} streaming />);
		// The renderer fails while the fence is still open, so the boundary
		// fallback renders its streaming (early-return) branch first.
		await waitFor(() => expect(error).toHaveBeenCalled());

		// Closing the fence flips isIncomplete on the same fallback instance.
		// A hook-order violation here would escalate to the outer boundary
		// and degrade the whole message to plain text.
		rerender(<MarkdownArtifact content={complete} streaming />);
		await waitFor(() => {
			expect(container.querySelector('[data-inno-source-fallback]')?.textContent).toContain("故障回退");
		});
		expect(container.textContent).toContain("前置文本仍然可见。");
		expect(container.querySelector(".inno-markdown > pre")).toBeNull();
	});
});
