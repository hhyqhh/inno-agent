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
import { createMcpStatusExtension, loadMcpAdapterExtension } from "./mcp-extension.js";
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
let _activePromptToken: string | null = null;
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

async function switchToSession(sessionPath: string, opts?: { force?: boolean; cwdOverride?: string }): Promise<void> {
	if (!_runtime) throw new Error("Session not initialized");
	const target = resolve(sessionPath);
	const current = _runtime.session.sessionFile ? resolve(_runtime.session.sessionFile) : null;
	const desiredCwd = opts?.cwdOverride ? resolve(opts.cwdOverride) : resolveCwdFor(target);
	const needsPathSwitch = current !== target;
	const needsCwdSwitch = desiredCwd !== _currentCwd;
	if (!needsPathSwitch && !needsCwdSwitch && !opts?.force) return;
	await _runtime.switchSession(target, { cwdOverride: desiredCwd });
	_currentCwd = desiredCwd;
}

/** Error thrown when a queued task is cancelled before it starts executing. */
export class QueueTaskCancelledError extends Error {
	constructor(message = "Queue task was cancelled before it started") {
		super(message);
		this.name = "QueueTaskCancelledError";
	}
}

export function isQueueTaskCancelled(err: unknown): boolean {
	return err instanceof QueueTaskCancelledError;
}

