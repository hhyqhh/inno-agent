// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownArtifact } from "./MarkdownArtifact.js";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (_key: string, fallback?: string) => fallback ?? _key,
	}),
}));

afterEach(cleanup);

if (typeof Element !== "undefined" && !Element.prototype.scrollTo) {
	Element.prototype.scrollTo = () => { /* noop */ };
}

describe("code block header actions", () => {
	it("keeps the normal header compact and leaves secondary tools in More", () => {
		const content = ["```typescript", "const ready = true;", "```"].join("\n");
		const { container, getByRole, queryByRole } = render(<MarkdownArtifact content={content} />);

		const header = container.querySelector('[data-streamdown="code-block-header"]');
		expect(header).not.toBeNull();
		const copyButton = header?.querySelector('button[aria-label="复制代码"]');
		expect(copyButton).not.toBeNull();
		expect(copyButton?.textContent).toContain("复制代码");
		expect(header?.querySelector('button[aria-label="运行代码"]')).toBeNull();
		const editButton = header?.querySelector('button[aria-label="编辑副本"]');
		expect(editButton).not.toBeNull();
		const moreButton = header?.querySelector('button[aria-label="更多"]');
		expect(moreButton).not.toBeNull();
		expect(moreButton?.textContent).toContain("更多");

		fireEvent.click(getByRole("button", { name: "更多" }));
		expect(queryByRole("menuitem", { name: "编辑副本" })).toBeNull();
		expect(getByRole("menuitem", { name: "自动换行" })).not.toBeNull();
		expect(queryByRole("menuitem", { name: "运行代码" })).toBeNull();
	});

	it("does not expose completion-only actions while a fence is streaming", async () => {
		const { container, queryByRole } = render(<MarkdownArtifact content={["```python", "print(1)"].join("\n")} streaming />);

		await waitFor(() => expect(container.querySelector('[data-streamdown="code-block-header"]')).not.toBeNull());
		expect(container.textContent).toContain("生成中");
		expect(queryByRole("button", { name: "运行代码" })).toBeNull();
		expect(queryByRole("button", { name: "更多" })).toBeNull();
	});

	it("gives an unlabelled ordinary fence the same title bar", async () => {
		const content = ["```", "1  338350", "2  338350", "```"].join("\n");
		const { container } = render(<MarkdownArtifact content={content} />);

		const block = container.querySelector('[data-streamdown="code-block"]');
		await waitFor(() => expect(block).not.toBeNull());
		expect(block?.querySelector('[data-streamdown="code-block-header"]')).not.toBeNull();
		expect(block?.querySelector('[data-streamdown="code-block-header"] > span')?.textContent).toBe("");
		expect(block?.querySelector('[data-streamdown="code-block-copy-button"]')).not.toBeNull();
	});

	it("gives an unknown ordinary fence the same title bar", async () => {
		const content = ["```output", "1  338350", "2  338350", "```"].join("\n");
		const { container } = render(<MarkdownArtifact content={content} />);

		const block = container.querySelector('[data-streamdown="code-block"]');
		await waitFor(() => expect(block).not.toBeNull());
		expect(block?.querySelector('[data-streamdown="code-block-header"]')).not.toBeNull();
		expect(block?.querySelector('[data-streamdown="code-block-header"] > span')?.textContent).toBe("output");
		expect(block?.querySelector('[data-streamdown="code-block-copy-button"]')).not.toBeNull();
	});
});
