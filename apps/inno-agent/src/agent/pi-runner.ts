import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	getAgentDir,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type AgentSessionEvent,
	type AgentSessionRuntime,
	type AgentSessionRuntimeDiagnostic,
	type ExtensionFactory,
	type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { complete, type AssistantMessage, type ImageContent, type Model, type UserMessage } from "@earendil-works/pi-ai";
import { basename, join, resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInnoExtension, type ConfigHolder, type InnoExtensionDeps } from "./inno-extension.js";
import { createObservabilityExtension, createPromptObserver, obsLogger } from "./observability-extension.js";
import type { InnoConfig } from "../config.js";
import type { RuntimePaths } from "../runtime.js";
import { ensureDir } from "../storage/file-store.js";
import type { ChannelRegistry } from "../channels/channel.js";
import { logger } from "../logger.js";

let _runtime: AgentSessionRuntime | null = null;
let _queue: Promise<void> = Promise.resolve();
let _workspaceDir = "";
let _currentCwd = "";
let _config: InnoConfig | null = null;
let _configHolder: ConfigHolder | null = null;
let _cwdResolver: ((sessionPath: string) => string | null) | null = null;
/** Provider IDs registered into the active model registry by Inno's config. */
const _registeredProviderIds = new Set<string>();

export type RuntimeChannelHint = "web" | "feishu" | "wechat" | "qq" | "scheduler" | "cli" | "unknown";

/**
 * Register a callback that maps a session file path → the absolute cwd the
 * agent should use when that session is active. Returning null falls back to
 * the workspace root configured at boot.
 */
export function setWorkspaceCwdResolver(fn: ((sessionPath: string) => string | null) | null): void {
	_cwdResolver = fn;
}

function resolveCwdFor(sessionPath: string | null | undefined): string {
	if (!sessionPath) return _workspaceDir;
	if (_cwdResolver) {
		try {
			const resolved = _cwdResolver(sessionPath);
			if (resolved) return resolved;
		} catch (err) {
			logger.warn({ err }, "cwd resolver error");
		}
	}
	return _workspaceDir;
}

async function switchToSession(sessionPath: string, opts?: { force?: boolean }): Promise<void> {
	if (!_runtime) throw new Error("Session not initialized");
	const target = resolve(sessionPath);
	const current = _runtime.session.sessionFile ? resolve(_runtime.session.sessionFile) : null;
	const desiredCwd = resolveCwdFor(target);
	const needsPathSwitch = current !== target;
	const needsCwdSwitch = desiredCwd !== _currentCwd;
	if (!needsPathSwitch && !needsCwdSwitch && !opts?.force) return;
	await _runtime.switchSession(target, { cwdOverride: desiredCwd });
	_currentCwd = desiredCwd;
}

function enqueue<T>(task: () => Promise<T>): Promise<T> {
	const run = _queue.then(task, task);
	_queue = run.then(() => undefined, () => undefined);
	return run;
}

/**
 * Initialize an AgentSessionRuntime for server use.
 * This matches CLI's PI runtime model (runtime + services + session replacement).
 */
/**
 * Write a default {@code retry.provider.timeoutMs} into the PI SDK settings
 * file when none is configured yet.  This gives every provider request a hard
 * deadline so that stalled LLM connections don't leak when the HTTP client
 * (gateway / browser) has already disconnected.
 *
 * When the user already has an explicit value in settings.json it is left
 * untouched.
 */
function applyDefaultProviderTimeout(agentDir: string, defaultMs: number): void {
	const settingsPath = join(agentDir, "settings.json");
	let settings: Record<string, unknown> = {};
	if (existsSync(settingsPath)) {
		try {
			settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
		} catch {
			// corrupt file — overwrite below
		}
	}
	const retry = (settings.retry ??= {}) as Record<string, unknown>;
	const provider = (retry.provider ??= {}) as Record<string, unknown>;
	if (provider.timeoutMs === undefined) {
		provider.timeoutMs = defaultMs;
		writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
		logger.info(
			{ timeoutMs: defaultMs, path: settingsPath },
			"provider retry timeoutMs set to default",
		);
	}
}

