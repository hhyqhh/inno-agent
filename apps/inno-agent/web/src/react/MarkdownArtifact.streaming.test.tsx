// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownArtifact } from "./MarkdownArtifact.js";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (_key: string, fallback?: string, vars?: Record<string, unknown>) => {
			const template = fallback ?? _key;
			if (!vars) return template;
			return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => String(vars[name] ?? match));
		},
	}),
}));

afterEach(cleanup);

// jsdom does not implement Element.scrollTo, which Streamdown's streaming
// caret calls; stub it so the render path matches a real browser.
if (typeof Element !== "undefined" && !Element.prototype.scrollTo) {
	Element.prototype.scrollTo = () => { /* noop */ };
}

const PYTHON_REPLY = [
	"介绍如下：",
	"",
	"```python",
	"import sys",
	"",
	"def run():",
	"    for i in range(20):",
	"        print(i * i)",
	"",
	"run()",
	"```",
	"",
].join("\n");

function chunksOf(full: string, step: number): string[] {
	const chunks: string[] = [];
	for (let end = step; end < full.length + step; end += step) {
		chunks.push(full.slice(0, Math.min(end, full.length)));
	}
	return chunks;
}

describe("streaming code block stability", () => {
	it("keeps the code-block chrome mounted and never drops a header button mid-stream", async () => {
		const chunks = chunksOf(PYTHON_REPLY, 6);
		const { container, rerender } = render(<MarkdownArtifact content={chunks[0]} streaming />);

		let chromeSeen = false;
		const buttonHistory: number[] = [];
		for (const chunk of chunks) {
			rerender(<MarkdownArtifact content={chunk} streaming />);
			// Let the async highlight settle, as a real browser paint would.
			await new Promise((resolve) => setTimeout(resolve, 60));
			const chrome = container.querySelector("[data-streamdown='code-block-header']");
			if (chromeSeen) {
				// Once the enhanced header exists it must not unmount mid-stream.
				expect(chrome).not.toBeNull();
			}
			if (chrome) {
				chromeSeen = true;
				expect(chrome.querySelector("[data-inno-toolbar-button] svg")).not.toBeNull();
				buttonHistory.push(chrome.querySelectorAll("button").length);
			}
		}

		expect(chromeSeen).toBe(true);
		expect(buttonHistory.length).toBeGreaterThan(3);
		for (let i = 1; i < buttonHistory.length; i += 1) {
			// Buttons may be added (Run appears when the fence closes, collapse
			// when the block grows) but never removed — a removal per chunk was
			// the "restore original" flash caused by effect-lagged state.
			expect(buttonHistory[i]).toBeGreaterThanOrEqual(buttonHistory[i - 1]);
		}
	});

	it("does not offer restore-original on a pristine static render", async () => {
		const { container } = render(<MarkdownArtifact content={PYTHON_REPLY} />);
		await new Promise((resolve) => setTimeout(resolve, 500));
		const labels = Array.from(container.querySelectorAll("button")).map((b) => b.getAttribute("aria-label"));
		expect(labels).not.toContain("恢复模型原文");
	});

	it("keeps the code body mounted while the cold highlighter resolves", async () => {
		const { container } = render(<MarkdownArtifact content={PYTHON_REPLY} />);
		const body = container.querySelector("[data-inno-code-body]");

		expect(body).not.toBeNull();
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(container.querySelector("[data-inno-code-body]")).toBe(body);
	});

	it("keeps run code as a primary Python toolbar action", () => {
		const { container, getByRole, queryByRole } = render(<MarkdownArtifact content={PYTHON_REPLY} />);
		const runButton = getByRole("button", { name: "运行代码" });

		expect(runButton.closest('[data-streamdown="code-block-header"]')).not.toBeNull();
		expect(queryByRole("menuitem", { name: "运行代码" })).toBeNull();
		expect(container.querySelector('[data-streamdown="code-block-header"] button[aria-label="运行代码"]')).toBe(runButton);
	});
});