function enqueue<T>(task: () => Promise<T>, opts?: { signal?: AbortSignal }): Promise<T> {
	// A cancelled task must NEVER execute once its slot arrives — otherwise
	// ops whose caller already gave up (client disconnected / timed out)
	// would run later in a jumbled order (ghost sessions, surprise session
	// switches). Cancellation is also EAGER: the returned promise rejects as
	// soon as the signal fires, so HTTP handlers waiting on a queued op can
	// answer 409 immediately instead of hanging until the slot frees up.
	// See https://github.com/hhyqhh/inno-agent/issues/124.
	return new Promise<T>((resolve, reject) => {
		const signal = opts?.signal;
		let settled = false;
		const onAbort = () => {
			if (settled) return;
			settled = true;
			reject(new QueueTaskCancelledError());
		};
		if (signal) {
			if (signal.aborted) {
				reject(new QueueTaskCancelledError());
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
		}
		const guarded = () => {
			if (signal?.aborted) return Promise.reject(new QueueTaskCancelledError());
			return task();
		};
		const run = _queue.then(guarded, guarded);
		_queue = run.then(() => undefined, () => undefined);
		const cleanup = () => signal?.removeEventListener("abort", onAbort);
		run.then(
			(value) => { cleanup(); if (!settled) { settled = true; resolve(value); } },
			(err) => { cleanup(); if (!settled) { settled = true; reject(err); } },
		);
	});
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
	// MCP: the status bridge subscribes before the adapter so no snapshot is
	// missed; the adapter itself only loads when `mcp.enabled` is set.
	extensionFactories.push(createMcpStatusExtension());
	const mcpAdapter = await loadMcpAdapterExtension(config, paths);
	if (mcpAdapter) extensionFactories.push(mcpAdapter);
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
				headers: providerConfig.headers,
				authHeader: providerConfig.authHeader,
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

	// session_start is emitted only from bindExtensions. Bind the boot session
	// AND every later replacement session (newSession/switchSession): the SDK
	// recreates the session object on replacement, and without rebind no
	// session_start is ever emitted for it — extensions that initialize on
	// session_start then stay dead for the rest of the process. (This is what
	// made pi-mcp-adapter's proxy tool return "MCP not initialized" after the
	// first "new chat".)
	const bindSessionExtensions = async (target: AgentSession): Promise<void> => {
		await target.bindExtensions({
			commandContextActions: {
				waitForIdle: () => target.agent.waitForIdle(),
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
	};
	await bindSessionExtensions(session);
	runtime.setRebindSession(bindSessionExtensions);

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
		input: model.input,
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
			headers: providerConfig.headers,
			authHeader: providerConfig.authHeader,
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

function nativeImagesForSession(
	session: AgentSession,
	images?: ImageContent[],
): ImageContent[] | undefined {
	if (!images?.length) return undefined;
	if (modelAllowsNativeImages(session)) return images;
	logger.info(
		{
			provider: session.model?.provider,
			model: session.model?.id,
			imageCount: images.length,
		},
		"native image payload omitted for text-only model; workspace OCR fallback remains available",
	);
	return undefined;
}

const rejectedNativeImageModels = new WeakMap<AgentSession, Set<string>>();

export function nativeImageModelKey(session: AgentSession): string {
	return JSON.stringify([
		session.model?.provider ?? "unknown",
		session.model?.baseUrl ?? "unknown",
		session.model?.id ?? "unknown",
	]);
}

function hasRejectedNativeImages(session: AgentSession): boolean {
	return rejectedNativeImageModels.get(session)?.has(nativeImageModelKey(session)) ?? false;
}

function rememberNativeImageRejection(session: AgentSession): void {
	const rejected = rejectedNativeImageModels.get(session) ?? new Set<string>();
	rejected.add(nativeImageModelKey(session));
	rejectedNativeImageModels.set(session, rejected);
}

function modelAllowsNativeImages(session: AgentSession): boolean {
	return Boolean(
		session.model?.input.includes("image") &&
		!hasRejectedNativeImages(session),
	);
}

type AgentMessages = AgentSession["agent"]["state"]["messages"];

function isImageBlock(item: unknown): boolean {
	return Boolean(
		item && typeof item === "object" &&
		["image", "image_url"].includes(String((item as { type?: unknown }).type)),
	);
}

function messageHasImageBlock(message: unknown): boolean {
	const content = (message as { content?: unknown }).content;
	return Array.isArray(content) && content.some(isImageBlock);
}

/** Index of the last user message (the current turn), or -1. */
function lastUserMessageIndex(messages: AgentMessages): number {
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index].role === "user") return index;
	}
	return -1;
}

/**
 * Image blocks anywhere in the context except the current turn's user
 * message. History images are re-sent with every request, so they are what
 * makes follow-up turns 413 even when the current turn carries no image.
 */
function hasHistoryImageBlocks(messages: AgentMessages): boolean {
	const currentTurn = lastUserMessageIndex(messages);
	return messages.some((message, index) => index !== currentTurn && messageHasImageBlock(message));
}

const NATIVE_IMAGE_OMITTED_NOTICE = [
	"[当前 Provider 无法接收图片内容，因此这张图片没有发送给模型。",
	"你并没有看到图片；不要猜测或声称已经看到。",
	"如需识别，请使用对话中提供的工作区图片路径调用 ocr_image。",
	"read 工具返回“Read image file”也不代表你看到了图片。",
	"如果 OCR 无法提供足够信息，请明确说明限制。]",
].join("");

const HISTORY_IMAGE_OMITTED_NOTICE = [
	"[较早轮次的图片已从本次请求的上下文中移除（请求体过大）。",
	"你当前只能看到本轮新发送的图片；不要声称看到了被移除的历史图片。]",
].join("");

function withoutNativeImageBlocks(messages: AgentMessages): AgentMessages {
	return messages.map((message) => {
		const content = (message as { content?: unknown }).content;
		if (!Array.isArray(content)) return message;
		const filtered = content.filter((item) => !isImageBlock(item));
		if (filtered.length === content.length) return message;
		return {
			...message,
			content: filtered.length > 0
				? [...filtered, { type: "text", text: NATIVE_IMAGE_OMITTED_NOTICE }]
				: [{ type: "text", text: NATIVE_IMAGE_OMITTED_NOTICE }],
		};
	}) as AgentMessages;
}

/**
 * Strip image blocks from history only, keeping the current turn's images.
 * Used for the first retry after an oversized-body (413) rejection so a
 * vision turn keeps its own images while the accumulated history shrinks.
 */
function withoutHistoryImageBlocks(messages: AgentMessages): AgentMessages {
	const currentTurn = lastUserMessageIndex(messages);
	return messages.map((message, index) => {
		if (index === currentTurn) return message;
		const content = (message as { content?: unknown }).content;
		if (!Array.isArray(content)) return message;
		const filtered = content.filter((item) => !isImageBlock(item));
		if (filtered.length === content.length) return message;
		return {
			...message,
			content: filtered.length > 0
				? [...filtered, { type: "text", text: HISTORY_IMAGE_OMITTED_NOTICE }]
				: [{ type: "text", text: HISTORY_IMAGE_OMITTED_NOTICE }],
		};
	}) as AgentMessages;
}

async function promptWithoutNativeImages(
	session: AgentSession,
	prompt: string,
): Promise<void> {
	const originalTransform = session.agent.transformContext;
	session.agent.transformContext = async (messages, signal) => {
		const transformed = originalTransform
			? await originalTransform(messages, signal)
			: messages;
		return withoutNativeImageBlocks(transformed);
	};
	try {
		await session.prompt(prompt);
	} finally {
		session.agent.transformContext = originalTransform;
	}
}

/**
 * Send the prompt with the current turn's images but history image blocks
 * stripped — the first retry after an oversized-body (413) rejection.
 */
async function promptWithTrimmedHistoryImages(
	session: AgentSession,
	prompt: string,
	nativeImages: ImageContent[] | undefined,
): Promise<void> {
	const originalTransform = session.agent.transformContext;
	session.agent.transformContext = async (messages, signal) => {
		const transformed = originalTransform
			? await originalTransform(messages, signal)
			: messages;
		return withoutHistoryImageBlocks(transformed);
	};
	try {
		await session.prompt(prompt, nativeImages?.length ? { images: nativeImages } : undefined);
	} finally {
		session.agent.transformContext = originalTransform;
	}
}

export function isNativeImagePayloadError(message: string | undefined): boolean {
	if (!message) return false;
	const normalized = message.toLowerCase();
	// Text-only deployments that answer image requests with a plain
	// "model only support(s) text input" 400 — no image keyword at all.
	if (/only supports? text( |-)?input/.test(normalized)) return true;
	const mentionsImagePayload = /image_url|image message|image input|image content|vision/.test(normalized);
	const rejectsPayload = /unknown variant|expected [`'"]?text|unsupported|not support|does not support|invalid|malformed|decode failed|too large/.test(normalized);
	return mentionsImagePayload && rejectsPayload;
}

export function isNativeImageCapabilityError(message: string | undefined): boolean {
	if (!message) return false;
	const normalized = message.toLowerCase();
	if (/only supports? text( |-)?input/.test(normalized)) return true;
	if (/unknown variant.{0,80}image_url|image_url.{0,80}unknown variant/.test(normalized)) return true;
	if (/expected [`'"]?text.{0,80}(?:image|vision)|(?:image|vision).{0,80}expected [`'"]?text/.test(normalized)) {
		return true;
	}
	return /(?:image|vision).{0,80}(?:unsupported|not support|does not support)|(?:unsupported|not support|does not support).{0,80}(?:image|vision)/.test(normalized) &&
		!/format|mime|base64|decode|dimension|resolution|too large|file size/.test(normalized);
}

/**
 * HTTP 413-style rejections. Reverse proxies (e.g. nginx in front of a
 * provider) answer an oversized base64 image request with a bare
 * "413 Request Entity Too Large" page that never mentions images, so
 * isNativeImagePayloadError cannot catch it. Only treat this as an image
 * payload error when the turn actually carried native images.
 */
export function isOversizedPayloadError(message: string | undefined): boolean {
	if (!message) return false;
	return /^\s*413\b|\brequest entity too large\b|\bpayload too large\b|\bcontent too large\b/i.test(message);
}

function eventErrorMessage(event: AgentSessionEvent): string | undefined {
	if (event.type === "message_update" && event.assistantMessageEvent.type === "error") {
		return event.assistantMessageEvent.error.errorMessage;
	}
	if (
		event.type === "message_end" &&
		event.message.role === "assistant" &&
		event.message.stopReason === "error"
	) {
		return event.message.errorMessage;
	}
	return undefined;
}

function lastAssistantError(session: AgentSession): string | undefined {
	for (let index = session.messages.length - 1; index >= 0; index--) {
		const message = session.messages[index];
		if (message.role !== "assistant") continue;
		return message.stopReason === "error" ? message.errorMessage : undefined;
	}
	return undefined;
}

function restoreSessionBeforeFailedPrompt(session: AgentSession, previousLeafId: string | null): void {
	if (previousLeafId) {
		session.sessionManager.branch(previousLeafId);
	} else {
		session.sessionManager.resetLeaf();
	}
	session.agent.state.messages = session.sessionManager.buildSessionContext().messages;
}

/**
 * Callbacks for the tiered native-image retry. `onRetry` fires before the
 * history-trimming retry (the turn keeps its images, so it is NOT a fallback
 * to OCR); `onFallback` fires before the final OCR-friendly retry.
 */
export interface NativeImageRetryCallbacks {
	onRetry?: () => void;
	onFallback: (errorMessage: string) => void;
}

/**
 * Run a prompt with native images, degrading gracefully when the
 * model/provider cannot accept them:
 *
 *  1. Native attempt (current turn's images + full history).
 *  2. On an oversized-body rejection (413) with images anywhere in the
 *     context: retry with history image blocks stripped but the current
 *     turn's images kept. History images are re-sent with every request, so
 *     they are what 413s follow-up turns even when the current turn is
 *     small or carries no image at all.
 *  3. On a payload rejection (or a second 413): restore the session and
 *     retry with all image blocks stripped, using `fallbackPrompt` — the
 *     variant of `prompt` carrying the saved-image path hint for
 *     `ocr_image`. Vision-capable turns never see that hint, so they are not
 *     steered toward `ocr_image`.
 */
async function promptWithNativeImageFallback(
	session: AgentSession,
	prompt: string,
	nativeImages: ImageContent[] | undefined,
	callbacks: NativeImageRetryCallbacks,
	fallbackPrompt?: string,
): Promise<void> {
	const allowsNativeImages = modelAllowsNativeImages(session);
	if (!allowsNativeImages) {
		await promptWithoutNativeImages(session, fallbackPrompt ?? prompt);
		return;
	}

	const previousLeafId = session.sessionManager.getLeafId();
	let thrownError: unknown;
	try {
		await session.prompt(prompt, nativeImages ? { images: nativeImages } : undefined);
	} catch (error) {
		thrownError = error;
	}
	let errorMessage = thrownError instanceof Error
		? thrownError.message
		: lastAssistantError(session);

	// Tier 2: oversized body with images in history — trim history images and
	// retry while keeping the current turn's images.
	if (
		errorMessage &&
		isOversizedPayloadError(errorMessage) &&
		hasHistoryImageBlocks(session.messages)
	) {
		logger.warn(
			{
				provider: session.model?.provider,
				model: session.model?.id,
				errorMessage,
			},
			"request body too large; retrying the turn with history images stripped from context",
		);
		restoreSessionBeforeFailedPrompt(session, previousLeafId);
		callbacks.onRetry?.();
		thrownError = undefined;
		try {
			await promptWithTrimmedHistoryImages(session, prompt, nativeImages);
		} catch (error) {
			thrownError = error;
		}
		errorMessage = thrownError instanceof Error
			? thrownError.message
			: lastAssistantError(session);
		if (!errorMessage) return;
	}

	const contextHasImages = Boolean(nativeImages?.length) || hasHistoryImageBlocks(session.messages);
	const payloadRejected = isNativeImagePayloadError(errorMessage) ||
		(contextHasImages && isOversizedPayloadError(errorMessage));
	if (!payloadRejected) {
		if (thrownError) throw thrownError;
		return;
	}

	if (isNativeImageCapabilityError(errorMessage)) {
		rememberNativeImageRejection(session);
	}
	logger.warn(
		{
			provider: session.model?.provider,
			model: session.model?.id,
			errorMessage,
		},
		"provider rejected native image payload; retrying the turn with workspace OCR fallback",
	);
	restoreSessionBeforeFailedPrompt(session, previousLeafId);
	callbacks.onFallback(errorMessage ?? "Provider rejected the native image payload.");
	await promptWithoutNativeImages(session, fallbackPrompt ?? prompt);
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

/** Abort only when the caller owns the prompt currently executing in the PI runtime. */
export async function abortPromptForTurnToken(token: string): Promise<boolean> {
	if (!token || _activePromptToken !== token) return false;
	await abortCurrentPrompt();
	return true;
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
		for (const entry of entries) {
			if (entry.type !== "message") continue;
			const role = (entry as { message?: { role?: string } }).message?.role;
			lastMessageRole = role;
		}
		if (lastMessageRole !== "user") return false;

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

/** Persist a queued turn that was cancelled before Session.prompt() received it. */
export function persistCancelledQueuedTurn(prompt: string, expectedSessionId: string, images?: ImageContent[]): boolean {
	try {
		const session = getSession();
		if (!session.sessionFile || basename(session.sessionFile) !== expectedSessionId) return false;
		const user: UserMessage = {
			role: "user",
			content: [{ type: "text", text: prompt }, ...(images ?? [])],
			timestamp: Date.now(),
		};
		session.sessionManager.appendMessage(user);
		return persistPendingUserTurn(expectedSessionId);
	} catch (err) {
		logger.warn({ err, expectedSessionId }, "persistCancelledQueuedTurn failed");
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
export async function switchSessionFile(sessionPath: string, opts?: { signal?: AbortSignal }): Promise<void> {
	if (!_runtime) throw new Error("Session not initialized. Call initSession() first.");
	await enqueue(async () => {
		await switchToSession(sessionPath);
	}, opts);
}

/**
 * Force-reapply the workspace cwd for the given session.
 * Use after binding/rebinding a session to a different workspace, so the
 * agent's tools pick up the new cwd on the next prompt without a full
 * session-path change.
 */
export async function applyWorkspaceCwd(sessionPath: string, opts?: { signal?: AbortSignal }): Promise<void> {
	if (!_runtime) return;
	await enqueue(async () => {
		await switchToSession(sessionPath, { force: true });
	}, opts);
}

/**
 * Create and switch to a new session.
 * NOTE: We intentionally do NOT abort the current prompt here — the backend
 * task for the previous session continues running in the background.
 * The client can reconnect to its event stream when switching back.
 */
export async function createNewSession(opts?: { signal?: AbortSignal }): Promise<string> {
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
	}, opts);
}

/** Token (turnId) of the prompt currently occupying the shared queue, if any. */
export function getActivePromptToken(): string | null {
	return _activePromptToken;
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
 * `imageFallbackPrompt` is sent instead of `prompt` when the images cannot go
 * to the model natively (text-only model or provider rejection).
 */
export async function runPrompt(prompt: string, images?: ImageContent[], imageFallbackPrompt?: string): Promise<string> {
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
		} else if (event.type === "message_end") {
			const terminalError = eventErrorMessage(event);
			if (terminalError) streamError = terminalError;
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
		const nativeImages = nativeImagesForSession(session, images);
		const resetAttempt = () => {
			output = "";
			streamError = undefined;
		};
		await promptWithNativeImageFallback(session, prompt, nativeImages, {
			onRetry: resetAttempt,
			onFallback: resetAttempt,
		}, imageFallbackPrompt);
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
export function runPromptSerialized(prompt: string, images?: ImageContent[], imageFallbackPrompt?: string): Promise<string> {
	return enqueue(() => runPrompt(prompt, images, imageFallbackPrompt));
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
	imageFallbackPrompt?: string,
): Promise<string> {
	return enqueue(async () => {
		await switchToSession(sessionPath);
		return runPrompt(prompt, images, imageFallbackPrompt);
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
export async function completePromptOnce(prompt: string, maxTokens = 64, timeoutMs = 20_000): Promise<string> {
	if (!_runtime) return "";
	const session = _runtime.session;
	const model = session.model;
	if (!model) return "";

	const auth = await session.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) return "";

	const controller = new AbortController();
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
	imageFallbackPrompt?: string,
): Promise<string> {
	return enqueue(async () => {
		const session = getSession();
		let output = "";
		let streamError: string | undefined;
		const promptStartTime = Date.now();
		const nativeImages = nativeImagesForSession(session, images);
		let nativeAttemptRejected = false;
		let retryingWithoutNativeImages = false;

		// Observability: agent lifecycle + tool-call details
		const promptObserver = createPromptObserver({ promptStartTime });
		const obsUnsub = session.subscribe(promptObserver);

		const unsubscribe = session.subscribe((event) => {
			if (
				!retryingWithoutNativeImages &&
				isNativeImagePayloadError(eventErrorMessage(event))
			) {
				nativeAttemptRejected = true;
			}
			if (!nativeAttemptRejected || retryingWithoutNativeImages) {
				onEvent(event);
			}
			// The PI SDK converts provider failures into a terminal assistant
			// message (message_end, stopReason "error") instead of throwing —
			// capture it so the outcome reflects the failure. A rejected native
			// attempt also lands here but is cleared by the fallback callback.
			if (event.type === "message_end") {
				const terminalError = eventErrorMessage(event);
				if (terminalError) streamError = terminalError;
			}
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
			await promptWithNativeImageFallback(session, prompt, nativeImages, {
				onRetry: () => {
					nativeAttemptRejected = false;
					output = "";
					streamError = undefined;
				},
				onFallback: () => {
					retryingWithoutNativeImages = true;
					output = "";
					streamError = undefined;
				},
			}, imageFallbackPrompt);
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
	lifecycle?: PromptRunLifecycle,
	cwdOverride?: string,
	imageFallbackPrompt?: string,
): Promise<string> {
	return enqueue(async () => {
		let output = "";
		let streamError: string | undefined;
		let outcome: PromptRunOutcome = { type: "error", error: new Error("Prompt did not start") };
		try {
			await switchToSession(sessionPath, { cwdOverride });
			if (lifecycle?.shouldStart && !(await lifecycle.shouldStart())) {
				outcome = { type: "aborted", reason: "cancelled_before_start", fullText: "" };
			} else {
				_activePromptToken = lifecycle?.token ?? null;
				await lifecycle?.onStart?.();
				const session = getSession();
				const promptStartTime = Date.now();
				const nativeImages = nativeImagesForSession(session, images);
				let nativeAttemptRejected = false;
				let retryingWithoutNativeImages = false;
				const promptObserver = createPromptObserver({ promptStartTime });
				const obsUnsub = session.subscribe(promptObserver);
				const unsubscribe = session.subscribe((event) => {
					if (
						!retryingWithoutNativeImages &&
						isNativeImagePayloadError(eventErrorMessage(event))
					) {
						nativeAttemptRejected = true;
					}
					if (!nativeAttemptRejected || retryingWithoutNativeImages) {
						onEvent(event);
					}
					// See runPromptStreaming: terminal provider failures arrive as
					// message_end with stopReason "error", not as thrown errors.
					if (event.type === "message_end") {
						const terminalError = eventErrorMessage(event);
						if (terminalError) streamError = terminalError;
					}
					if (event.type === "message_update") {
						const ev = event.assistantMessageEvent;
						if (ev.type === "text_delta") output += ev.delta;
						else if (ev.type === "error") {
							streamError = ev.error.errorMessage || `LLM API error (stopReason: ${ev.error.stopReason})`;
							logger.error({ errorMessage: streamError, stopReason: ev.error.stopReason, sessionPath, elapsedMs: Date.now() - promptStartTime }, "LLM API stream error in runPromptStreamingInSession");
						}
					}
				});
				try {
					await promptWithNativeImageFallback(session, prompt, nativeImages, {
						onRetry: () => {
							nativeAttemptRejected = false;
							output = "";
							streamError = undefined;
						},
						onFallback: () => {
							retryingWithoutNativeImages = true;
							output = "";
							streamError = undefined;
						},
					}, imageFallbackPrompt);
				} finally {
					unsubscribe();
					obsUnsub();
				}
				if (lifecycle?.isCancellationRequested?.()) {
					outcome = { type: "aborted", reason: "cancelled", fullText: output.trim() };
				} else if (streamError) {
					outcome = { type: "error", error: new Error(streamError), fullText: output.trim() };
				} else {
					outcome = { type: "completed", fullText: output.trim() };
				}
			}
		} catch (error) {
			outcome = lifecycle?.isCancellationRequested?.()
				? { type: "aborted", reason: "cancelled", error, fullText: output.trim() }
				: { type: "error", error, fullText: output.trim() };
		}

		// Finalization is deliberately inside the enqueue slot. The active token
		// remains bound until persistence confirmation, resource teardown and the
		// unique terminal event have all completed.
		try {
			await finalizePromptRun(outcome, lifecycle, sessionPath);
		} finally {
			if (_activePromptToken === lifecycle?.token) _activePromptToken = null;
		}
		if (outcome.type === "error") throw outcome.error instanceof Error ? outcome.error : new Error("Prompt failed");
		return outcome.fullText ?? "";
	});
}

export type PromptRunOutcome =
	| { type: "completed"; fullText: string }
	| { type: "error"; error: unknown; fullText?: string }
	| { type: "aborted"; reason: string; error?: unknown; fullText?: string };

export interface PromptRunLifecycle {
	token?: string;
	shouldStart?: () => boolean | Promise<boolean>;
	isCancellationRequested?: () => boolean;
	onStart?: () => void | Promise<void>;
	onFinish: (outcome: PromptRunOutcome) => void | Promise<void>;
	onFinalizeFailure: (outcome: PromptRunOutcome, error: unknown) => void | Promise<void>;
}

/** Complete primary/fallback finalization before the caller releases its queue slot. */
export async function finalizePromptRun(
	outcome: PromptRunOutcome,
	lifecycle: PromptRunLifecycle | undefined,
	sessionPath = "",
): Promise<void> {
	if (!lifecycle) return;
	try {
		await lifecycle.onFinish(outcome);
	} catch (error) {
		try {
			await lifecycle.onFinalizeFailure(outcome, error);
		} catch (finalizeError) {
			try {
				logger.error({ error, finalizeError, sessionPath }, "prompt finalization fallback failed");
			} catch {
				// Logging must not widen the serialized finalization boundary.
			}
		}
	}
}