export async function initSession(
	config: InnoConfig,
	paths: RuntimePaths,
	channelRegistry?: ChannelRegistry,
	options?: { sandbox?: boolean; extensionDeps?: InnoExtensionDeps },
): Promise<AgentSession> {
	ensureDir(paths.sessionDir);
	ensureDir(paths.learnerDataDir);
	ensureDir(paths.skillsDir);
	ensureDir(paths.workspaceDir);

	const cwd = paths.workspaceDir;
	const agentDir = getAgentDir();
	const configHolder: ConfigHolder = { current: config };
	const innoExtension = createInnoExtension(configHolder, paths, channelRegistry, options?.extensionDeps);

	// Build extension factories list
	const observabilityExtension = createObservabilityExtension();
	const extensionFactories: ExtensionFactory[] = [observabilityExtension, innoExtension];
	if (options?.sandbox) {
		try {
			const { createJiti } = await import("jiti/static");
			const jiti = createJiti(import.meta.url, {
				moduleCache: false,
				alias: {
					"@mariozechner/pi-coding-agent": "@earendil-works/pi-coding-agent",
					"@mariozechner/pi-tui": "@earendil-works/pi-tui",
				},
			});
			const mod = await jiti.import("pi-sandbox", { default: true });
			const sandboxExtension = mod as ExtensionFactory;
			if (typeof sandboxExtension === "function") {
				extensionFactories.push(sandboxExtension);
				logger.info("[inno-server] Sandbox extension loaded");
			}
		} catch (err) {
			logger.warn({ err }, "[inno-server] Failed to load pi-sandbox");
		}
	}

	// Ensure provider requests have a reasonable timeout so that stalled
	// LLM connections don't leak when the client disconnects (e.g. gateway
	// timeout before the model finishes thinking). The value is only applied
	// as a default — explicit user configuration in settings.json takes
	// precedence.
	const DEFAULT_PROVIDER_TIMEOUT_MS = 600_000; // 10 min
	applyDefaultProviderTimeout(agentDir, DEFAULT_PROVIDER_TIMEOUT_MS);

	// Re-create settingsManager so it picks up any defaults we just wrote.
	const settingsManager = SettingsManager.create(cwd, agentDir);

	const createRuntime = async ({
		cwd,
		agentDir,
		sessionManager,
		sessionStartEvent,
	}: {
		cwd: string;
		agentDir: string;
		sessionManager: SessionManager;
		sessionStartEvent?: SessionStartEvent;
	}) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			settingsManager,
			resourceLoaderOptions: {
				extensionFactories,
				additionalSkillPaths: [paths.skillsDir],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});
		// Register Inno's configured providers into the fresh services registry so
		// that find() below can locate the current default model — even if it was
		// switched *after* initSession was called (the closure-captured `config`
		// reference goes stale once server.ts reassigns its own `config` variable
		// via saveConfig, which returns a new normalised object).
		const currentConfig = configHolder.current;
		for (const [providerId, providerConfig] of Object.entries(currentConfig.providers)) {
			services.modelRegistry.registerProvider(providerId, {
				baseUrl: providerConfig.baseUrl,
				apiKey: providerConfig.apiKey || "local",
				api: providerConfig.api ?? "openai-completions",
				models: providerConfig.models.map(modelConfigToProviderModel),
			});
			_registeredProviderIds.add(providerId);
		}
		services.modelRegistry.refresh();
		const defaultModel = services.modelRegistry.find(currentConfig.defaultProvider, currentConfig.defaultModel);
		const created = await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
			model: defaultModel,
		});
		const diagnostics: AgentSessionRuntimeDiagnostic[] = [...services.diagnostics];
		return {
			...created,
			services,
			diagnostics,
		};
	};

	const sessionManager = SessionManager.create(cwd, paths.sessionDir);
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd,
		agentDir,
		sessionManager,
	});
	const session = runtime.session;

	await session.bindExtensions({
		commandContextActions: {
			waitForIdle: () => session.agent.waitForIdle(),
			newSession: async () => {
				await runtime.newSession();
				return { cancelled: false };
			},
			fork: async () => ({ cancelled: true }),
			navigateTree: async () => ({ cancelled: true }),
			switchSession: async (sessionPath) => {
				await switchToSession(sessionPath);
				return { cancelled: false };
			},
			reload: async () => {
				await runtime.session.reload();
			},
		},
		onError: (err) => {
			logger.error({ err }, "agent extension error");
		},
	});

	_runtime = runtime;
	_config = config;
	_configHolder = configHolder;
	_workspaceDir = paths.workspaceDir;
	_currentCwd = cwd;

	const providerCount = Object.keys(config.providers).length;
	const modelCount = Object.values(config.providers).reduce((sum, p) => sum + p.models.length, 0);
	logger.info({ providerCount, modelCount, defaultProvider: config.defaultProvider, defaultModel: config.defaultModel, sandbox: Boolean(options?.sandbox) }, "Agent session initialized");

	return runtime.session;
}

