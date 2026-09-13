// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const echartsMock = vi.hoisted(() => {
	const init = vi.fn(() => ({
		setOption: vi.fn(),
		resize: vi.fn(),
		dispose: vi.fn(),
	}));
	return { init };
});

const resizeObserverMock = vi.hoisted(() => {
	const observe = vi.fn();
	const disconnect = vi.fn();
	const construct = vi.fn((_callback: ResizeObserverCallback) => ({ observe, disconnect }));
	return { observe, disconnect, construct };
});

class StubResizeObserver {
	constructor(callback: ResizeObserverCallback) {
		resizeObserverMock.construct(callback);
	}
	observe(target: Element) {
		resizeObserverMock.observe(target);
	}
	disconnect() {
		resizeObserverMock.disconnect();
	}
	unobserve() { /* noop */ }
}

vi.mock("echarts", () => echartsMock);
vi.mock("react-i18next", () => {
	// Return a stable t identity: a per-render arrow would bust the useMemo
	// that keys the chart effect, causing effect churn no production render
	// (react-i18next's t is stable) would see.
	const t = (_key: string, fallback?: string) => fallback ?? _key;
	const translation = { t };
	return { useTranslation: () => translation };
});

import { MarkdownArtifact } from "./MarkdownArtifact.js";

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	vi.unstubAllGlobals();
});

function chartSource(data: number[]): string {
	return [
		"```echarts",
		JSON.stringify({
			xAxis: { type: "category", data: ["一月", "二月"] },
			yAxis: { type: "value" },
			series: [{ type: "bar", data }],
		}),
		"```",
	].join("\n");
}

function jsonChartSource(data: number[]): string {
	return [
		"```json",
		JSON.stringify({
			xAxis: { type: "category", data: ["一月", "二月"] },
			yAxis: { type: "value" },
			series: [{ type: "bar", data }],
		}),
		"```",
	].join("\n");
}

function redundantlyWrappedJsonChartSource(data: number[], language = "text"): string {
	return [
		`\`\`\`\`${language}`,
		jsonChartSource(data),
		"````",
	].join("\n");
}

function sharedClosingJsonChartSource(data: number[]): string {
	const inner = jsonChartSource(data).split("\n");
	return ["```text", ...inner.slice(0, -1), "```"].join("\n");
}

