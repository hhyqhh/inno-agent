import { describe, expect, it } from "vitest";
import { buildContextUsage } from "./context-usage.js";

type Input = Parameters<typeof buildContextUsage>[1];
function fixture(overrides: Partial<Input> = {}): Input {
	return {
		getContextUsage: () => ({ tokens: 65700, contextWindow: 262144, percent: 25.06 }),
		systemPrompt: "System instructions. <available_skills>skill list</available_skills>",
		getActiveToolNames: () => ["read", "docs_search"],
		getAllTools: () => [
			{ name: "read", description: "Read a file", parameters: {}, sourceInfo: { path: "builtin" } },
			{ name: "docs_search", description: "Search docs", parameters: {}, sourceInfo: { path: "/node_modules/pi-mcp-adapter/index.ts" } },
			{ name: "disabled", description: "x".repeat(10000), parameters: {}, sourceInfo: { path: "builtin" } },
		] as never,
		messages: [{ role: "assistant", content: [{ type: "text", text: "Hello" }], stopReason: "stop",
			usage: { input: 64000, output: 1700, cacheRead: 0, cacheWrite: 0 } }] as never,
		...overrides,
	};
}

describe("buildContextUsage", () => {
	it("calibrates categories to SDK total without exposing content", () => {
		const result = buildContextUsage("session", fixture());
		expect(result.tokens).toBe(65700);
		expect(result.percent).toBeCloseTo(25.0625, 2);
		expect(result.source).toBe("sdk");
		expect(result.breakdown.reduce((sum, p) => sum + p.tokens, 0)).toBe(result.tokens);
		expect(result.breakdown.find((p) => p.id === "mcp")!.tokens).toBeGreaterThan(0);
		expect(result.breakdown.find((p) => p.id === "skills")!.tokens).toBeGreaterThan(0);
		expect(JSON.stringify(result)).not.toContain("System instructions");
		expect(JSON.stringify(result)).not.toContain("docs_search");
	});
	it("ignores inactive tool schemas", () => {
		const s = fixture();
		expect(buildContextUsage("s", s)).toEqual(buildContextUsage("s", fixture({ getAllTools: () => s.getAllTools().slice(0, 2) })));
	});
	it("does not turn unknown post-compaction usage into zero or old estimates", () => {
		const result = buildContextUsage("s", fixture({ getContextUsage: () => ({ tokens: null, percent: null, contextWindow: 1000 }) }));
		expect(result).toMatchObject({ status: "pending", tokens: null, percent: null, breakdown: [] });
	});
	it("includes prompt and schemas before the first provider response", () => {
		const result = buildContextUsage("s", fixture({ messages: [], getContextUsage: () => ({ tokens: 0, percent: 0, contextWindow: 1000 }) }));
		expect(result.source).toBe("estimated");
		expect(result.tokens).toBeGreaterThan(0);
		expect(result.breakdown.find((p) => p.id === "messages")!.tokens).toBe(0);
	});
	it("keeps over-capacity usage and supports empty context", () => {
		expect(buildContextUsage("s", fixture({ getContextUsage: () => ({ tokens: 2000, percent: 200, contextWindow: 1000 }) })).percent).toBe(200);
		const empty = buildContextUsage("s", fixture({ messages: [], systemPrompt: "", getAllTools: () => [] }));
		expect(empty.tokens).toBe(0);
		expect(empty.breakdown.every((p) => p.tokens === 0)).toBe(true);
	});
	it("handles no model and invalid totals", () => {
		expect(buildContextUsage("s", fixture({ getContextUsage: () => undefined })).status).toBe("unavailable");
		expect(buildContextUsage("s", fixture({ getContextUsage: () => ({ tokens: NaN, percent: NaN, contextWindow: 1000 }) })).status).toBe("unavailable");
	});
});