function modelConfigToProviderModel(model: InnoConfig["providers"][string]["models"][number]) {
	return {
		id: model.id,
		name: model.name,
		reasoning: model.reasoning,
		input: ["text" as const, "image" as const],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		compat: {
			supportsDeveloperRole: false,
		},
	};
}

/**
 * Re-register configured providers for the active runtime after config changes.
 * Bypasses the enqueue queue — this is pure in-memory registry work and must
 * not block on a running prompt.
 */
export async function refreshConfiguredProviders(config: InnoConfig): Promise<void> {
	if (!_runtime) throw new Error("Session not initialized. Call initSession() first.");
	_config = config;
	if (_configHolder) _configHolder.current = config;

	// Drop providers that were registered before but are no longer in config.
	// registerProvider replaces a provider's models, so a deleted model inside a
	// surviving provider is handled by re-registering below — but a fully removed
	// provider must be explicitly unregistered or its models linger in the
	// registry (and keep showing up in getAvailableModels / the settings UI).
	for (const providerId of _registeredProviderIds) {
		if (!config.providers[providerId]) {
			_runtime.session.modelRegistry.unregisterProvider(providerId);
			_registeredProviderIds.delete(providerId);
		}
	}

	const providerIds: string[] = [];
	let modelCount = 0;
	for (const [providerId, providerConfig] of Object.entries(config.providers)) {
		_runtime.session.modelRegistry.registerProvider(providerId, {
			baseUrl: providerConfig.baseUrl,
			apiKey: providerConfig.apiKey || "local",
			api: providerConfig.api ?? "openai-completions",
			models: providerConfig.models.map(modelConfigToProviderModel),
		});
		_registeredProviderIds.add(providerId);
		providerIds.push(providerId);
		modelCount += providerConfig.models.length;
	}
	_runtime.session.modelRegistry.refresh();
	logger.info({ providerIds, modelCount }, "Providers refreshed");
}

export function syncConfig(config: InnoConfig): void {
	_config = config;
	if (_configHolder) _configHolder.current = config;
}

/**
 * Get the singleton runtime session. Throws if not initialized.
 */
export function getSession(): AgentSession {
	if (!_runtime) throw new Error("Session not initialized. Call initSession() first.");
	return _runtime.session;
}

/**
 * Abort the currently running agent prompt, releasing the enqueue queue.
 * Safe to call even when no prompt is running.
 */
export async function abortCurrentPrompt(): Promise<void> {
	if (!_runtime) return;
	try {
		await _runtime.session.abort();
	} catch (err) {
		logger.warn({ err }, "abort prompt failed (session may already be idle)");
		// ignore — session may already be idle
	}
}

/**
 * Return current runtime session id.
 */
export function getCurrentSessionId(): string {
	const sessionFile = getSession().sessionFile;
	return sessionFile ? basename(sessionFile) : "";
}

/**
 * Return all configured models known to the active runtime.
 */
export function getAvailableModels(): Model<any>[] {
	if (!_runtime) return [];
	_runtime.session.modelRegistry.refresh();
	return _runtime.session.modelRegistry.getAvailable();
}

/**
 * Switch the active runtime model and persist it as the default PI model.
 * Intentionally bypasses the enqueue queue so it can execute immediately
 * even while a prompt is streaming, avoiding UI lockup.
 */
