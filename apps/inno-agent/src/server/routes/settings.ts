import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";
import { probeProviderModels } from "../../agent/model-probe.js";
import {
	getAvailableModels,
	getSession,
	refreshConfiguredProviders,
	switchModel,
	syncConfig,
} from "../../agent/pi-runner.js";
import {
	deleteModel,
	deleteProvider,
	normalizeContentHubConfig,
	normalizeSmartInputConfig,
	saveConfig,
	setDefaultModel,
	upsertProvider,
	type InnoConfig,
	type InnoModelConfig,
	type InnoProviderConfig,
	type InnoSmartInputConfig,
} from "../../config.js";
import { logger } from "../../logger.js";
import {
	getWebAccessSettingsView,
	updateWebAccessSettings,
} from "../../agent/web-access-config.js";
import {
	deleteManagedServer,
	getMcpOverview,
	setManagedServerDisabled,
	upsertManagedServer,
	type McpServerEntry,
} from "../../mcp/mcp-config-store.js";
import type { RuntimePaths } from "../../runtime.js";
import { applyProviderProxyBypass } from "../../utils/proxy-bypass.js";
import { json, matchRoute, readBody } from "../http-helpers.js";

/**
 * Server state the settings routes touch. `config` is reassigned on every
 * write endpoint, so it flows through getter/setter; the three callbacks are
 * owned by server.ts (they serve other route domains too).
 */
export interface SettingsRouteContext {
	paths: RuntimePaths;
	getConfig: () => InnoConfig;
	setConfig: (config: InnoConfig) => void;
	reloadFeishuChannel: () => Promise<void>;
	scheduleSkillsReload: () => void;
	invalidateContentSource: () => void;
}

// ---------------------------------------------------------------------------
// Helpers moved verbatim from server.ts (only used by this route domain).
// ---------------------------------------------------------------------------

function maskSecret(value: string | undefined): string {
	return value ? `****${value.slice(-4)}` : "";
}

function providerModelToRuntimeModel(model: InnoModelConfig, provider: string, baseUrl: string) {
	return {
		id: model.id,
		name: model.name,
		provider,
		reasoning: model.reasoning,
		input: model.input,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		baseUrl,
	};
}

function buildSafeSettings(config: InnoConfig) {
	const session = getSession();
	const currentModel = session.model;
	const configuredModels = Object.entries(config.providers).flatMap(([providerId, providerConfig]) =>
		providerConfig.models.map((model) => providerModelToRuntimeModel(model, providerId, providerConfig.baseUrl)),
	);
	const availableModels = getAvailableModels().map((model) => ({
		id: model.id,
		name: model.name,
		provider: model.provider,
		reasoning: model.reasoning,
		input: model.input,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		baseUrl: model.baseUrl,
	}));

	return {
		...config,
		defaultProvider: currentModel?.provider ?? config.defaultProvider,
		defaultModel: currentModel?.id ?? config.defaultModel,
		configuredModels,
		availableModels,
		providers: Object.fromEntries(
			Object.entries(config.providers).map(([providerId, providerConfig]) => [
				providerId,
				{
					...providerConfig,
					apiKey: maskSecret(providerConfig.apiKey),
					headers: providerConfig.headers
						? Object.fromEntries(Object.entries(providerConfig.headers).map(([key, value]) => [key, maskSecret(value)]))
						: undefined,
				},
			]),
		),
		feishu: config.feishu
			? { ...config.feishu, appSecret: config.feishu.appSecret ? "****" : "" }
			: undefined,
		bridge: config.bridge
			? { token: maskSecret(config.bridge.token) }
			: undefined,
		github: config.github
			? { token: maskSecret(config.github.token) }
			: undefined,
		ocrApi: config.ocrApi
			? {
				token: maskSecret(config.ocrApi.token),
				model: config.ocrApi.model,
				baseUrl: config.ocrApi.baseUrl,
			}
			: undefined,
		tavily: config.tavily
			? { apiKey: maskSecret(config.tavily.apiKey) }
			: undefined,
		contentHub: config.contentHub
			? { ...config.contentHub, token: maskSecret(config.contentHub.token) }
			: undefined,
	};
}

