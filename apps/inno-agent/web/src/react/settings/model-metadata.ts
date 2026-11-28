/**
 * Static model metadata rules used to auto-fill context window / max output
 * tokens / capability flags when a user picks a model in the add-provider
 * wizard. Provider `/models` endpoints only return ids, so we infer the rest
 * from well-known model families. First matching rule wins; everything stays
 * editable in the advanced section afterwards.
 */

import { findCatalogModel } from "./model-catalog.js";

export interface ModelMetadata {
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	supportsImages: boolean;
}

interface ModelMetaRule {
	pattern: RegExp;
	contextWindow: number;
	maxTokens: number;
	reasoning?: boolean;
	supportsImages?: boolean;
}

const RULES: ModelMetaRule[] = [
	// DeepSeek
	{ pattern: /deepseek-reasoner/i, contextWindow: 128000, maxTokens: 8192, reasoning: true },
	{ pattern: /deepseek/i, contextWindow: 128000, maxTokens: 8192 },
	// Moonshot / Kimi
	{ pattern: /kimi-k2/i, contextWindow: 262144, maxTokens: 16384 },
	{ pattern: /moonshot-v1-8k/i, contextWindow: 8192, maxTokens: 8192 },
	{ pattern: /moonshot-v1-32k/i, contextWindow: 32768, maxTokens: 8192 },
	{ pattern: /moonshot-v1-128k/i, contextWindow: 131072, maxTokens: 8192 },
	{ pattern: /kimi|moonshot/i, contextWindow: 131072, maxTokens: 8192 },
	// MiniMax
	{ pattern: /minimax-m2/i, contextWindow: 204800, maxTokens: 8192 },
	{ pattern: /minimax/i, contextWindow: 1000000, maxTokens: 8192 },
	// Volcengine Doubao
	{ pattern: /doubao.*256k/i, contextWindow: 262144, maxTokens: 8192 },
	{ pattern: /doubao.*128k/i, contextWindow: 131072, maxTokens: 8192 },
	{ pattern: /doubao.*32k/i, contextWindow: 32768, maxTokens: 4096 },
	{ pattern: /doubao-seed/i, contextWindow: 262144, maxTokens: 16384 },
	{ pattern: /doubao/i, contextWindow: 131072, maxTokens: 8192 },
	// Xiaomi MiMo
	{ pattern: /mimo/i, contextWindow: 262144, maxTokens: 8192 },
	// Alibaba Qwen
	{ pattern: /qwq/i, contextWindow: 131072, maxTokens: 8192, reasoning: true },
	{ pattern: /qwen[0-9.]*-?vl|-vl-/i, contextWindow: 131072, maxTokens: 8192, supportsImages: true },
	{ pattern: /qwen3/i, contextWindow: 262144, maxTokens: 16384 },
	{ pattern: /qwen-max/i, contextWindow: 32768, maxTokens: 8192 },
	{ pattern: /qwen-plus/i, contextWindow: 131072, maxTokens: 8192 },
	{ pattern: /qwen-turbo/i, contextWindow: 1000000, maxTokens: 8192 },
	{ pattern: /qwen-long/i, contextWindow: 10000000, maxTokens: 8192 },
	{ pattern: /qwen/i, contextWindow: 131072, maxTokens: 8192 },
	// Common western families (for custom gateways)
	{ pattern: /claude/i, contextWindow: 200000, maxTokens: 64000, supportsImages: true },
	{ pattern: /gpt-5|gpt-4\.1|gpt-4o/i, contextWindow: 128000, maxTokens: 16384, supportsImages: true },
	{ pattern: /gemini/i, contextWindow: 1000000, maxTokens: 65536, supportsImages: true },
];

export const DEFAULT_MODEL_METADATA: ModelMetadata = {
	contextWindow: 128000,
	maxTokens: 8192,
	reasoning: false,
	supportsImages: false,
};

export function inferModelMetadata(modelId: string, providerId?: string): ModelMetadata {
	// Exact catalog entry first (real vendor numbers); regex rules only cover
	// ids the catalog does not know (older models, custom gateways).
	const known = findCatalogModel(modelId, providerId);
	if (known) {
		return {
			contextWindow: known.contextWindow,
			maxTokens: known.maxTokens,
			reasoning: known.reasoning,
			supportsImages: known.supportsImages,
		};
	}
	const rule = RULES.find((r) => r.pattern.test(modelId));
	if (!rule) return { ...DEFAULT_MODEL_METADATA };
	return {
		contextWindow: rule.contextWindow,
		maxTokens: rule.maxTokens,
		reasoning: rule.reasoning === true,
		supportsImages: rule.supportsImages === true,
	};
}