export async function switchModel(provider: string, modelId: string): Promise<void> {
	if (!_runtime) throw new Error("Session not initialized. Call initSession() first.");
	_runtime.session.modelRegistry.refresh();
	const model = _runtime.session.modelRegistry.find(provider, modelId);
	if (!model) {
		logger.error({ provider, modelId }, "Model not found in registry");
		throw new Error(`Model ${provider}/${modelId} not found`);
	}
	await _runtime.session.setModel(model);
	logger.info({ provider, modelId }, "Model switched");
}

/**
 * Infer the likely channel for the current session by scanning recent user messages.
 * This is a best-effort hint used by background jobs when channel is omitted.
 */
export function getCurrentSessionChannelHint(): RuntimeChannelHint {
	const entries = getSession().sessionManager.getBranch();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "user") continue;
		const asText = JSON.stringify(message).toLowerCase();
		// Check dispatcher channel tag first (most reliable)
		if (asText.includes("[消息来源渠道: feishu]")) return "feishu";
		if (asText.includes("[消息来源渠道: wechat]")) return "wechat";
		if (asText.includes("[消息来源渠道: qq]")) return "qq";
		if (asText.includes("[消息来源渠道: web]")) return "web";
		// Legacy heuristics
		if (asText.includes("附件已下载到")) return "feishu";
		if (asText.includes("\"source\":\"web\"") || asText.includes("\"channel\":\"web\"")) return "web";
	}
	return "unknown";
}

/**
 * Append a scheduler/background notification as an assistant message without
 * invoking the LLM. This keeps reminders authored by the assistant side in the
 * visible session history instead of creating a fake user prompt.
 */
export function appendAssistantNotification(text: string): void {
	const session = getSession();
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "inno-background",
		provider: "inno",
		model: "scheduler",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	session.sessionManager.appendMessage(message);
}

/** Persist a user/assistant message produced by a UI-owned AI workflow. */
export async function appendWorkflowSessionMessage(
	role: "user" | "assistant",
	text: string,
	expectedSessionId?: string,
): Promise<void> {
	await enqueue(async () => {
		const session = getSession();
		const currentId = session.sessionFile ? basename(session.sessionFile) : "";
		if (expectedSessionId && currentId !== expectedSessionId) {
			throw new Error("The active session changed before the workflow message was saved");
		}
		if (role === "user") {
			const message: UserMessage = { role: "user", content: text, timestamp: Date.now() };
			session.sessionManager.appendMessage(message);
			return;
		}
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "inno-background",
			provider: "inno",
			model: "note-polish-workflow",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		session.sessionManager.appendMessage(message);
	});
}

/**
 * Persist an interrupted first turn so it isn't lost from the sidebar.
 *
 * The PI SDK persists lazily: `SessionManager` writes NOTHING to disk (not even
 * the session header + user message) until an assistant message exists in the
 * entries. So if the user sends the very first prompt in a brand-new session
 * and then aborts before any assistant content is committed, the file stays
 * header-only / 0-byte and the conversation effectively vanishes (no preview,
 * no recoverable history — and on a fresh workspace it can't be reopened).
 *
 * To make an interrupted first turn recoverable, append a minimal placeholder
 * assistant message when the latest in-memory entry is an unanswered user turn.
 * That forces the SDK to flush the header + user message + this placeholder to
 * disk, so the session shows up in the sidebar with its real first prompt as
 * the preview and can be reopened.
 *
 * Guarded by `expectedSessionId` so a late abort can't write into a session the
 * runtime has since switched away from. Best-effort and never throws.
 */
export function persistPendingUserTurn(expectedSessionId?: string): boolean {
	if (!_runtime) return false;
	try {
		const session = getSession();
		const sessionFile = session.sessionFile;
		const currentId = sessionFile ? basename(sessionFile) : "";
		if (!currentId) return false;
		if (expectedSessionId && expectedSessionId !== currentId) return false;

		const manager = session.sessionManager;
		const entries = manager.getEntries();
		// Only act when the turn was never answered: the last message entry is a
		// user message. If an assistant message already exists the SDK has (or
		// will) flush normally, so there is nothing to rescue.
		let lastMessageRole: string | undefined;
		let hasAssistant = false;
		for (const entry of entries) {
			if (entry.type !== "message") continue;
			const role = (entry as { message?: { role?: string } }).message?.role;
			if (role === "assistant") hasAssistant = true;
			lastMessageRole = role;
		}
		if (hasAssistant || lastMessageRole !== "user") return false;

		const placeholder: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "[已中断,未完成回复]" }],
			api: "inno-background",
			provider: "inno",
			model: "interrupted",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "aborted",
			timestamp: Date.now(),
		};
		manager.appendMessage(placeholder);
		return true;
	} catch (err) {
		logger.warn({ err }, "persistPendingUserTurn failed (best-effort)");
		// best-effort — never let a persistence hiccup break the abort path
		return false;
	}
}

