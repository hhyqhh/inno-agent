/**
 * Known-model catalog for the add-model wizard: real context window / max output /
 * capability flags per provider, so users do not have to hand-fill them.
 *
 * Source: models.dev aggregated catalog (derived from each vendor's official
 * docs), snapshot 2026-11-28; only non-deprecated chat models are listed.
 * `maxTokens` is capped at 131072 even where the vendor allows more output
 * (e.g. Kimi / DeepSeek allow up to 384K-1M): it is the per-request output
 * ceiling sent to the API, and a smaller value is always accepted while keeping
 * the context budget for input. `supportsImages` reflects image input only.
 * Ids are the exact strings the provider's API expects (Volcengine ids carry
 * a version suffix, e.g. doubao-seed-2-1-pro-260915).
 */

export interface CatalogModel {
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	supportsImages: boolean;
	/** Pre-selected / sorted first in the wizard. */
	recommended?: boolean;
}

/** Keyed by provider preset id (see provider-presets.ts). */
export const MODEL_CATALOG: Record<string, CatalogModel[]> = {
	deepseek: [
		{ id: "deepseek-flash", name: "DeepSeek V4.1 Flash 1017", contextWindow: 1048576, maxTokens: 131072, reasoning: true, supportsImages: true, recommended: true },
		{ id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", contextWindow: 1048576, maxTokens: 131072, reasoning: true, supportsImages: false, recommended: true },
	],
	kimi: [
		{ id: "kimi-k3.1-pro", name: "Kimi K3.1 Pro", contextWindow: 1048576, maxTokens: 131072, reasoning: true, supportsImages: true, recommended: true },
		{ id: "kimi-k3.1-pro-highspeed", name: "Kimi K3.1 Pro Highspeed", contextWindow: 1048576, maxTokens: 131072, reasoning: true, supportsImages: true },
		{ id: "kimi-k3", name: "Kimi K3", contextWindow: 1048576, maxTokens: 131072, reasoning: true, supportsImages: true },
	],
	minimax: [
		{ id: "MiniMax-M3", name: "MiniMax-M3", contextWindow: 1000000, maxTokens: 131072, reasoning: true, supportsImages: true, recommended: true },
		{ id: "MiniMax-M3.1-Flash", name: "MiniMax-M3.1-Flash", contextWindow: 1000000, maxTokens: 131072, reasoning: true, supportsImages: true },
	],
	xiaomimimo: [
		{ id: "mimo-v2.6-pro", name: "MiMo-V2.6-Pro", contextWindow: 1048576, maxTokens: 131072, reasoning: true, supportsImages: true, recommended: true },
		{ id: "mimo-v2.6-flash", name: "MiMo-V2.6-Flash", contextWindow: 1048576, maxTokens: 131072, reasoning: true, supportsImages: true },
		{ id: "mimo-v2.6-pro-ultraspeed", name: "MiMo-V2.6-Pro-UltraSpeed", contextWindow: 1048576, maxTokens: 131072, reasoning: true, supportsImages: true },
	],
	volcengine: [
		{ id: "doubao-seed-2-1-pro-260915", name: "Seed 2.1 Pro", contextWindow: 1024000, maxTokens: 131072, reasoning: true, supportsImages: true, recommended: true },
		{ id: "doubao-seed-2-1-lite-260915", name: "Seed 2.1 Lite", contextWindow: 1024000, maxTokens: 131072, reasoning: true, supportsImages: true, recommended: true },
		{ id: "doubao-seed-2-1-turbo-260628", name: "Seed 2.1 Turbo", contextWindow: 256000, maxTokens: 131072, reasoning: true, supportsImages: true },
		{ id: "doubao-seed-2-1-pro-260628", name: "Seed 2.1 Pro", contextWindow: 256000, maxTokens: 131072, reasoning: true, supportsImages: true },
		{ id: "doubao-seed-2-0-lite-260428", name: "Seed 2.0 Lite", contextWindow: 256000, maxTokens: 131072, reasoning: true, supportsImages: true },
		{ id: "doubao-seed-2-0-mini-260428", name: "Seed 2.0 Mini", contextWindow: 256000, maxTokens: 131072, reasoning: true, supportsImages: true },
		{ id: "doubao-seed-evolving", name: "Seed Evolving", contextWindow: 1024000, maxTokens: 131072, reasoning: true, supportsImages: true },
		{ id: "doubao-seed-character-260628", name: "Seed Character", contextWindow: 128000, maxTokens: 32000, reasoning: true, supportsImages: true },
		{ id: "deepseek-v4-1-flash-261017", name: "DeepSeek V4.1 Flash 1017", contextWindow: 1000000, maxTokens: 131072, reasoning: true, supportsImages: true },
		{ id: "deepseek-v4-1-flash-260910", name: "DeepSeek V4.1 Flash", contextWindow: 1000000, maxTokens: 131072, reasoning: true, supportsImages: true },
		{ id: "deepseek-v4-pro-ga-260813", name: "DeepSeek V4 Pro 0813", contextWindow: 1000000, maxTokens: 131072, reasoning: true, supportsImages: false },
		{ id: "deepseek-v4-flash-ga-260731", name: "DeepSeek V4 Flash 0731", contextWindow: 1000000, maxTokens: 131072, reasoning: true, supportsImages: false },
		{ id: "kimi-k3-1-pro-261024", name: "Kimi K3.1 Pro", contextWindow: 1048576, maxTokens: 131072, reasoning: true, supportsImages: true },
		{ id: "glm-5-3-flash-260828", name: "GLM-5.3-Flash", contextWindow: 1000000, maxTokens: 131072, reasoning: true, supportsImages: true },
		{ id: "glm-5-2-260617", name: "GLM-5.2", contextWindow: 1000000, maxTokens: 131072, reasoning: true, supportsImages: false },
	],
	bailian: [
		{ id: "qwen4-max", name: "Qwen4 Max", contextWindow: 1000000, maxTokens: 131072, reasoning: true, supportsImages: true },
		{ id: "qwen3.8-max", name: "Qwen3.8 Max", contextWindow: 1000000, maxTokens: 131072, reasoning: true, supportsImages: true, recommended: true },
		{ id: "qwen3.8-flash", name: "Qwen3.8 Flash", contextWindow: 1000000, maxTokens: 131072, reasoning: true, supportsImages: true },
		{ id: "qwen3.8-omni-flash", name: "Qwen3.8 Omni Flash", contextWindow: 1000000, maxTokens: 131072, reasoning: true, supportsImages: true },
		{ id: "qwen3.7-max", name: "Qwen3.7 Max", contextWindow: 1000000, maxTokens: 131072, reasoning: true, supportsImages: false },
		{ id: "qwen3.7-plus", name: "Qwen3.7 Plus", contextWindow: 1000000, maxTokens: 131072, reasoning: true, supportsImages: true, recommended: true },
		{ id: "qwen3.7-flash", name: "Qwen3.7 Flash", contextWindow: 1000000, maxTokens: 131072, reasoning: true, supportsImages: true },
		{ id: "qwen3.6-plus", name: "Qwen3.6 Plus", contextWindow: 1000000, maxTokens: 65536, reasoning: true, supportsImages: true },
		{ id: "qwen3.6-flash", name: "Qwen3.6 Flash", contextWindow: 1000000, maxTokens: 65536, reasoning: true, supportsImages: true },
		{ id: "qwen3.6-35b-a3b", name: "Qwen3.6 35B-A3B", contextWindow: 262144, maxTokens: 65536, reasoning: true, supportsImages: true },
		{ id: "qwen3.6-27b", name: "Qwen3.6 27B", contextWindow: 262144, maxTokens: 65536, reasoning: true, supportsImages: true },
		{ id: "qwen3.5-flash", name: "Qwen3.5 Flash", contextWindow: 1000000, maxTokens: 65536, reasoning: true, supportsImages: true },
		{ id: "qwen3.5-122b-a10b", name: "Qwen3.5 122B-A10B", contextWindow: 262144, maxTokens: 65536, reasoning: true, supportsImages: true },
		{ id: "qwen3.5-35b-a3b", name: "Qwen3.5 35B-A3B", contextWindow: 262144, maxTokens: 65536, reasoning: true, supportsImages: true },
		{ id: "qwen3.5-27b", name: "Qwen3.5 27B", contextWindow: 262144, maxTokens: 65536, reasoning: true, supportsImages: true },
		{ id: "qwen-plus", name: "Qwen Plus", contextWindow: 1000000, maxTokens: 32768, reasoning: true, supportsImages: false, recommended: true },
		{ id: "qwen-flash", name: "Qwen Flash", contextWindow: 1000000, maxTokens: 32768, reasoning: true, supportsImages: false },
		{ id: "qwen-max", name: "Qwen Max", contextWindow: 131072, maxTokens: 8192, reasoning: false, supportsImages: false },
		{ id: "qwen-long", name: "Qwen Long", contextWindow: 10000000, maxTokens: 8192, reasoning: false, supportsImages: false },
		{ id: "qwen3-coder-flash", name: "Qwen3 Coder Flash", contextWindow: 1000000, maxTokens: 65536, reasoning: false, supportsImages: false },
		{ id: "qwen3-vl-plus", name: "Qwen3-VL Plus", contextWindow: 262144, maxTokens: 32768, reasoning: true, supportsImages: true },
		{ id: "qwen3-omni-flash", name: "Qwen3-Omni Flash", contextWindow: 65536, maxTokens: 16384, reasoning: true, supportsImages: true },
		{ id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", contextWindow: 1000000, maxTokens: 131072, reasoning: true, supportsImages: false },
		{ id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", contextWindow: 1000000, maxTokens: 131072, reasoning: true, supportsImages: true },
		{ id: "deepseek-v4-flash-0731", name: "DeepSeek V4 Flash 0731", contextWindow: 1000000, maxTokens: 131072, reasoning: true, supportsImages: false },
		{ id: "deepseek-v3.2", name: "DeepSeek V3.2", contextWindow: 131072, maxTokens: 65536, reasoning: true, supportsImages: false },
		{ id: "kimi-k3.1-pro", name: "Kimi K3.1 Pro", contextWindow: 1048576, maxTokens: 131072, reasoning: true, supportsImages: true },
		{ id: "kimi-k3", name: "Kimi K3", contextWindow: 1048576, maxTokens: 131072, reasoning: true, supportsImages: true },
		{ id: "kimi-k2.6", name: "Moonshot Kimi K2.6", contextWindow: 262144, maxTokens: 16384, reasoning: true, supportsImages: true },
		{ id: "kimi-k2.5", name: "Moonshot Kimi K2.5", contextWindow: 262144, maxTokens: 32768, reasoning: true, supportsImages: true },
		{ id: "glm-5.3", name: "GLM-5.3", contextWindow: 1000000, maxTokens: 131072, reasoning: true, supportsImages: false },
		{ id: "glm-5.3-prime", name: "GLM-5.3 Prime", contextWindow: 1000000, maxTokens: 131072, reasoning: true, supportsImages: false },
		{ id: "glm-5.2", name: "GLM-5.2", contextWindow: 1000000, maxTokens: 128000, reasoning: true, supportsImages: false },
		{ id: "glm-5.1", name: "GLM-5.1", contextWindow: 202752, maxTokens: 128000, reasoning: true, supportsImages: false },
		{ id: "glm-5", name: "GLM-5", contextWindow: 202752, maxTokens: 16384, reasoning: true, supportsImages: false },
		{ id: "MiniMax-M2.5", name: "MiniMax-M2.5", contextWindow: 204800, maxTokens: 131072, reasoning: true, supportsImages: false },
	],
};

/** Catalog entries for a provider preset (empty for custom/unknown providers). */
export function catalogForProvider(providerId: string): CatalogModel[] {
	return MODEL_CATALOG[providerId] ?? [];
}

/**
 * Exact-id lookup. With a providerId, only that provider's entries are used
 * (same id can carry different limits per host); without one, the first match
 * across all providers wins so custom gateways still benefit.
 */
export function findCatalogModel(modelId: string, providerId?: string): CatalogModel | undefined {
	const id = modelId.trim().toLowerCase();
	if (!id) return undefined;
	const pools = providerId && MODEL_CATALOG[providerId] ? [MODEL_CATALOG[providerId]] : Object.values(MODEL_CATALOG);
	for (const pool of pools) {
		const hit = pool.find((m) => m.id.toLowerCase() === id);
		if (hit) return hit;
	}
	return undefined;
}
