import { afterEach, describe, expect, it, vi } from "vitest";

const completeMock = vi.hoisted(() => vi.fn());

vi.mock("@earendil-works/pi-ai", () => ({ complete: completeMock }));

import { summarizeContent } from "./summarizer.js";

const model = {} as never;
const registry = {
	getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: "test-key", headers: {} }),
} as never;

afterEach(() => {
	completeMock.mockReset();
});

describe("L2 summarizer", () => {
	it("passes short source content to the configured model unchanged", async () => {
		completeMock.mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "## 摘要\n\n结果" }],
		});

		await expect(summarizeContent(model, registry, "标题", "短资料正文")).resolves.toBe("## 摘要\n\n结果\n");
		const prompt = completeMock.mock.calls[0][1].messages[0].content[0].text as string;
		expect(prompt).toContain("短资料正文");
		expect(prompt).not.toContain("内容已截断");
	});

	it("returns null when the model reports an error", async () => {
		completeMock.mockResolvedValue({ stopReason: "error", errorMessage: "provider unavailable", content: [] });
		await expect(summarizeContent(model, registry, "标题", "正文")).resolves.toBeNull();
	});

	it("preserves a key fact that appears after the first 50,000 characters", async () => {
		const tailFact = "TAIL_FACT_长文档末尾事实";
		completeMock.mockImplementation(async (_model, request) => {
			const prompt = request.messages[0].content[0].text as string;
			if (prompt.includes("把同一份长资料的分块分析合并")) {
				return { stopReason: "stop", content: [{ type: "text", text: `## 摘要\n\n${tailFact}` }] };
			}
			return {
				stopReason: "stop",
				content: [{ type: "text", text: prompt.includes(tailFact) ? tailFact : "分块摘要" }],
			};
		});

		const content = `${"前文。\n\n".repeat(8_000)}${tailFact}`;
		await expect(summarizeContent(model, registry, "长资料", content)).resolves.toContain(tailFact);
		const prompts = completeMock.mock.calls.map((call) => call[1].messages[0].content[0].text as string);
		expect(prompts.some((prompt) => prompt.includes(tailFact))).toBe(true);
		expect(prompts.every((prompt) => !prompt.includes("内容已截断"))).toBe(true);
	});
});