/**
 * Reload skills/extensions/resources for the active server session.
 */
export async function reloadResources(): Promise<void> {
	if (!_runtime) throw new Error("Session not initialized. Call initSession() first.");
	await enqueue(async () => {
		await _runtime!.session.reload();
	});
}

/**
 * Switch active runtime to a persisted session file path.
 * NOTE: We intentionally do NOT abort the current prompt here — switching
 * sessions is a UI-level navigation action. The backend task continues
 * running and the client can reconnect to its event stream later.
 */
export async function switchSessionFile(sessionPath: string): Promise<void> {
	if (!_runtime) throw new Error("Session not initialized. Call initSession() first.");
	await enqueue(async () => {
		await switchToSession(sessionPath);
	});
}

/**
 * Force-reapply the workspace cwd for the given session.
 * Use after binding/rebinding a session to a different workspace, so the
 * agent's tools pick up the new cwd on the next prompt without a full
 * session-path change.
 */
export async function applyWorkspaceCwd(sessionPath: string): Promise<void> {
	if (!_runtime) return;
	await enqueue(async () => {
		await switchToSession(sessionPath, { force: true });
	});
}

/**
 * Create and switch to a new session.
 * NOTE: We intentionally do NOT abort the current prompt here — the backend
 * task for the previous session continues running in the background.
 * The client can reconnect to its event stream when switching back.
 */
export async function createNewSession(): Promise<string> {
	if (!_runtime) throw new Error("Session not initialized. Call initSession() first.");
	return enqueue(async () => {
		await _runtime!.newSession();
		const sessionId = getCurrentSessionId();
		// PI SDK creates session files lazily (on first assistant message).
		// Touch the file now so existsSync checks pass immediately.
		const sessionFile = getSession().sessionFile;
		if (sessionFile && !existsSync(sessionFile)) {
			writeFileSync(sessionFile, "", "utf-8");
		}
		// New session inherits the runtime's default cwd. Workspace binding
		// (if any) will be applied via applyWorkspaceCwd from the server once
		// the registry mapping is in place.
		_currentCwd = _workspaceDir;
		return sessionId;
	});
}

/**
 * Return currently loaded PI skills and diagnostics.
 */
export function getLoadedSkills() {
	if (!_runtime) return { skills: [], diagnostics: [] };
	return _runtime.services.resourceLoader.getSkills();
}

/**
 * Run a prompt through the session and collect the full text response.
 * Optionally pass images (base64 encoded) for multimodal input.
 */
export async function runPrompt(prompt: string, images?: ImageContent[]): Promise<string> {
	const session = getSession();

	let output = "";
	let streamError: string | undefined;
	const promptStartTime = Date.now();

	// Observability: agent lifecycle + tool-call details
	const promptObserver = createPromptObserver({ promptStartTime });
	const obsUnsub = session.subscribe(promptObserver);

	const unsubscribe = session.subscribe((event) => {
		if (event.type === "message_update") {
			const ev = event.assistantMessageEvent;
			if (ev.type === "text_delta") {
				output += ev.delta;
			} else if (ev.type === "error") {
				streamError = ev.error.errorMessage || `LLM API error (stopReason: ${ev.error.stopReason})`;
				logger.error({ errorMessage: streamError, stopReason: ev.error.stopReason, elapsedMs: Date.now() - promptStartTime }, "LLM API stream error in runPrompt");
			}
		} else if (event.type === "auto_retry_start") {
			obsLogger.warn({
				event: "auto_retry_start",
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
				delayMs: event.delayMs,
				errorMessage: event.errorMessage,
				elapsedMs: Date.now() - promptStartTime,
			}, "LLM API call failed, auto-retrying...");
		} else if (event.type === "auto_retry_end") {
			if (event.success) {
				obsLogger.info({
					event: "auto_retry_end",
					success: true,
					attempt: event.attempt,
				}, "LLM API auto-retry succeeded");
			} else {
				obsLogger.error({
					event: "auto_retry_end",
					success: false,
					finalError: event.finalError,
					elapsedMs: Date.now() - promptStartTime,
				}, "LLM API auto-retry failed");
			}
		}
	});

	try {
		await session.prompt(prompt, images?.length ? { images } : undefined);
	} finally {
		unsubscribe();
		obsUnsub();
	}

	if (streamError) {
		throw new Error(streamError);
	}

	if (!output.trim()) {
		obsLogger.warn({ event: "empty_output", fn: "runPrompt" }, "runPrompt returned empty output — the model may have produced no text or an API error may have been swallowed");
	}

	return output.trim();
}