function parseModelConfig(value: unknown): InnoModelConfig {
	if (!value || typeof value !== "object") throw new Error("Invalid model");
	const record = value as Record<string, unknown>;
	const id = typeof record.id === "string" ? record.id.trim() : "";
	if (!id) throw new Error("Model id is required");
	return {
		id,
		name: typeof record.name === "string" && record.name.trim() ? record.name.trim() : id,
		reasoning: Boolean(record.reasoning),
		input: ("input" in record)
			? (Array.isArray(record.input) && record.input.includes("image") ? ["text", "image"] : ["text"])
			: ["text", "image"],
		contextWindow: typeof record.contextWindow === "number" ? record.contextWindow : Number(record.contextWindow ?? 128000),
		maxTokens: typeof record.maxTokens === "number" ? record.maxTokens : Number(record.maxTokens ?? 8192),
	};
}

function parseStringHeaders(value: unknown): Record<string, string> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const headers: Record<string, string> = {};
	for (const [key, headerValue] of Object.entries(value as Record<string, unknown>)) {
		const normalizedKey = key.trim();
		if (normalizedKey && typeof headerValue === "string") {
			headers[normalizedKey] = headerValue;
		}
	}
	return Object.keys(headers).length > 0 ? headers : undefined;
}

function parseProviderPayload(body: Record<string, unknown>): {
	providerId: string;
	provider: InnoProviderConfig;
	makeDefault: boolean;
	preserveApiKey: boolean;
	preserveHeaders: boolean;
} {
	const providerId = typeof body.providerId === "string" ? body.providerId.trim() : "";
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(providerId)) {
		throw new Error("Provider id must use letters, numbers, dot, underscore, or dash");
	}
	const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
	const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
	const api = typeof body.api === "string" ? body.api.trim() : "openai-completions";
	const headers = parseStringHeaders(body.headers);
	const rawModels = Array.isArray(body.models) ? body.models : [];
	const models = rawModels.map(parseModelConfig);
	return {
		providerId,
		provider: {
			baseUrl,
			apiKey,
			api,
			...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
			...(body.authHeader === true ? { authHeader: true } : {}),
			...(body.bypassProxy === true ? { bypassProxy: true } : {}),
			models,
		},
		makeDefault: Boolean(body.makeDefault),
		preserveApiKey: Boolean(body.preserveApiKey),
		preserveHeaders: !Object.prototype.hasOwnProperty.call(body, "headers"),
	};
}

/**
 * /api/settings* and /api/mcp* route domain. Returns true when the request
 * was handled. Extracted verbatim from server.ts during the P2 route split —
 * behavior unchanged.
 */
