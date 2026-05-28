import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RuntimePaths } from "./runtime.js";

export type InnoProviderApi = "openai-completions" | "openai-responses" | "anthropic-messages" | string;

export interface InnoModelConfig {
	id: string;
	name: string;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
}

export interface InnoProviderConfig {
	baseUrl: string;
	apiKey: string;
	api?: InnoProviderApi;
	models: InnoModelConfig[];
}

export interface InnoSubagentsConfig {
	enabled: boolean;
}

export interface PersonalChannelConfig {
	enabled: boolean;
	personalOnly?: boolean;
	allowedUserIds?: string[];
}

export interface PersonalBridgeChannelConfig extends PersonalChannelConfig {
	mode: "bridge";
	sidecarBaseUrl: string;
}

export interface PersonalILinkChannelConfig extends PersonalChannelConfig {
	mode?: "ilink";
}

export interface InnoConfig {
	defaultProvider: string;
	defaultModel: string;
	providers: Record<string, InnoProviderConfig>;
	server?: {
		port: number;
	};
	feishu?: {
		appId: string;
		appSecret: string;
	};
	channels?: {
		feishu?: PersonalChannelConfig;
		qq?: PersonalBridgeChannelConfig;
		wechat?: PersonalBridgeChannelConfig | PersonalILinkChannelConfig;
		wecom?: { enabled: boolean };
	};
	bridge?: {
		token: string;
	};
	subagents?: InnoSubagentsConfig;
}

interface LegacyInnoConfig extends Partial<InnoConfig> {
	openai?: InnoProviderConfig;
}

const LEGACY_OPENAI_PROVIDER_ID = "openai-custom";

function firstConfiguredModel(providers: Record<string, InnoProviderConfig>): { provider: string; model: string } | undefined {
	for (const [provider, providerConfig] of Object.entries(providers)) {
		const model = providerConfig.models[0];
		if (model) return { provider, model: model.id };
	}
	return undefined;
}

export function normalizeModelConfig(model: Partial<InnoModelConfig> & { id: string }): InnoModelConfig {
	const id = model.id.trim();
	if (!id) throw new Error("Model id is required");
	const contextWindow = model.contextWindow;
	const maxTokens = model.maxTokens;
	return {
		id,
		name: (model.name?.trim() || id),
		reasoning: Boolean(model.reasoning),
		contextWindow: contextWindow !== undefined && Number.isFinite(contextWindow) && contextWindow > 0 ? Math.trunc(contextWindow) : 128000,
		maxTokens: maxTokens !== undefined && Number.isFinite(maxTokens) && maxTokens > 0 ? Math.trunc(maxTokens) : 8192,
	};
}

export function normalizeProviderConfig(provider: Partial<InnoProviderConfig>): InnoProviderConfig {
	const baseUrl = provider.baseUrl?.trim() ?? "";
	if (!baseUrl) throw new Error("Provider baseUrl is required");
	const models = (provider.models ?? []).map((model) => normalizeModelConfig(model));
	if (models.length === 0) throw new Error("Provider must include at least one model");
	return {
		baseUrl,
		apiKey: provider.apiKey ?? "",
		api: provider.api?.trim() || "openai-completions",
		models,
	};
}

export function normalizeConfig(config: LegacyInnoConfig): InnoConfig {
	const providers: Record<string, InnoProviderConfig> = {};
	for (const [providerId, providerConfig] of Object.entries(config.providers ?? {})) {
		const id = providerId.trim();
		if (!id) continue;
		providers[id] = normalizeProviderConfig(providerConfig);
	}

	if (Object.keys(providers).length === 0 && config.openai) {
		providers[LEGACY_OPENAI_PROVIDER_ID] = normalizeProviderConfig(config.openai);
	}

	if (Object.keys(providers).length === 0) {
		throw new Error("Config must define at least one provider in providers");
	}

	const fallback = firstConfiguredModel(providers);
	if (!fallback) throw new Error("Config must define at least one model");

	const defaultProvider = config.defaultProvider?.trim() || fallback.provider;
	const defaultModel = config.defaultModel?.trim() || fallback.model;
	const defaultProviderConfig = providers[defaultProvider];
	const hasDefaultModel = defaultProviderConfig?.models.some((model) => model.id === defaultModel);

	return {
		defaultProvider: hasDefaultModel ? defaultProvider : fallback.provider,
		defaultModel: hasDefaultModel ? defaultModel : fallback.model,
		providers,
		server: config.server,
		feishu: config.feishu,
		channels: config.channels,
		bridge: config.bridge,
		subagents: config.subagents,
	} as InnoConfig;
}

