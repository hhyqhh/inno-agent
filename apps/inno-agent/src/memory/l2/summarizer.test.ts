import { afterEach, describe, expect, it, vi } from "vitest";

const completeMock = vi.hoisted(() => vi.fn());

vi.mock("@earendil-works/pi-ai/compat", () => ({ complete: completeMock }));

import { summarizeContent, summarizeContentGrounded } from "./summarizer.js";

const model = {} as never;
const registry = {
	getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: "test-key", headers: {} }),
} as never;

afterEach(() => {
	completeMock.mockReset();
});

describe("grounded summaries", () => {
	it("accepts a grounded body only when markers and citations match exactly", async () => {
		completeMock.mockResolvedValue({
			stopReason: "stop",
			content: [{
				type: "text",
				text: "## Summary\n\nThe index reduces scans [1].\n\n```json\n{\"citations\":[{\"marker\":1,\"quote\":\"The index reduces scans.\"}]}\n```",
			}],
		});

		await expect(summarizeContentGrounded(model, registry, "Title", "The index reduces scans."))
			.resolves.toEqual({
				body: "## Summary\n\nThe index reduces scans [1].",
				citations: [{ marker: 1, quote: "The index reduces scans." }],
			});
		expect(completeMock).toHaveBeenCalledTimes(1);
	});

	it("falls back without citation markers when grounded JSON is malformed", async () => {
		completeMock
			.mockResolvedValueOnce({
				stopReason: "stop",
				content: [{
					type: "text",
					text: "## Summary\n\nThe index reduces scans [1].\n\n```json\n{\"citations\":[}\n```",
				}],
			})
			.mockResolvedValueOnce({
				stopReason: "stop",
				content: [{ type: "text", text: "## Summary\n\nThe index reduces scans [1]." }],
			});

		await expect(summarizeContentGrounded(model, registry, "Title", "The index reduces scans."))
			.resolves.toEqual({ body: "## Summary\n\nThe index reduces scans .", citations: null });
		expect(completeMock).toHaveBeenCalledTimes(2);
	});

	it("rejects citation gaps and trailing prose", async () => {
		completeMock
			.mockResolvedValueOnce({
				stopReason: "stop",
				content: [{
					type: "text",
					text: "Summary [1] [3].\n\n```json\n{\"citations\":[{\"marker\":1,\"quote\":\"one\"},{\"marker\":3,\"quote\":\"three\"}]}\n```\nextra",
				}],
			})
			.mockResolvedValueOnce({
				stopReason: "stop",
				content: [{ type: "text", text: "Plain fallback" }],
			});

		await expect(summarizeContentGrounded(model, registry, "Title", "one three"))
			.resolves.toEqual({ body: "Plain fallback", citations: null });
		expect(completeMock).toHaveBeenCalledTimes(2);
	});

	it("ignores citation-looking text inside code when validating the body", async () => {
		completeMock.mockResolvedValue({
			stopReason: "stop",
			content: [{
				type: "text",
				text: "Summary [1].\n\n`[9]`\n\n```json\n{\"citations\":[{\"marker\":1,\"quote\":\"one\"}]}\n```",
			}],
		});

		await expect(summarizeContentGrounded(model, registry, "Title", "one"))
			.resolves.toMatchObject({ citations: [{ marker: 1 }] });
	});
});

describe("L2 summarizer", () => {
	it("passes short source content to the configured model unchanged", async () => {
		completeMock.mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "## 摘要\n\n结果" }],
		});

		await expect(summarizeContent(model, registry, "标题", "短资料正文")).resolves.toBe("## 摘要\n\n结果");
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
