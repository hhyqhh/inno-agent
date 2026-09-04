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

import { MarkdownArtifact } from "../MarkdownArtifact.js";

afterEach(cleanup);

describe("special markdown renderer failures", () => {
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

		try {
			const { container } = render(<MarkdownArtifact content={source} />);

			await waitFor(() => {
				expect(container.querySelector('[data-inno-content-block="artifact"]')).not.toBeNull();
			});
			await waitFor(() => expect(error).toHaveBeenCalled());

			expect(container.textContent).toContain("前置文本仍然可见。");
			expect(container.textContent).toContain("后置文本仍然可见。");
			expect(container.querySelector('[data-inno-source-fallback]')?.textContent).toContain("故障回退");
			expect(container.querySelector(".inno-markdown > pre")).toBeNull();
			expect(error).toHaveBeenCalled();
		} finally {
			error.mockRestore();
		}
	});
});