/**
 * Run a prompt with serialized access (only one prompt at a time).
 * All concurrent calls are queued and executed sequentially.
 */
export function runPromptSerialized(prompt: string, images?: ImageContent[]): Promise<string> {
	return enqueue(() => runPrompt(prompt, images));
}

/**
 * Atomically switch to a specific session file and run a prompt, all within
 * a single enqueue slot.  This prevents other queued operations from changing
 * the active session between the switch and the prompt execution.
 */
export function runPromptInSession(
	sessionPath: string,
	prompt: string,
	images?: ImageContent[],
): Promise<string> {
	return enqueue(async () => {
		await switchToSession(sessionPath);
		return runPrompt(prompt, images);
	});
}

/**
 * Complete a small prompt through the current model without appending anything
 * to the active chat session. Useful for UI metadata such as session titles.
 *
 * IMPORTANT: this is a stateless side-channel completion and must NOT go through
 * the shared prompt/session `enqueue` queue. It makes its own network call that
 * `abortCurrentPrompt()` cannot cancel, so queueing it would let a slow/dead API
 * hold the queue and block `createNewSession` / `switchSessionFile` / chat — the
 * exact "new conversation hangs, sidebar won't load" lockup. We also hard-cap it
 * with an abortable timeout so it can never wait on the provider's long default.
 */