export async function handleSettingsRoutes(
	req: HttpReq,
	res: ServerResponse,
	method: string,
	url: string,
	ctx: SettingsRouteContext,
): Promise<boolean> {
	const { paths } = ctx;
	// Per-request view of the mutable config; every save mirrors back via
	// ctx.setConfig so subsequent requests (and other domains) see the write.
	let config = ctx.getConfig();
	const save = (next: InnoConfig): void => {
		config = next;
		ctx.setConfig(next);
	};

	if (method === "GET" && url === "/api/settings") {
		json(res, 200, buildSafeSettings(config));
		return true;
	}

	if (method === "POST" && url === "/api/settings/model") {
		const body = (await readBody(req)) as Record<string, unknown>;
		const provider = typeof body.provider === "string" ? body.provider.trim() : "";
		const model = typeof body.model === "string" ? body.model.trim() : "";
		if (!provider || !model) {
			json(res, 400, { error: "Missing provider or model" });
			return true;
		}

		await switchModel(provider, model);
		save(saveConfig(paths.configPath, setDefaultModel(config, provider, model)));
		syncConfig(config);
		const currentModel = getSession().model;
		json(res, 200, {
			defaultProvider: currentModel?.provider ?? provider,
			defaultModel: currentModel?.id ?? model,
		});
		return true;
	}

	if ((method === "PUT" || method === "POST" || method === "PATCH") && url === "/api/settings/providers") {
		const body = (await readBody(req)) as Record<string, unknown>;
		const payload = parseProviderPayload(body);
		save(saveConfig(
			paths.configPath,
			upsertProvider(config, payload.providerId, payload.provider, {
				makeDefault: payload.makeDefault,
				preserveApiKey: payload.preserveApiKey,
				preserveHeaders: payload.preserveHeaders,
			}),
		));
		applyProviderProxyBypass(config);
		await refreshConfiguredProviders(config);
		if (payload.makeDefault) {
			await switchModel(config.defaultProvider, config.defaultModel);
			save(saveConfig(paths.configPath, setDefaultModel(config, config.defaultProvider, config.defaultModel)));
		}
		json(res, 200, buildSafeSettings(config));
		return true;
	}

	// Probe a provider's model list server-side (the browser can't call
	// provider APIs directly due to CORS + API key exposure). If apiKey is
	// omitted, fall back to the stored key of an existing provider.
	if (method === "POST" && url === "/api/settings/providers/probe-models") {
		const body = (await readBody(req)) as Record<string, unknown>;
		const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
		const api = typeof body.api === "string" ? body.api : undefined;
		let apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
		const providerId = typeof body.providerId === "string" ? body.providerId.trim() : "";
		if ((!apiKey || apiKey.startsWith("****")) && providerId) {
			apiKey = config.providers?.[providerId]?.apiKey ?? "";
		}
		try {
			const result = await probeProviderModels({ baseUrl, apiKey, api });
			json(res, 200, result);
		} catch (err) {
			json(res, 400, { error: err instanceof Error ? err.message : String(err) });
		}
		return true;
	}

	// Delete a single model from a provider. Must be matched before the
	// provider-delete route below (which uses startsWith on the same prefix).
	if (method === "DELETE" && /^\/api\/settings\/providers\/[^/]+\/models\/[^/]+$/.test(url)) {
		const rest = url.slice("/api/settings/providers/".length);
		const [providerPart, modelPart] = rest.split("/models/");
		const providerId = decodeURIComponent(providerPart);
		const modelId = decodeURIComponent(modelPart);
		if (!providerId || !modelId) {
			json(res, 400, { error: "Missing provider or model id" });
			return true;
		}
		try {
			save(saveConfig(paths.configPath, deleteModel(config, providerId, modelId)));
			await refreshConfiguredProviders(config);
		} catch (err) {
			logger.error({ err, providerId, modelId }, "failed to delete model");
			json(res, 400, { error: err instanceof Error ? err.message : String(err) });
			return true;
		}
		json(res, 200, buildSafeSettings(config));
		return true;
	}

	if (method === "DELETE" && url.startsWith("/api/settings/providers/")) {
		const providerId = decodeURIComponent(url.slice("/api/settings/providers/".length));
		if (!providerId) {
			json(res, 400, { error: "Missing provider id" });
			return true;
		}
		try {
			save(saveConfig(paths.configPath, deleteProvider(config, providerId)));
			await refreshConfiguredProviders(config);
		} catch (err) {
			logger.error({ err }, "failed to update channel settings");
			json(res, 400, { error: err instanceof Error ? err.message : String(err) });
			return true;
		}
		json(res, 200, buildSafeSettings(config));
		return true;
	}

	// --- Channels Settings ---
	if (method === "PUT" && url === "/api/settings/channels") {
		const body = (await readBody(req)) as Record<string, unknown>;
		try {
			// Update feishu config
			if (body.feishu && typeof body.feishu === "object") {
				const feishuBody = body.feishu as Record<string, unknown>;
				const appId = typeof feishuBody.appId === "string" ? feishuBody.appId.trim() : "";
				const appSecret = typeof feishuBody.appSecret === "string" ? feishuBody.appSecret.trim() : "";
				if (appId) {
					config.feishu = {
						appId,
						appSecret: appSecret || config.feishu?.appSecret || "",
					};
				}
			}
			// Update channels config
			if (body.channels && typeof body.channels === "object") {
				const channels = body.channels as Record<string, unknown>;
				config.channels = config.channels ?? {};
				for (const name of ["feishu", "qq", "wechat"] as const) {
					const ch = channels[name];
					if (ch && typeof ch === "object") {
						const chObj = ch as Record<string, unknown>;
						(config.channels as Record<string, unknown>)[name] = {
							...((config.channels as Record<string, unknown>)?.[name] as object ?? {}),
							enabled: typeof chObj.enabled === "boolean" ? chObj.enabled : false,
							...(typeof chObj.personalOnly === "boolean" ? { personalOnly: chObj.personalOnly } : {}),
							...(Array.isArray(chObj.allowedUserIds) ? { allowedUserIds: chObj.allowedUserIds.filter((v: unknown) => typeof v === "string") } : {}),
							...(typeof chObj.mode === "string" ? { mode: chObj.mode } : {}),
							...(typeof chObj.sidecarBaseUrl === "string" ? { sidecarBaseUrl: chObj.sidecarBaseUrl.trim() } : {}),
						};
					}
				}
			}
			// Update bridge config
			if (body.bridge && typeof body.bridge === "object") {
				const bridgeBody = body.bridge as Record<string, unknown>;
				const token = typeof bridgeBody.token === "string" ? bridgeBody.token.trim() : "";
				if (token && !token.startsWith("****")) {
					config.bridge = { token };
				} else if (!config.bridge && token) {
					// preserve existing
				}
			}
			save(saveConfig(paths.configPath, config));
		} catch (err) {
			logger.warn({ err }, "failed to update channel settings");
			json(res, 400, { error: err instanceof Error ? err.message : String(err) });
			return true;
		}

		// Hot-reload Feishu channel: stop old instance, create new one if configured.
		try {
			await ctx.reloadFeishuChannel();
		} catch (err) {
			logger.warn({ err }, "feishu channel hot-reload failed");
		}

		json(res, 200, buildSafeSettings(config));
		return true;
	}

	// --- Memory Settings (L3 cross-conversation recall toggle) ---
	if (method === "PUT" && url === "/api/settings/memory") {
		const body = (await readBody(req)) as Record<string, unknown>;
		const keys = ["l1Enabled", "l2Enabled", "l3Enabled"] as const;
		if (keys.every((k) => typeof body[k] !== "boolean")) {
			json(res, 400, { error: "Provide at least one of l1Enabled / l2Enabled / l3Enabled (boolean)" });
			return true;
		}
		for (const k of keys) {
			if (body[k] !== undefined && typeof body[k] !== "boolean") {
				json(res, 400, { error: `${k} must be a boolean` });
				return true;
			}
		}
		// Merge over current values so a partial payload leaves the other
		// layers untouched. normalizeMemoryConfig backfills defaults.
		const current = config.memory ?? { l1Enabled: true, l2Enabled: true, l3Enabled: true };
		config.memory = {
			l1Enabled: typeof body.l1Enabled === "boolean" ? body.l1Enabled : current.l1Enabled,
			l2Enabled: typeof body.l2Enabled === "boolean" ? body.l2Enabled : current.l2Enabled,
			l3Enabled: typeof body.l3Enabled === "boolean" ? body.l3Enabled : current.l3Enabled,
		};
		save(saveConfig(paths.configPath, config));
		syncConfig(config);
		json(res, 200, buildSafeSettings(config));
		return true;
	}

	// --- Simple Mode toggle (streamlined experience: force-locks memory off
	// at runtime and hides notebook/profile tabs; does not touch memory config) ---
	if (method === "PUT" && url === "/api/settings/simple-mode") {
		const body = (await readBody(req)) as Record<string, unknown>;
		if (typeof body.enabled !== "boolean") {
			json(res, 400, { error: "enabled must be a boolean" });
			return true;
		}
		config.simpleMode = { enabled: body.enabled };
		save(saveConfig(paths.configPath, config));
		syncConfig(config);
		json(res, 200, buildSafeSettings(config));
		return true;
	}

	// --- Smart Input (便捷输入): composer keyword bubbles + file bindings.
	// Accepts the full settings object; rules are normalized (trimmed keywords,
	// deduped, allowed/excluded extensions lowercased with a leading dot) before
	// persisting so a partial or hand-edited payload can never produce a broken
	// rule set. ---
	if (method === "PUT" && url === "/api/settings/smart-input") {
		const body = (await readBody(req)) as Record<string, unknown>;
		const next = normalizeSmartInputConfig(body as Partial<InnoSmartInputConfig>);
		config.smartInput = next;
		save(saveConfig(paths.configPath, config));
		syncConfig(config);
		json(res, 200, buildSafeSettings(config));
		return true;
	}

	// --- MCP master switch. Takes effect on the next process start: the
	// extension set is fixed at boot, so toggling loads/unloads the
	// pi-mcp-adapter extension only after a restart. The UI compares
	// `mcp.enabled` (config) against GET /api/mcp's `adapterLoaded`
	// (runtime) to surface the restart hint.
	if (method === "PUT" && url === "/api/settings/mcp") {
		const body = (await readBody(req)) as Record<string, unknown>;
		if (typeof body.enabled !== "boolean") {
			json(res, 400, { error: "enabled must be a boolean" });
			return true;
		}
		config.mcp = { enabled: body.enabled };
		save(saveConfig(paths.configPath, config));
		syncConfig(config);
		json(res, 200, buildSafeSettings(config));
		return true;
	}

	// --- MCP server management (managed file: <configDir>/mcp.json) ---
	if (method === "GET" && url === "/api/mcp") {
		json(res, 200, getMcpOverview(config, paths));
		return true;
	}

	const mcpServerPutMatch = matchRoute("PUT", method, url, "/api/mcp/servers/:name");
	if (mcpServerPutMatch) {
		const name = mcpServerPutMatch.name;
		const body = (await readBody(req)) as McpServerEntry;
		try {
			upsertManagedServer(paths, name, body);
		} catch (err) {
			json(res, 400, { error: err instanceof Error ? err.message : "Invalid server definition" });
			return true;
		}
		// Best-effort hot apply; if the runtime doesn't pick it up the UI
		// tells the user to restart (same fire-and-forget pattern as skills).
		ctx.scheduleSkillsReload();
		json(res, 200, getMcpOverview(config, paths));
		return true;
	}

	const mcpServerPatchMatch = matchRoute("PATCH", method, url, "/api/mcp/servers/:name");
	if (mcpServerPatchMatch) {
		const body = (await readBody(req)) as Record<string, unknown>;
		if (typeof body.disabled !== "boolean") {
			json(res, 400, { error: "disabled must be a boolean" });
			return true;
		}
		if (!setManagedServerDisabled(paths, mcpServerPatchMatch.name, body.disabled)) {
			json(res, 404, { error: "Server not found in managed config (it may come from an external config file)" });
			return true;
		}
		ctx.scheduleSkillsReload();
		json(res, 200, getMcpOverview(config, paths));
		return true;
	}

	const mcpServerDeleteMatch = matchRoute("DELETE", method, url, "/api/mcp/servers/:name");
	if (mcpServerDeleteMatch) {
		if (!deleteManagedServer(paths, mcpServerDeleteMatch.name)) {
			json(res, 404, { error: "Server not found in managed config (it may come from an external config file)" });
			return true;
		}
		ctx.scheduleSkillsReload();
		json(res, 200, getMcpOverview(config, paths));
		return true;
	}

	if (method === "PUT" && url === "/api/settings/github") {
		const body = (await readBody(req)) as Record<string, unknown>;
		if (typeof body.token !== "string") {
			json(res, 400, { error: "Missing token (string)" });
			return true;
		}
		const incoming = body.token.trim();
		// A masked value (e.g. "****abcd") means "keep the existing token".
		const token = incoming.startsWith("****") ? (config.github?.token ?? "") : incoming;
		config.github = token ? { token } : undefined;
		save(saveConfig(paths.configPath, config));
		syncConfig(config);
		// Rebuild the content source so the new auth (and higher limit) applies.
		ctx.invalidateContentSource();
		json(res, 200, buildSafeSettings(config));
		return true;
	}

	// --- OCR API settings (Baidu PaddleOCR-VL token / model / baseUrl) ---
	if (method === "PUT" && url === "/api/settings/ocr") {
		const body = (await readBody(req)) as Record<string, unknown>;
		if (typeof body.token !== "string") {
			json(res, 400, { error: "Missing token (string)" });
			return true;
		}
		const incoming = body.token.trim();
		// A masked value (e.g. "****abcd") means "keep the existing token".
		const token = incoming.startsWith("****") ? (config.ocrApi?.token ?? "") : incoming;
		const model = typeof body.model === "string" ? body.model.trim() : config.ocrApi?.model;
		const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : config.ocrApi?.baseUrl;
		if (!token) {
			config.ocrApi = undefined;
		} else {
			config.ocrApi = {
				token,
				model: model || undefined,
				baseUrl: baseUrl || undefined,
			};
		}
		save(saveConfig(paths.configPath, config));
		syncConfig(config);
		json(res, 200, buildSafeSettings(config));
		return true;
	}

	// --- Tavily settings (web_search tool API key) ---
	if (method === "PUT" && url === "/api/settings/tavily") {
		const body = (await readBody(req)) as Record<string, unknown>;
		if (typeof body.apiKey !== "string") {
			json(res, 400, { error: "Missing apiKey (string)" });
			return true;
		}
		const incoming = body.apiKey.trim();
		// A masked value (e.g. "****abcd") means "keep the existing key".
		const apiKey = incoming.startsWith("****") ? (config.tavily?.apiKey ?? "") : incoming;
		if (!apiKey) {
			config.tavily = undefined;
		} else {
			config.tavily = { apiKey };
		}
		save(saveConfig(paths.configPath, config));
		syncConfig(config);
		json(res, 200, buildSafeSettings(config));
		return true;
	}

	// --- Web research settings (pi-web-access providers: web_research / source_check / fetch_content) ---
	if (method === "GET" && url === "/api/settings/web-access") {
		json(res, 200, getWebAccessSettingsView(paths.configDir));
		return true;
	}

	if (method === "PUT" && url === "/api/settings/web-access") {
		const body = (await readBody(req)) as Record<string, unknown>;
		if (body.provider !== undefined && typeof body.provider !== "string") {
			json(res, 400, { error: "provider must be a string" });
			return true;
		}
		if (body.values !== undefined && (typeof body.values !== "object" || body.values === null || Array.isArray(body.values))) {
			json(res, 400, { error: "values must be an object keyed by provider id" });
			return true;
		}
		const view = updateWebAccessSettings(paths.configDir, {
			provider: body.provider as string | undefined,
			values: body.values as Record<string, string> | undefined,
		});
		json(res, 200, view);
		return true;
	}

	// --- Content Hub settings (source for skill library + presets) ---
	if (method === "PUT" && url === "/api/settings/content-hub") {
		const body = (await readBody(req)) as Record<string, unknown>;
		const current = config.contentHub ?? normalizeContentHubConfig(undefined, config.github?.token);
		const str = (key: string, fallback: string): string =>
			typeof body[key] === "string" ? (body[key] as string).trim() : fallback;
		// A masked token (e.g. "****abcd") means "keep the existing token".
		const incomingToken = typeof body.token === "string" ? body.token.trim() : "";
		const token = incomingToken.startsWith("****") ? current.token : incomingToken;
		config.contentHub = normalizeContentHubConfig({
			type: body.type === "bundle" ? "bundle" : "github",
			owner: str("owner", current.owner),
			repo: str("repo", current.repo),
			ref: str("ref", current.ref),
			skillsPath: str("skillsPath", current.skillsPath),
			presetsPath: str("presetsPath", current.presetsPath),
			baseUrl: str("baseUrl", current.baseUrl),
			token,
		});
		save(saveConfig(paths.configPath, config));
		syncConfig(config);
		// Rebuild the content source so the new hub takes effect immediately.
		ctx.invalidateContentSource();
		json(res, 200, buildSafeSettings(config));
		return true;
	}

	// PUT /api/settings/theme — persist UI theme preference
	if (method === "PUT" && url === "/api/settings/theme") {
		const body = (await readBody(req)) as Record<string, unknown>;
		const theme = typeof body.theme === "string" ? body.theme.trim() : "";
		const ALLOWED_THEMES = ["light", "warm", "ocean", "innospark"];
		if (!ALLOWED_THEMES.includes(theme)) {
			json(res, 400, { error: `Invalid theme. Allowed: ${ALLOWED_THEMES.join(", ")}` });
			return true;
		}
		config.ui = { ...(config.ui ?? { theme: "light", closeBehavior: "ask", mathSingleDollar: false }), theme };
		save(saveConfig(paths.configPath, config));
		json(res, 200, buildSafeSettings(config));
		return true;
	}

	// PUT /api/settings/close-behavior — persist the cross-platform window-close preference
	if (method === "PUT" && url === "/api/settings/close-behavior") {
		const body = (await readBody(req)) as Record<string, unknown>;
		const closeBehavior = body.closeBehavior;
		if (closeBehavior !== "ask" && closeBehavior !== "hide" && closeBehavior !== "quit") {
			json(res, 400, { error: "closeBehavior must be one of ask, hide, quit" });
			return true;
		}
		config.ui = {
			...(config.ui ?? { theme: "light", closeBehavior: "ask", mathSingleDollar: false }),
			closeBehavior,
		};
		save(saveConfig(paths.configPath, config));
		json(res, 200, buildSafeSettings(config));
		return true;
	}

	// PUT /api/settings/markdown — persist user-facing Markdown parsing preferences
	if (method === "PUT" && url === "/api/settings/markdown") {
		const body = (await readBody(req)) as Record<string, unknown>;
		if (typeof body.mathSingleDollar !== "boolean") {
			json(res, 400, { error: "mathSingleDollar must be a boolean" });
			return true;
		}
		config.ui = {
			...(config.ui ?? { theme: "light", closeBehavior: "ask", mathSingleDollar: false }),
			mathSingleDollar: body.mathSingleDollar,
		};
		save(saveConfig(paths.configPath, config));
		json(res, 200, buildSafeSettings(config));
		return true;
	}

	return false;
}
