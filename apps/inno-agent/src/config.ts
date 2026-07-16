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
	headers?: Record<string, string>;
	authHeader?: boolean;
	bypassProxy?: boolean;
	models: InnoModelConfig[];
}

export interface InnoSubagentsConfig {
	enabled: boolean;
}

export interface InnoMemoryConfig {
	/**
	 * When true (default), the L1 learner profile is active: the per-turn
	 * context pack (profile + recent events) is injected into the system prompt
	 * and the learner tools record/update the profile. When false, the profile
	 * is neither read into the prompt nor written by tools.
	 */
	l1Enabled: boolean;
	/**
	 * When true (default), L2 Wiki memory is active: the `l2_archive` /
	 * `l2_query` tools can write and read the knowledge base. When false, those
	 * tools become no-ops that report L2 is disabled.
	 */
	l2Enabled: boolean;
	/**
	 * When true (default), L3 cross-conversation recall is active: past sessions
	 * are searched via sqlite and relevant snippets are auto-injected / the
	 * `l3_recall` tool is exposed. When false, replies use only the current
	 * workspace contents and the current session context.
	 */
	l3Enabled: boolean;
}

/**
 * Simple Mode. A global, opt-in switch (default OFF) that turns Inno into a
 * streamlined, ready-to-use experience: it force-locks the L1/L2/L3 memory
 * layers OFF at runtime (without overwriting the user's memory preferences, so
 * exiting restores them) and the web UI hides the notebook/profile tabs and
 * surfaces preset workspaces for one-click start.
 */
export interface InnoSimpleModeConfig {
	enabled: boolean;
}

/**
 * Content Hub. The single source for remotely-fetched, ready-to-use content:
 * the global skill library and the Simple Mode preset workspaces. Both used to
 * be either hardcoded (skill library → a fixed GitHub repo) or bundled with the
 * app (presets → `<codeDir>/presets/`). Centralizing them here lets a single
 * config block point the whole hub at a different source — including a private
 * self-hosted bundle service — without touching code.
 *
 * Two transport types:
 *   - "github": a public/private GitHub repo. `owner`/`repo`/`ref` locate it;
 *     `skillsPath`/`presetsPath` are the top-level directories within it.
 *     `token` raises the API rate limit / unlocks private repos.
 *   - "bundle": a self-hosted service exposing `GET {baseUrl}/index.json` and
 *     `GET {baseUrl}/{presets|skills}/{id}.tar.gz`. `token` (if set) is sent as
 *     a Bearer credential. Avoids GitHub rate limits for private deployments.
 */
export interface InnoContentHubConfig {
	type: "github" | "bundle";
	/** GitHub repo owner (type: "github"). */
	owner: string;
	/** GitHub repo name (type: "github"). */
	repo: string;
	/** GitHub branch / tag / sha (type: "github"). */
	ref: string;
	/** Top-level directory holding the skill library. */
	skillsPath: string;
	/** Top-level directory holding the preset workspaces. */
	presetsPath: string;
	/** Base URL of the self-hosted bundle service (type: "bundle"). */
	baseUrl: string;
	/** Auth token: GitHub PAT (type "github") or Bearer credential (type "bundle"). */
	token: string;
}

/** Built-in defaults — the public hub the app shipped with. */
export const DEFAULT_CONTENT_HUB: InnoContentHubConfig = {
	type: "github",
	owner: "Chloris-Blaxk",
	repo: "inno-agent-hub",
	ref: "main",
	skillsPath: "skill-library",
	presetsPath: "workspace-templates",
	baseUrl: "",
	token: "",
};

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
	github?: {
		/** Personal access token to raise GitHub API rate limits for the skill library. */
		token: string;
	};
	/** Remote source for the skill library + preset workspaces. */
	contentHub?: InnoContentHubConfig;
	subagents?: InnoSubagentsConfig;
	memory?: InnoMemoryConfig;
	simpleMode?: InnoSimpleModeConfig;
	ui?: {
		theme: string;
	};
	/**
	 * Optional OCR API config (Baidu PaddleOCR-VL). When the configured model
	 * cannot recognize images, the agent calls the `ocr_image` tool which uses
	 * these credentials to submit an async OCR job and poll for the markdown
	 * result. Unconfigured → the tool returns a "not configured" hint.
	 */
	ocrApi?: {
		token: string;
		model?: string;
		baseUrl?: string;
	};
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