export async function completePromptOnce(prompt: string, maxTokens = 64, timeoutMs = 20_000, signal?: AbortSignal): Promise<string> {
	if (!_runtime) return "";
	const session = _runtime.session;
	const model = session.model;
	if (!model) return "";

	const auth = await session.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) return "";

	const controller = new AbortController();
	const handleExternalAbort = () => controller.abort();
	if (signal?.aborted) controller.abort();
	else signal?.addEventListener("abort", handleExternalAbort, { once: true });
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const promptStartTime = Date.now();
	try {
		const response = await complete(
			model,
			{
				messages: [
					{
						role: "user" as const,
						content: [{ type: "text" as const, text: prompt }],
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				maxTokens,
				signal: controller.signal,
				timeoutMs,
			},
		);

		if (response.stopReason === "error") {
			logger.warn({ errorMessage: response.errorMessage, stopReason: response.stopReason }, "completePromptOnce received error stopReason");
			return "";
		}
		return response.content
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map((item) => item.text)
			.join("\n")
			.trim();
	} catch (err) {
		// best-effort metadata generation — timeout/abort/network errors are non-fatal
		logger.warn({ err, elapsedMs: Date.now() - promptStartTime }, "completePromptOnce failed (non-fatal)");
		return "";
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", handleExternalAbort);
	}
}

/**
 * Callback type for streaming events from the AgentSession.
 */
export type StreamEventCallback = (event: AgentSessionEvent) => void;

/**
 * Run a prompt with streaming — forwards all AgentEvents via onEvent callback.
 * Serialized: only one prompt runs at a time.
 */
export function runPromptStreaming(
	prompt: string,
	onEvent: StreamEventCallback,
	images?: ImageContent[],
): Promise<string> {
	return enqueue(async () => {
		const session = getSession();
		let output = "";
		let streamError: string | undefined;
		const promptStartTime = Date.now();

		// Observability: agent lifecycle + tool-call details
		const promptObserver = createPromptObserver({ promptStartTime });
		const obsUnsub = session.subscribe(promptObserver);

		const unsubscribe = session.subscribe((event) => {
			onEvent(event);
			if (event.type === "message_update") {
				const ev = event.assistantMessageEvent;
				if (ev.type === "text_delta") {
					output += ev.delta;
				} else if (ev.type === "error") {
					streamError = ev.error.errorMessage || `LLM API error (stopReason: ${ev.error.stopReason})`;
					logger.error({ errorMessage: streamError, stopReason: ev.error.stopReason, elapsedMs: Date.now() - promptStartTime }, "LLM API stream error in runPromptStreaming");
				}
			} else if (event.type === "auto_retry_start") {
				obsLogger.warn({
					event: "auto_retry_start",
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
					delayMs: event.delayMs,
					errorMessage: event.errorMessage,
					elapsedMs: Date.now() - promptStartTime,
				}, "LLM API call failed, auto-retrying...");
			} else if (event.type === "auto_retry_end") {
				if (event.success) {
					obsLogger.info({
						event: "auto_retry_end",
						success: true,
						attempt: event.attempt,
					}, "LLM API auto-retry succeeded");
				} else {
					obsLogger.error({
						event: "auto_retry_end",
						success: false,
						finalError: event.finalError,
						elapsedMs: Date.now() - promptStartTime,
					}, "LLM API auto-retry failed");
				}
			}
		});
		try {
			await session.prompt(prompt, images?.length ? { images } : undefined);
		} finally {
			unsubscribe();
			obsUnsub();
		}

		if (streamError) {
			throw new Error(streamError);
		}

		if (!output.trim()) {
			obsLogger.warn({ event: "empty_output", fn: "runPromptStreaming" }, "runPromptStreaming returned empty output — the model may have produced no text or an API error may have been swallowed");
		}

		return output.trim();
	});
}

/**
 * Atomically switch to a session and run a streaming prompt in one enqueue slot.
 */
export function runPromptStreamingInSession(
	sessionPath: string,
	prompt: string,
	onEvent: StreamEventCallback,
	images?: ImageContent[],
): Promise<string> {
	return enqueue(async () => {
		await switchToSession(sessionPath);
		const session = getSession();
		let output = "";
		let streamError: string | undefined;
		const promptStartTime = Date.now();

		// Observability: agent lifecycle + tool-call details
		const promptObserver = createPromptObserver({ promptStartTime });
		const obsUnsub = session.subscribe(promptObserver);

		const unsubscribe = session.subscribe((event) => {
			onEvent(event);
			if (event.type === "message_update") {
				const ev = event.assistantMessageEvent;
				if (ev.type === "text_delta") {
					output += ev.delta;
				} else if (ev.type === "error") {
					streamError = ev.error.errorMessage || `LLM API error (stopReason: ${ev.error.stopReason})`;
					logger.error({ errorMessage: streamError, stopReason: ev.error.stopReason, sessionPath, elapsedMs: Date.now() - promptStartTime }, "LLM API stream error in runPromptStreamingInSession");
				}
			} else if (event.type === "auto_retry_start") {
				obsLogger.warn({
					event: "auto_retry_start",
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
					delayMs: event.delayMs,
					errorMessage: event.errorMessage,
					elapsedMs: Date.now() - promptStartTime,
				}, "LLM API call failed, auto-retrying...");
			} else if (event.type === "auto_retry_end") {
				if (event.success) {
					obsLogger.info({
						event: "auto_retry_end",
						success: true,
						attempt: event.attempt,
					}, "LLM API auto-retry succeeded");
				} else {
					obsLogger.error({
						event: "auto_retry_end",
						success: false,
						finalError: event.finalError,
						elapsedMs: Date.now() - promptStartTime,
					}, "LLM API auto-retry failed");
				}
			}
		});
		try {
			await session.prompt(prompt, images?.length ? { images } : undefined);
		} finally {
			unsubscribe();
			obsUnsub();
		}

		if (streamError) {
			throw new Error(streamError);
		}

		if (!output.trim()) {
			obsLogger.warn({ event: "empty_output", fn: "runPromptStreamingInSession", sessionPath }, "runPromptStreamingInSession returned empty output — the model may have produced no text or an API error may have been swallowed");
		}

		return output.trim();
	});
}
