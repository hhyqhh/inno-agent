import { describe, expect, it } from "vitest";
import { MODEL_CATALOG, catalogForProvider, findCatalogModel } from "./model-catalog.js";
import { inferModelMetadata } from "./model-metadata.js";
import { PROVIDER_PRESETS } from "./provider-presets.js";

describe("model catalog", () => {
	it("covers every non-custom provider preset with valid, unique entries", () => {
		for (const preset of PROVIDER_PRESETS.filter((p) => p.id !== "custom")) {
			const models = catalogForProvider(preset.id);
			expect(models.length, preset.id).toBeGreaterThan(0);
			expect(models.some((m) => m.recommended), `${preset.id} recommended`).toBe(true);
			expect(new Set(models.map((m) => m.id)).size, `${preset.id} unique ids`).toBe(models.length);
			for (const m of models) {
				expect(m.contextWindow).toBeGreaterThan(0);
				expect(m.maxTokens).toBeGreaterThan(0);
				expect(m.maxTokens).toBeLessThanOrEqual(m.contextWindow);
			}
		}
		expect(Object.keys(MODEL_CATALOG).every((id) => PROVIDER_PRESETS.some((p) => p.id === id))).toBe(true);
	});

	it("resolves exact ids case-insensitively, scoped by provider", () => {
		expect(findCatalogModel("DEEPSEEK-V4-PRO", "deepseek")?.contextWindow).toBe(1048576);
		expect(findCatalogModel("deepseek-v4-pro", "bailian")?.contextWindow).toBe(1000000);
		expect(findCatalogModel("nope")).toBeUndefined();
	});

	it("prefers catalog data over regex fallbacks and still falls back for unknown ids", () => {
		expect(inferModelMetadata("deepseek-flash", "deepseek")).toMatchObject({ contextWindow: 1048576, supportsImages: true, reasoning: true });
		expect(inferModelMetadata("deepseek-chat").contextWindow).toBe(128000);
		expect(inferModelMetadata("totally-unknown")).toMatchObject({ contextWindow: 128000, maxTokens: 8192 });
	});
});