function normalizeProviderHeaders(headers: InnoProviderConfig["headers"] | undefined): Record<string, string> | undefined {
	if (!headers || typeof headers !== "object" || Array.isArray(headers)) return undefined;
	const normalized = Object.fromEntries(
		Object.entries(headers)
			.map(([key, value]) => [key.trim(), value] as const)
			.filter(([key, value]) => key.length > 0 && typeof value === "string"),
	);
	return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function normalizeProviderConfig(provider: Partial<InnoProviderConfig>): InnoProviderConfig {
	const baseUrl = provider.baseUrl?.trim() ?? "";
	if (!baseUrl) throw new Error("Provider baseUrl is required");
	const models = (provider.models ?? []).map((model) => normalizeModelConfig(model));
	if (models.length === 0) throw new Error("Provider must include at least one model");
	const headers = normalizeProviderHeaders(provider.headers);
	return {
		baseUrl,
		apiKey: provider.apiKey ?? "",
		api: provider.api?.trim() || "openai-completions",
		...(headers ? { headers } : {}),
		...(provider.authHeader === true ? { authHeader: true } : {}),
		...(provider.bypassProxy === true ? { bypassProxy: true } : {}),
		models,
	};
}

export function normalizeMemoryConfig(memory: Partial<InnoMemoryConfig> | undefined): InnoMemoryConfig {
	// All three memory layers default to ON; only an explicit `false` disables one.
	return {
		l1Enabled: memory?.l1Enabled !== false,
		l2Enabled: memory?.l2Enabled !== false,
		l3Enabled: memory?.l3Enabled !== false,
	};
}

export function normalizeSimpleModeConfig(simpleMode: Partial<InnoSimpleModeConfig> | undefined): InnoSimpleModeConfig {
	// Simple Mode defaults OFF; only an explicit `true` enables it.
	return {
		enabled: simpleMode?.enabled === true,
	};
}

/**
 * Normalize the Content Hub config, filling missing fields from the built-in
 * public-hub defaults. `legacyGithubToken` lets us migrate the older
 * `config.github.token` (which only fed the skill library) into the hub token
 * so existing users keep their rate-limit credential with zero changes.
 */
export function normalizeContentHubConfig(
	hub: Partial<InnoContentHubConfig> | undefined,
	legacyGithubToken?: string,
): InnoContentHubConfig {
	const type = hub?.type === "bundle" ? "bundle" : "github";
	const trimmed = (v: string | undefined, fallback: string) => (v?.trim() ? v.trim() : fallback);
	return {
		type,
		owner: trimmed(hub?.owner, DEFAULT_CONTENT_HUB.owner),
		repo: trimmed(hub?.repo, DEFAULT_CONTENT_HUB.repo),
		ref: trimmed(hub?.ref, DEFAULT_CONTENT_HUB.ref),
		skillsPath: trimmed(hub?.skillsPath, DEFAULT_CONTENT_HUB.skillsPath),
		presetsPath: trimmed(hub?.presetsPath, DEFAULT_CONTENT_HUB.presetsPath),
		baseUrl: hub?.baseUrl?.trim() ?? "",
		// Prefer an explicit hub token; otherwise inherit the legacy github token.
		token: (hub?.token?.trim() || legacyGithubToken?.trim()) ?? "",
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
		github: config.github,
		contentHub: normalizeContentHubConfig(config.contentHub, config.github?.token),
		subagents: config.subagents,
		memory: normalizeMemoryConfig(config.memory),
		simpleMode: normalizeSimpleModeConfig(config.simpleMode),
		ui: { theme: "innospark" },
		ocrApi: config.ocrApi,
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
	options: { makeDefault?: boolean; preserveApiKey?: boolean; preserveHeaders?: boolean } = {},
): InnoConfig {
	const id = providerId.trim();
	if (!id) throw new Error("Provider id is required");
	const existing = config.providers[id];
	const normalized = normalizeProviderConfig({
		...provider,
		headers: options.preserveHeaders && existing && provider.headers === undefined
			? existing.headers
			: provider.headers,
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

/**
 * Remove a single model from a provider. If the model was the provider's last
 * one, the provider itself is removed. Refuses to delete the very last model
 * across all providers (the config must always retain at least one model).
 */
export function deleteModel(config: InnoConfig, providerId: string, modelId: string): InnoConfig {
	const id = providerId.trim();
	const mid = modelId.trim();
	if (!id) throw new Error("Provider id is required");
	if (!mid) throw new Error("Model id is required");
	const provider = config.providers[id];
	if (!provider) throw new Error(`Provider ${id} not found`);
	if (!provider.models.some((m) => m.id === mid)) throw new Error(`Model ${id}/${mid} not found`);

	const totalModels = Object.values(config.providers).reduce((sum, p) => sum + p.models.length, 0);
	if (totalModels <= 1) throw new Error("Cannot delete the last model");

	const remainingModels = provider.models.filter((m) => m.id !== mid);
	if (remainingModels.length === 0) {
		delete config.providers[id];
	} else {
		config.providers[id] = { ...provider, models: remainingModels };
	}
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