/**
 * Load the inno-agent config from the resolved runtime config path.
 */
export function loadConfig(configPathOrDir: string): InnoConfig {
	const configPath = configPathOrDir.endsWith(".json")
		? configPathOrDir
		: join(configPathOrDir, "config.json");
	try {
		const raw = readFileSync(configPath, "utf-8");
		return normalizeConfig(JSON.parse(raw) as LegacyInnoConfig);
	} catch (error) {
		throw new Error(
			`Failed to load Inno config from ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export function saveConfig(configPathOrDir: string, config: InnoConfig): InnoConfig {
	const configPath = configPathOrDir.endsWith(".json")
		? configPathOrDir
		: join(configPathOrDir, "config.json");
	const normalized = normalizeConfig(config);
	const dir = dirname(configPath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(configPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf-8");
	return normalized;
}

export function setDefaultModel(config: InnoConfig, provider: string, model: string): InnoConfig {
	const providerId = provider.trim();
	const modelId = model.trim();
	if (!providerId || !modelId) throw new Error("Provider and model are required");
	const providerConfig = config.providers[providerId];
	if (!providerConfig) throw new Error(`Provider ${providerId} not found`);
	if (!providerConfig.models.some((m) => m.id === modelId)) {
		throw new Error(`Model ${providerId}/${modelId} not found in config`);
	}
	config.defaultProvider = providerId;
	config.defaultModel = modelId;
	return normalizeConfig(config);
}

export function upsertProvider(
	config: InnoConfig,
	providerId: string,
	provider: InnoProviderConfig,
	options: { makeDefault?: boolean; preserveApiKey?: boolean } = {},
): InnoConfig {
	const id = providerId.trim();
	if (!id) throw new Error("Provider id is required");
	const existing = config.providers[id];
	const normalized = normalizeProviderConfig({
		...provider,
		apiKey:
			options.preserveApiKey && existing && (!provider.apiKey || provider.apiKey.startsWith("****"))
				? existing.apiKey
				: provider.apiKey,
	});
	config.providers[id] = normalized;
	if (options.makeDefault) {
		config.defaultProvider = id;
		config.defaultModel = normalized.models[0].id;
	}
	return normalizeConfig(config);
}

export function deleteProvider(config: InnoConfig, providerId: string): InnoConfig {
	const id = providerId.trim();
	if (!id) throw new Error("Provider id is required");
	if (!config.providers[id]) throw new Error(`Provider ${id} not found`);
	const remaining = Object.keys(config.providers).filter((k) => k !== id);
	if (remaining.length === 0) throw new Error("Cannot delete the last provider");
	delete config.providers[id];
	return normalizeConfig(config);
}

export function getConfiguredPort(config: InnoConfig, override?: number): number {
	if (override) return override;
	const envPort = process.env.INNO_PORT ? Number.parseInt(process.env.INNO_PORT, 10) : undefined;
	if (envPort && Number.isFinite(envPort)) return envPort;
	return config.server?.port ?? 3000;
}

/**
 * Get the data directory path for the project.
 */
export function getDataDir(projectDir: string): string {
	return join(projectDir, "data");
}

export function getRuntimeDataDir(paths: RuntimePaths): string {
	return paths.dataDir;
}

/**
 * Get the learner data directory path.
 */
export function getLearnerDataDir(projectDir: string): string {
	return join(projectDir, "data", "learner");
}

/**
 * Get the session directory path.
 */
export function getSessionDir(projectDir: string): string {
	return join(projectDir, "data", "sessions");
}

/**
 * Get the jobs directory path.
 */
export function getJobsDir(projectDir: string): string {
	return join(projectDir, "data", "jobs");
}

/**
 * Get the Inno Agent skills directory loaded by the PI resource loader.
 */
export function getSkillsDir(projectDir: string): string {
	return join(projectDir, ".inno", "skills");
}

/**
 * Get the L2 Wiki memory data directory path.
 */
export function getL2DataDir(projectDir: string): string {
	return join(projectDir, "data", "l2");
}
