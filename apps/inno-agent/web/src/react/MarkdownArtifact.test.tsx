// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownArtifact } from "./MarkdownArtifact.js";
import { isEnhancedCodeLanguage } from "./MarkdownRuntime.js";
import { settingsStore } from "../stores/settings-store.js";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}));

afterEach(cleanup);

describe("MarkdownArtifact", () => {
	it("renders the high-value response formats on one surface", async () => {
		const source = [
			"## 学习结果",
			"",
			"> [!NOTE]",
			"> 这是提示。",
			"",
			"| 项目 | 状态 |",
			"| --- | --- |",
			"| Markdown | 完成 |",
			"",
			"脚注说明[^1]。",
			"",
			"[^1]: 来自渲染测试。",
			"",
			"公式：\\(a^2+b^2=c^2\\)",
			"",
			"```typescript",
			"const ready = true;",
			"```",
		].join("\n");

		const { container, getByText } = render(<MarkdownArtifact content={source} />);

		expect(container.querySelector("h2")?.textContent).toBe("学习结果");
		expect(container.querySelector("table")?.textContent).toContain("Markdown");
		expect(container.querySelector(".markdown-alert")).not.toBeNull();
		expect(container.querySelector("[data-footnotes]")?.textContent).toContain("来自渲染测试");
		expect(container.querySelector(".katex")).not.toBeNull();
		expect(getByText("const ready = true;")).not.toBeNull();

		await waitFor(() => {
			expect(container.querySelector('[data-streamdown="code-block"]')).not.toBeNull();
		});
	});

	it("repairs an unfinished tail while tokens are still streaming", async () => {
		const { container } = render(<MarkdownArtifact content="正在生成 **重要内容" streaming />);

		await waitFor(() => {
			expect(container.querySelector('[data-streamdown="strong"]')?.textContent).toContain("重要内容");
			expect(container.textContent).not.toContain("**");
		});
	});

	it("animates a provider chunk character by character", async () => {
		const { container } = render(<MarkdownArtifact content="AB" streaming />);

		await waitFor(() => {
			const animatedCharacters = Array.from(container.querySelectorAll("span[data-sd-animate]"))
				.map((node) => node.textContent);
			expect(animatedCharacters).toEqual(["A", "B"]);
		});
	});

	it("does not mount executable raw elements from model output", () => {
		const { container } = render(
			<MarkdownArtifact content={'安全内容<script>window.__unsafe = true</script><iframe src="https://example.com"></iframe>'} />,
		);

		expect(container.querySelector("script")).toBeNull();
		expect(container.querySelector("iframe")).toBeNull();
		expect(container.textContent).toContain("安全内容");
	});

	it("renders a completed HTML fence in a restricted artifact frame", async () => {
		const html = [
			"```html",
			"<!doctype html><html><head><title>课程卡片</title>",
			"<meta http-equiv=\"refresh\" content=\"0;url=https://example.com\"></head>",
			"<body><h1>你好</h1><script>window.parent.__unsafe = true</script></body></html>",
			"```",
		].join("\n");
		const { container, getByRole } = render(<MarkdownArtifact content={html} />);

		await waitFor(() => expect(container.querySelector('[data-inno-artifact="html"]')).not.toBeNull());
		const frame = container.querySelector<HTMLIFrameElement>("iframe");
		expect(frame).not.toBeNull();
		expect(frame?.getAttribute("sandbox")).toBe("");
		expect(frame?.getAttribute("srcdoc")).toContain("Content-Security-Policy");
		expect(frame?.getAttribute("srcdoc")).not.toContain("http-equiv=\"refresh\"");
		expect(container.textContent).toContain("课程卡片");
		expect(getByRole("button", { name: "启用交互预览" })).not.toBeNull();
		fireEvent.click(getByRole("button", { name: "启用交互预览" }));
		expect(container.querySelector("iframe")?.getAttribute("sandbox")).toBe("allow-scripts");
		expect(container.querySelector("iframe")?.getAttribute("srcdoc")).toContain("script-src 'unsafe-inline'");
	});

	it("keeps an unfinished HTML artifact in source mode while streaming", async () => {
		const { container } = render(<MarkdownArtifact content={'```html\n<html><body><h1>仍在生成'} streaming />);

		await waitFor(() => expect(container.querySelector('[data-inno-artifact="html"]')).not.toBeNull());
		expect(container.querySelector("iframe")).toBeNull();
		expect(container.textContent).toContain("生成中");
		expect(container.textContent).toContain("仍在生成");
	});

	it("routes the additional Cherry-style diagram languages to special views", async () => {
		const source = [
			"```svg",
			'<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" /></svg>',
			"```",
			"",
			"```echarts",
			'{"xAxis":{"type":"category","data":["A"]},"yAxis":{},"series":[{"type":"bar","data":[1]}]}',
			"```",
		].join("\n");
		const { container } = render(<MarkdownArtifact content={source} />);

		await waitFor(() => {
			expect(container.querySelector('[data-inno-artifact="svg"]')).not.toBeNull();
			expect(container.querySelector('[data-inno-artifact="echarts"]')).not.toBeNull();
		});
	});

	it("does not let the generic code renderer intercept Mermaid diagrams", () => {
		expect(isEnhancedCodeLanguage("mermaid")).toBe(false);
		expect(isEnhancedCodeLanguage("typescript")).toBe(true);
	});

	it("sanitizes SVG preview elements, event handlers, and external paint URLs", async () => {
		const source = [
			"```svg",
			'<svg viewBox="0 0 10 10" onload="alert(1)"><script>alert(1)</script><foreignObject><div>unsafe</div></foreignObject><circle cx="5" cy="5" r="4" fill="url(https://attacker.example/p)" /></svg>',
			"```",
		].join("\n");
		const { container } = render(<MarkdownArtifact content={source} />);
		await waitFor(() => expect(container.querySelector('[data-inno-artifact="svg"] iframe')).not.toBeNull());
		const srcdoc = container.querySelector<HTMLIFrameElement>('iframe')?.getAttribute("srcdoc") ?? "";
		expect(srcdoc).not.toContain("<script");
		expect(srcdoc).not.toContain("foreignObject");
		expect(srcdoc).not.toContain("onload");
		expect(srcdoc).not.toContain("attacker.example");
		expect(srcdoc).toContain("circle");
	});

	it("keeps prices as text by default and assigns collision-safe heading ids", () => {
		const { container } = render(<MarkdownArtifact content={["## 价格", "", "套餐是 $20，折扣后 $15。", "", "## 价格"].join("\n")} />);
		const headings = Array.from(container.querySelectorAll("h2"));
		expect(container.querySelector(".katex")).toBeNull();
		expect(container.textContent).toContain("$20");
		expect(headings[0]?.id).toMatch(/^inno-.+-价格$/);
		expect(headings[1]?.id).toMatch(/^inno-.+-价格-2$/);
	});

	it("shows source context and asks before opening an external link", () => {
		const open = vi.spyOn(window, "open").mockImplementation(() => null);
		const { getByRole, getByText } = render(<MarkdownArtifact content="[参考来源](https://example.com/article)" />);
		const link = getByRole("link", { name: "参考来源" });
		fireEvent.mouseEnter(link.parentElement!);
		expect(getByRole("tooltip").textContent).toContain("example.com");
		fireEvent.click(link);
		expect(open).not.toHaveBeenCalled();
		expect(getByRole("dialog", { name: "打开外部链接确认" })).not.toBeNull();
		fireEvent.click(getByText("继续打开"));
		expect(open).toHaveBeenCalledWith("https://example.com/article", "_blank", "noopener,noreferrer");
		open.mockRestore();
	});

	it("adds rich-copy, Excel, and fullscreen actions to tables", () => {
		const { getByRole } = render(<MarkdownArtifact content={["| 项目 | 状态 |", "| --- | --- |", "| 表格 | 完成 |"].join("\n")} />);
		expect(getByRole("button", { name: "复制为富文本" })).not.toBeNull();
		expect(getByRole("button", { name: "导出 Excel" })).not.toBeNull();
		expect(getByRole("button", { name: "全屏查看表格" })).not.toBeNull();
	});

	it("can opt in to single-dollar math without changing LaTeX delimiters", () => {
		const previous = settingsStore.settings;
		settingsStore.settings = { ui: { theme: "light", closeBehavior: "ask", mathSingleDollar: true } } as typeof previous;
		try {
			const { container } = render(<MarkdownArtifact content="变量 $x+1$，价格仍可由用户自行决定写法。" />);
			expect(container.querySelector(".katex")).not.toBeNull();
		} finally {
			settingsStore.settings = previous;
		}
	});

	it("renders numbered Markdown sources as compact citation badges", () => {
		const { getByRole } = render(<MarkdownArtifact content="结论来自资料 [1](https://example.com/source)。" />);
		const citation = getByRole("link", { name: "引用 1：example.com" });
		expect(citation.textContent).toBe("1");
		expect(citation.className).toContain("rounded-full");
	});
});
