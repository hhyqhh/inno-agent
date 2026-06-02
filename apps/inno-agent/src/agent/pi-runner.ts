import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	getAgentDir,
	SessionManager,
	type AgentSession,
	type AgentSessionEvent,
	type AgentSessionRuntime,
	type AgentSessionRuntimeDiagnostic,
	type ExtensionFactory,
	type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { complete, type AssistantMessage, type ImageContent } from "@earendil-works/pi-ai";
import { basename, resolve } from "node:path";
import { existsSync, writeFileSync } from "node:fs";
import { createInnoExtension, type ConfigHolder, type InnoExtensionDeps } from "./inno-extension.js";
import type { InnoConfig } from "../config.js";
import type { RuntimePaths } from "../runtime.js";
import { ensureDir } from "../storage/file-store.js";
import type { ChannelRegistry } from "../channels/channel.js";

let _runtime: AgentSessionRuntime | null = null;
let _queue: Promise<void> = Promise.resolve();
let _workspaceDir = "";
let _currentCwd = "";
let _config: InnoConfig | null = null;
let _configHolder: ConfigHolder | null = null;
let _cwdResolver: ((sessionPath: string) => string | null) | null = null;

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
			console.warn(`[pi-runner] cwd resolver error: ${err instanceof Error ? err.message : String(err)}`);
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
	const extensionFactories: ExtensionFactory[] = [innoExtension];
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
				console.log("[inno-server] Sandbox extension loaded");
			}
		} catch (err) {
			console.warn(`[inno-server] Failed to load pi-sandbox: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

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
			resourceLoaderOptions: {
				extensionFactories,
				additionalSkillPaths: [paths.skillsDir],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});
		services.modelRegistry.refresh();
		const defaultModel = services.modelRegistry.find(config.defaultProvider, config.defaultModel);
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
			console.error(`[inno-server] extension error: ${err.error}`);
		},
	});

	_runtime = runtime;
	_config = config;
	_configHolder = configHolder;
	_workspaceDir = paths.workspaceDir;
	_currentCwd = cwd;
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
 */
export async function refreshConfiguredProviders(config: InnoConfig): Promise<void> {
	if (!_runtime) throw new Error("Session not initialized. Call initSession() first.");
	await enqueue(async () => {
		_config = config;
		if (_configHolder) _configHolder.current = config;
		for (const [providerId, providerConfig] of Object.entries(config.providers)) {
			_runtime!.session.modelRegistry.registerProvider(providerId, {
				baseUrl: providerConfig.baseUrl,
				apiKey: providerConfig.apiKey || "local",
				api: providerConfig.api ?? "openai-completions",
				models: providerConfig.models.map(modelConfigToProviderModel),
			});
		}
		_runtime!.session.modelRegistry.refresh();
	});
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
 * Return current runtime session id.
 */
export function getCurrentSessionId(): string {
	const sessionFile = getSession().sessionFile;
	return sessionFile ? basename(sessionFile) : "";
}

/**
 * Return all configured models known to the active runtime.
 */
export function getAvailableModels() {
	if (!_runtime) return [];
	_runtime.session.modelRegistry.refresh();
	return _runtime.session.modelRegistry.getAvailable();
}

/**
 * Switch the active runtime model and persist it as the default PI model.
 */
export async function switchModel(provider: string, modelId: string): Promise<void> {
	if (!_runtime) throw new Error("Session not initialized. Call initSession() first.");
	await enqueue(async () => {
		_runtime!.session.modelRegistry.refresh();
		const model = _runtime!.session.modelRegistry.find(provider, modelId);
		if (!model) {
			throw new Error(`Model ${provider}/${modelId} not found`);
		}
		await _runtime!.session.setModel(model);
	});
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
	const unsubscribe = session.subscribe((event) => {
		if (
			event.type === "message_update" &&
			event.assistantMessageEvent.type === "text_delta"
		) {
			output += event.assistantMessageEvent.delta;
		}
	});

	try {
		await session.prompt(prompt, images?.length ? { images } : undefined);
	} finally {
		unsubscribe();
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
 */
export function completePromptOnce(prompt: string, maxTokens = 64): Promise<string> {
	return enqueue(async () => {
		const session = getSession();
		const model = session.model;
		if (!model) return "";

		const auth = await session.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) return "";

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
			},
		);

		if (response.stopReason === "error") return "";
		return response.content
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map((item) => item.text)
			.join("\n")
			.trim();
	});
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
		const unsubscribe = session.subscribe((event) => {
			onEvent(event);
			if (
				event.type === "message_update" &&
				event.assistantMessageEvent.type === "text_delta"
			) {
				output += event.assistantMessageEvent.delta;
			}
		});
		try {
			await session.prompt(prompt, images?.length ? { images } : undefined);
		} finally {
			unsubscribe();
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
		const unsubscribe = session.subscribe((event) => {
			onEvent(event);
			if (
				event.type === "message_update" &&
				event.assistantMessageEvent.type === "text_delta"
			) {
				output += event.assistantMessageEvent.delta;
			}
		});
		try {
			await session.prompt(prompt, images?.length ? { images } : undefined);
		} finally {
			unsubscribe();
		}
		return output.trim();
	});
}
