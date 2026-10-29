import { afterEach, describe, expect, it } from "vitest";
import { complete, completeSimple } from "@earendil-works/pi-ai/compat";
import type { Model } from "@earendil-works/pi-ai";
import { normalizeModelConfig } from "../config.js";
import { completeWikiLlm } from "../memory/l2/wiki-llm-compat.js";
import { getConfiguredThinkingLevel, manualThinkingLevelMap, parseThinkingLevel, setThinkingLevelResolver, THINKING_LEVELS } from "./thinking-settings.js";

afterEach(() => setThinkingLevelResolver(() => undefined));
const config = { id: "gpt-6.1-sol", name: "GPT", reasoning: true, input: ["text"] as ["text"], contextWindow: 128000, maxTokens: 8192 };
const model = { ...config, api: "openai-responses", provider: "anthropic", baseUrl: "https://example.invalid/v1", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as Model<any>;

describe("optional manual thinking preference", () => {
	it("leaves legacy configs unchanged and roundtrips every explicit level", () => {
		expect(normalizeModelConfig(config)).not.toHaveProperty("thinkingLevel");
		for (const thinkingLevel of THINKING_LEVELS) expect(normalizeModelConfig({ ...config, thinkingLevel }).thinkingLevel).toBe(thinkingLevel);
	});
	it.each(["none", "automatic", 1, null, {}])("rejects invalid values %j", value => expect(() => parseThinkingLevel(value)).toThrow("Invalid thinkingLevel"));
	it("does not infer a preference from the model name or provider", () => expect(getConfiguredThinkingLevel(model)).toBeUndefined());
	it("reads live per-model preferences without borrowing another model's setting", () => {
		let level: "low" | "off" | undefined = "low";
		setThinkingLevelResolver(m => m.provider === model.provider && m.id === model.id ? level : undefined);
		expect(getConfiguredThinkingLevel(model)).toBe("low");
		expect(getConfiguredThinkingLevel({ ...model, id: "other" })).toBeUndefined();
		level = "off"; expect(getConfiguredThinkingLevel(model)).toBe("off");
		level = undefined; expect(getConfiguredThinkingLevel(model)).toBeUndefined();
	});
	it("only opts into extended SDK levels after explicit selection", () => {
		expect(manualThinkingLevelMap()).toBeUndefined();
		expect(manualThinkingLevelMap("low")).toBeUndefined();
		expect(manualThinkingLevelMap("max")).toEqual({ max: "max" });
	});
	it.each([undefined, "low", "high", "max", "off"] as const)("sends the selected effort %s through actual SDK chat and Wiki adapters", async level => {
		const payloads: any[] = [];
		const fetchStub = async (_input: any, init?: RequestInit) => {
			payloads.push(JSON.parse(String(init?.body)));
			// A valid terminal Responses event is enough to verify outbound parameters.
			return new Response('event: response.completed\ndata: '+JSON.stringify({ type: "response.completed", response: { id: "response-fixture", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } } })+'\n\n', { headers: { "Content-Type": "text/event-stream" } });
		};
		setThinkingLevelResolver(() => level);
		const selected = { ...model, thinkingLevelMap: manualThinkingLevelMap(level) };
		await completeWikiLlm(selected, { messages: [] }, { apiKey: "fixture", reasoning: "off", fetch: fetchStub });
		const expected = level === undefined || level === "off" ? "none" : level;
		expect(payloads[0]?.reasoning.effort).toBe(expected);
		await completeSimple(selected, { messages: [] }, { apiKey: "fixture", fetch: fetchStub, reasoning: level === "off" ? undefined : level });
		expect(payloads[1]?.reasoning.effort).toBe(expected);
		// Raw complete is intentionally not used for Wiki: it ignores provider-neutral reasoning.
		if (level === "low") {
			await complete(selected, { messages: [] }, { apiKey: "fixture", fetch: fetchStub, reasoning: "low" });
			expect(payloads[2]?.reasoning.effort).toBe("none");
		}
	});
});