describe("ECharts preview lifecycle", () => {
	it("auto-previews a completed fence while the message is streaming", async () => {
		const { container } = render(<MarkdownArtifact content={chartSource([120])} streaming />);

		await waitFor(() => expect(echartsMock.init).toHaveBeenCalledTimes(1));
		expect(container.querySelector('[data-inno-artifact="echarts"] .inno-markdown-echarts-host')).not.toBeNull();
		expect(container.querySelector('[data-inno-artifact="echarts"] .inno-markdown-content-status')).toBeNull();
		expect(container.querySelector('[data-inno-artifact="echarts"] .inno-markdown-artifact-source')).toBeNull();
	});

	it("keeps an unfinished fence in source mode until it closes", async () => {
		const incomplete = [
			"```echarts",
			JSON.stringify({ series: [{ type: "bar", data: [120] }] }),
		].join("\n");
		const { container } = render(<MarkdownArtifact content={incomplete} streaming />);

		await waitFor(() => expect(container.querySelector('[data-inno-artifact="echarts"]')).not.toBeNull());
		const artifact = container.querySelector('[data-inno-artifact="echarts"]')!;
		expect(artifact.textContent).toContain("生成中");
		expect(artifact.querySelector(".inno-markdown-artifact-source")).not.toBeNull();
		expect(echartsMock.init).not.toHaveBeenCalled();
	});

	it("auto-previews an ECharts option emitted in a JSON fence", async () => {
		const { container } = render(<MarkdownArtifact content={jsonChartSource([120, 200])} />);

		await waitFor(() => expect(echartsMock.init).toHaveBeenCalledTimes(1));
		expect(container.querySelector('[data-inno-artifact="json"] .inno-markdown-echarts-host')).not.toBeNull();
		expect(container.querySelector('[data-inno-artifact="json"] .inno-markdown-content-title')?.textContent).toBe("ECharts 图表");
	});

	it("unwraps a redundant text fence around an ECharts JSON fence", async () => {
		const { container } = render(<MarkdownArtifact content={redundantlyWrappedJsonChartSource([120, 200])} />);

		await waitFor(() => expect(echartsMock.init).toHaveBeenCalledTimes(1));
		expect(container.querySelector('[data-inno-artifact="json"] .inno-markdown-echarts-host')).not.toBeNull();
		expect(container.querySelector('[data-inno-artifact="text"]')).toBeNull();
	});

	it("unwraps the ecmarkdown wrapper used by model responses", async () => {
		const { container } = render(<MarkdownArtifact content={redundantlyWrappedJsonChartSource([120, 200], "ecmarkdown")} />);

		await waitFor(() => expect(echartsMock.init).toHaveBeenCalledTimes(1));
		expect(container.querySelector('[data-inno-artifact="json"] .inno-markdown-echarts-host')).not.toBeNull();
		expect(container.querySelector('[data-inno-artifact="ecmarkdown"]')).toBeNull();
	});

	it("unwraps a same-length wrapper that shares the inner closing fence", async () => {
		const { container } = render(<MarkdownArtifact content={sharedClosingJsonChartSource([120, 200])} />);

		await waitFor(() => expect(echartsMock.init).toHaveBeenCalledTimes(1));
		expect(container.querySelector('[data-inno-artifact="json"] .inno-markdown-echarts-host')).not.toBeNull();
		expect(container.querySelector('[data-inno-artifact="text"]')).toBeNull();
	});

	it("keeps ordinary JSON in the regular code renderer", async () => {
		const { container } = render(<MarkdownArtifact content={["```json", '{"enabled":true}', "```"].join("\n")} />);

		await waitFor(() => expect(container.querySelector("[data-inno-code-block]")).not.toBeNull());
		expect(container.querySelector('[data-inno-artifact="json"]')).toBeNull();
		expect(echartsMock.init).not.toHaveBeenCalled();
	});

	it("updates one chart instance when the completed option changes", async () => {
		const { rerender } = render(<MarkdownArtifact content={chartSource([120])} />);

		await waitFor(() => expect(echartsMock.init).toHaveBeenCalledTimes(1));
		const chart = echartsMock.init.mock.results[0]!.value;
		expect(chart.setOption).toHaveBeenCalledTimes(1);

		rerender(<MarkdownArtifact content={chartSource([120, 200])} />);
		await waitFor(() => expect(chart.setOption).toHaveBeenCalledTimes(2));
		expect(echartsMock.init).toHaveBeenCalledTimes(1);
		expect(chart.dispose).not.toHaveBeenCalled();
	});

	it("attaches a resize observer when a fence opened during streaming completes", async () => {
		vi.stubGlobal("ResizeObserver", StubResizeObserver);
		const incomplete = [
			"```echarts",
			JSON.stringify({ series: [{ type: "bar", data: [120] }] }),
		].join("\n");
		const { container, rerender } = render(<MarkdownArtifact content={incomplete} streaming />);

		// Mounted while the fence is open: no host div exists yet, so nothing
		// may be observed at this point.
		await waitFor(() => expect(container.querySelector('[data-inno-artifact="echarts"]')).not.toBeNull());
		expect(resizeObserverMock.construct).not.toHaveBeenCalled();

		rerender(<MarkdownArtifact content={chartSource([120])} streaming />);
		await waitFor(() => expect(resizeObserverMock.construct).toHaveBeenCalledTimes(1));
		const host = container.querySelector('[data-inno-artifact="echarts"] .inno-markdown-echarts-host');
		expect(host).not.toBeNull();
		expect(resizeObserverMock.observe).toHaveBeenCalledWith(host);
	});
});
