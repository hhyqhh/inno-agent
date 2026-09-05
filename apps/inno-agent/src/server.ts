// Register source-map-support so that compiled JS stack traces and
// pino-caller call sites map back to the original TS source locations.
import "source-map-support/register.js";

import { createServer, type IncomingMessage as HttpReq, type ServerResponse } from "node:http";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { loadConfig, type InnoConfig } from "./config.js";
import { installFetchLogger } from "./utils/fetch-logger.js";
import { canonicalContainmentRoot, isWithin } from "./utils/path-safety.js";
import { applyProviderProxyBypass } from "./utils/proxy-bypass.js";
import { ensureDir, readJson, readText, writeJson, writeText } from "./storage/file-store.js";
import {
	createNewSession,
	getCurrentSessionId,
	getLoadedSkills,
	getSession,
	getActivePromptToken,
	initSession,
	isQueueTaskCancelled,
	reloadResources,
	setWorkspaceCwdResolver,
} from "./agent/pi-runner.js";
import { completePromptOnce, runPromptSerialized, runPromptStreamingInSession, runPromptInSession, abortPromptForTurnToken } from "./agent/pi-runner.js";
import { ChannelRegistry } from "./channels/channel.js";
import type { ChannelStreamEvent } from "./channels/channel.js";
import { FeishuChannel } from "./channels/feishu/feishu-channel.js";
import { PersonalChannelDispatcher } from "./channels/personal-dispatcher.js";
import { BridgeChannel } from "./channels/bridge/bridge-channel.js";
import { WeChatChannel } from "./channels/wechat/wechat-channel.js";
import type { PersonalBridgeChannelConfig } from "./config.js";
import { JobStore } from "./scheduler/job-store.js";
import { seedManagedMcpConfig } from "./mcp/mcp-config-store.js";
import { CronScheduler } from "./scheduler/cron-scheduler.js";
import { HttpError, json } from "./server/http-helpers.js";
import {
	safeJoinReal,
	slugifySkillName,
} from "./server/file-helpers.js";
import { extractFrontmatterFields } from "./server/skill-frontmatter.js";
import { handleChannelsRoutes } from "./server/routes/channels.js";
import { handleJobsRoutes } from "./server/routes/jobs.js";
import { handleSettingsRoutes } from "./server/routes/settings.js";
import { handleSkillsRoutes } from "./server/routes/skills.js";
import { handleWorkspacesRoutes } from "./server/routes/workspaces.js";
import { handleSessionsRoutes } from "./server/routes/sessions.js";
import { handleLearnerRoutes } from "./server/routes/learner.js";
import { handleWikiRoutes } from "./server/routes/wiki.js";
import { handlePresetsRoutes } from "./server/routes/presets.js";
import { handlePracticeRoutes } from "./server/routes/practice.js";
import { handleChatRoutes } from "./server/routes/chat.js";
import { handleCommandsRoutes } from "./server/routes/commands.js";
import { mergeSessionAgentCommands } from "./server/agent-command-store.js";
import {
	mergeChannels,
	selectActiveSessionEntries,
	type SessionChannel,
	type SessionChannelMetadata,
	type SessionMessageSummary,
	type SessionQuestionMetadata,
	type SessionSummary,
	type SessionTopicMetadata,
} from "./server/session-model.js";
import { logger } from "./logger.js";
import { applyRuntimeEnvironment, parseRuntimeArgs, resolveRuntimePaths } from "./runtime.js";
import { installProcessFallbacks } from "./utils/process-fallback.js";
import { questionBridge } from "./agent/question-bridge.js";
import { streamRegistry } from "./chat/stream-registry.js";
import { DEFAULT_WORKSPACE_ID, WorkspaceRegistry, type WorkspaceMeta } from "./workspace/workspace-registry.js";
import type { RemoteContentSource } from "./content-source/index.js";
import { ContentHubCatalog } from "./content-source/catalog-service.js";
import { RunRecordStore } from "./terminal/run-record-store.js";
import { TerminalSessionManager } from "./terminal/terminal-session-manager.js";
import type { ClientTerminalEvent, ServerTerminalEvent } from "./terminal/terminal-types.js";
import { WebSocketServer, type WebSocket } from "ws";

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

// bodyTimeout: 15 min safety net for LLM provider requests. Provider-level
// timeout (retry.provider.timeoutMs, default 10 min) should fire first; this
// ensures a hung connection can't live longer than 15 minutes even if the
// provider timeout fails to abort.
setGlobalDispatcher(new EnvHttpProxyAgent({ bodyTimeout: 900_000, headersTimeout: 0 }));
installFetchLogger();

const parsed = parseRuntimeArgs(process.argv.slice(2));
const paths = resolveRuntimePaths(parsed.options);
applyRuntimeEnvironment(paths);

// Port is resolved from CLI / env only — config.json is read lazily.
const port = parsed.options.port
	?? (process.env.INNO_PORT ? Number.parseInt(process.env.INNO_PORT, 10) : undefined)
	?? 3000;

// Config is loaded on first API request, not at startup.
let config!: InnoConfig;

// ---------------------------------------------------------------------------
// Lazy bootstrap — directories, stores, channels, and agent session are
// deferred until the first meaningful web request (not /health or static files).
// Before that, no INNO_HOME subdirectories or files are created.
// ---------------------------------------------------------------------------

const dataDir = paths.dataDir;
const l2DataDir = paths.l2DataDir;
const skillsDir = paths.skillsDir;
const contentHubCatalog = new ContentHubCatalog({
	dataDir,
	paths,
	skillsDir,
	getConfig: () => config,
});

// All stateful services are declared with !: — they are guaranteed to be
// initialised before any API handler that uses them runs, because the HTTP
// handler calls ensureBootstrapped() before dispatching.
let jobStore!: JobStore;
let channelRegistry!: ChannelRegistry;
let workspaceRegistry!: WorkspaceRegistry;
let runRecordStore!: RunRecordStore;
let terminalManager!: TerminalSessionManager;
let feishuChannel: FeishuChannel | null = null;
let wechatChannel: WeChatChannel | null = null;
let dispatcher: PersonalChannelDispatcher | null = null;

let bootstrapped = false;
let bootstrapPromise: Promise<void> | null = null;
let bridgeToken: string | undefined;

/** Convert a raw PI SDK event to a ChannelStreamEvent for channel streaming replies. */
function piEventToChannelStreamEvent(event: any): ChannelStreamEvent | null {
	switch (event.type) {
		case "message_update": {
			const ev = event.assistantMessageEvent;
			if (ev.type === "text_delta") return { type: "text_delta", delta: ev.delta };
			if (ev.type === "thinking_delta") return { type: "thinking_delta", delta: ev.delta };
			if (ev.type === "error") return { type: "error", message: ev.error?.errorMessage || "LLM API error" };
			return null;
		}
		case "message_end": {
			const msg = event.message;
			if (msg && typeof msg === "object" && "stopReason" in msg && msg.stopReason === "error") {
				return { type: "error", message: msg.errorMessage || "The model request failed." };
			}
			return null;
		}
		case "tool_execution_start":
			return { type: "tool_start", toolCallId: event.toolCallId, toolName: event.toolName };
		case "tool_execution_end": {
			const summary = typeof event.result === "string" ? event.result.slice(0, 80) : undefined;
			return { type: "tool_end", toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError, summary };
		}
		default:
			return null;
	}
}

/**
 * One-shot lazy bootstrap. Idempotent — concurrent requests while the first
 * bootstrap is still in-flight all await the same promise.
 */
async function ensureBootstrapped(): Promise<void> {
	if (bootstrapped) return;
	if (bootstrapPromise) return bootstrapPromise;

	bootstrapPromise = (async () => {
		logger.info("[inno-server] first meaningful request — bootstrapping...");

		// ---- config (loaded lazily, not at process start) ----
		config = loadConfig(paths.configPath);
		applyProviderProxyBypass(config);

		// First-run MCP template: seeds <configDir>/mcp.json with a disabled
		// reference server when the file doesn't exist yet. No-op afterwards.
		seedManagedMcpConfig(paths);

		// ---- data directories ----
		ensureDir(paths.learnerDataDir);
		ensureDir(paths.sessionDir);
		ensureDir(paths.jobsDir);
		ensureDir(paths.skillsDir);
		ensureDir(paths.workspaceDir);

		// ---- stores ----
		jobStore = new JobStore(paths.jobsDir, config.scheduler?.timezone);
		jobStore.normalizePersistedJobs();

		channelRegistry = new ChannelRegistry(join(dataDir, "channels", "default-targets.json"));

		workspaceRegistry = new WorkspaceRegistry(paths.workspaceDir, dataDir);
		workspaceRegistry.ensureBootstrapped();
		try {
			const sessionFiles = existsSync(paths.sessionDir)
				? readdirSync(paths.sessionDir).filter((f) => f.endsWith(".jsonl"))
				: [];
			workspaceRegistry.migrateUnboundSessions(sessionFiles, DEFAULT_WORKSPACE_ID);
		} catch (err) {
			logger.warn({ err }, "[sessions] unbound-session migration failed");
		}

		runRecordStore = new RunRecordStore(join(dataDir, "runs"));
		terminalManager = new TerminalSessionManager(workspaceRegistry, runRecordStore);

		// Resolve agent cwd per session based on its workspace binding.
		setWorkspaceCwdResolver((sessionPath: string) => {
			const id = basename(sessionPath);
			const workspaceId = workspaceRegistry.getSessionWorkspaceId(id);
			return workspaceRegistry.resolveWorkspaceDir(workspaceId);
		});

		migrateLegacyPiSkills();

		// ---- channels ----
		function migrateReminderChannels(): void {
			const defaultFeishuTarget = channelRegistry.getDefaultTarget("feishu");
			if (!defaultFeishuTarget) return;
			for (const job of jobStore.list()) {
				if (job.taskType !== "push_reminder") continue;
				if (job.channel) continue;
				jobStore.update(job.id, {
					channel: "feishu",
					target: defaultFeishuTarget,
				});
			}
		}

		if (config.feishu?.appId && config.channels?.feishu?.enabled) {
			feishuChannel = new FeishuChannel(config.feishu, dataDir, config.channels.feishu);
			channelRegistry.register(feishuChannel);
		}

		bridgeToken = config.bridge?.token;
		if (bridgeToken) {
			const qqConfig = config.channels?.qq as PersonalBridgeChannelConfig | undefined;
			if (qqConfig?.enabled && qqConfig.sidecarBaseUrl) {
				channelRegistry.register(new BridgeChannel("qq", qqConfig.sidecarBaseUrl, bridgeToken));
			}
			const wechatConfigBridge = config.channels?.wechat;
			if (wechatConfigBridge?.enabled && "sidecarBaseUrl" in wechatConfigBridge && (wechatConfigBridge as PersonalBridgeChannelConfig).mode === "bridge") {
				channelRegistry.register(new BridgeChannel("wechat", (wechatConfigBridge as PersonalBridgeChannelConfig).sidecarBaseUrl, bridgeToken));
			}
		}

		const wechatCfg = config.channels?.wechat;
		if (wechatCfg?.enabled && (!("mode" in wechatCfg) || (wechatCfg as { mode?: string }).mode !== "bridge")) {
			wechatChannel = new WeChatChannel(dataDir, wechatCfg);
			channelRegistry.register(wechatChannel);
		}
		migrateReminderChannels();

		// ---- agent session ----
		logger.info("[inno-server] initializing agent session...");
		await initSession(config, paths, channelRegistry, {
			sandbox: parsed.options.sandbox,
			extensionDeps: {
				workspaceRegistry,
				runRecordStore,
				getCurrentSessionId,
				recordChannelInteraction: (channel) => recordCurrentSessionChannel(channel as SessionChannel),
			},
		});

		// ---- post-init: dispatcher, channels, cron, WebSocket ----
		const channelsDataDir = join(dataDir, "channels");
		ensureDir(channelsDataDir);
		dispatcher = new PersonalChannelDispatcher({
			channelRegistry,
			runPrompt: runPromptSerialized,
			runPromptInSession,
			runPromptStreamingInSession: (sessionPath, prompt, onEvent, images) => {
				return runPromptStreamingInSession(sessionPath, prompt, (piEvent: any) => {
					const channelEvent = piEventToChannelStreamEvent(piEvent);
					if (channelEvent) onEvent(channelEvent);
				}, images);
			},
			createNewSession,
			getCurrentSessionId,
			recordSessionChannel: (ch, sid?) => recordCurrentSessionChannel(ch as SessionChannel, sid, { setOriginIfEmpty: true }),
			maybeAutoGenerateTopic,
			onSessionCreated: (sessionId, channel) => {
				try {
					const ws = workspaceRegistry.ensureChannelWorkspace(channel);
					workspaceRegistry.bindSession(sessionId, ws.id);
				} catch (err) {
					logger.warn({ err }, `[sessions] failed to bind channel session ${sessionId}`);
				}
			},
			channelsDataDir,
			sessionDir: join(dataDir, "sessions"),
		});

		if (feishuChannel) {
			feishuChannel.onMessage((msg) => dispatcher!.handle(feishuChannel!, msg));
			feishuChannel.start();

			// Auto-discover default target on first boot if none persisted
			if (!channelRegistry.getDefaultTarget("feishu")) {
				feishuChannel.discoverDefaultTarget().then((target) => {
					if (target) {
						channelRegistry.setDefaultTarget(target);
						logger.info({ chatId: target.chatId }, "[feishu] auto-set default target from chat list");
					}
				}).catch((err) => {
					logger.warn({ err }, "[feishu] initial target discovery failed");
				});
			}
		}
		if (wechatChannel) {
			wechatChannel.onMessage((msg) => dispatcher!.handle(wechatChannel!, msg));
			wechatChannel.start();
		}

		const scheduler = new CronScheduler(jobStore, channelRegistry);
		scheduler.start();

		logger.info({ channels: channelRegistry.all().map((c) => c.name).join(", ") || "none" }, "[inno-server] channels");
		logger.info({ jobCount: jobStore.list().length }, "[inno-server] jobs loaded");

		bootstrapped = true;
		logger.info("[inno-server] bootstrap complete");
		// Simple Mode cards and the remote skill library are warmed in the
		// background. Never make the first meaningful API response wait on GitHub.
		void contentHubCatalog.warm();
	})().catch((err) => {
		logger.error({ err }, "[inno-server] bootstrap failed");
		bootstrapPromise = null; // allow retry on next request
		throw err;
	});

	return bootstrapPromise;
}

// ---------------------------------------------------------------------------
// Channel hot-reload
// ---------------------------------------------------------------------------

/**
 * Stop the current Feishu channel (if any) and reinitialize it from the
 * current in-memory config. Called after PUT /api/settings/channels so that
 * new credentials take effect without a server restart.
 */
async function reloadFeishuChannel(): Promise<void> {
	// Tear down existing instance
	if (feishuChannel) {
		try { await feishuChannel.stop(); } catch { /* best effort */ }
		feishuChannel = null;
	}

	// If feishu is now configured and enabled, create a new instance
	if (!config.feishu?.appId || !config.channels?.feishu?.enabled) {
		logger.info("[feishu] channel disabled or not configured, skipping reload");
		return;
	}

	feishuChannel = new FeishuChannel(config.feishu, dataDir, config.channels.feishu);
	channelRegistry.register(feishuChannel);

	if (dispatcher) {
		feishuChannel.onMessage((msg) => dispatcher!.handle(feishuChannel!, msg));
	}
	feishuChannel.start();
	logger.info("[feishu] channel hot-reloaded with new credentials");

	// Auto-discover default target if none exists yet (fixes first-time setup
	// chicken-and-egg: user had to send FROM Feishu before agent could send TO it)
	if (!channelRegistry.getDefaultTarget("feishu")) {
		const target = await feishuChannel.discoverDefaultTarget();
		if (target) {
			channelRegistry.setDefaultTarget(target);
			logger.info({ chatId: target.chatId }, "[feishu] auto-set default target from chat list");
		}
	}
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sessionRevision(filePath: string): string {
	try {
		const stat = statSync(filePath);
		return `${stat.size}:${stat.mtimeMs}`;
	} catch {
		return "missing";
	}
}


// ---------------------------------------------------------------------------
// Static file serving (web/dist/)
// ---------------------------------------------------------------------------

const webDistDir = paths.webDistDir;

const MIME_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".mjs": "application/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
};

function isHashedStaticAsset(filePath: string): boolean {
	const rel = relative(webDistDir, filePath).split(sep).join("/");
	return /^assets\/.+-[A-Za-z0-9_-]{8,}\.[^.]+$/.test(rel);
}

function acceptEncodingHeader(req: HttpReq): string {
	const value = req.headers["accept-encoding"];
	return Array.isArray(value) ? value.join(",") : value ?? "";
}

function encodingAccepted(acceptEncoding: string, encoding: "br" | "gzip"): boolean {
	let wildcardQ: number | undefined;
	for (const part of acceptEncoding.split(",")) {
		const [rawToken, ...params] = part.trim().split(";");
		const token = rawToken.trim().toLowerCase();
		if (!token) continue;
		let q = 1;
		for (const param of params) {
			const [name, value] = param.trim().split("=", 2);
			if (name?.trim().toLowerCase() !== "q") continue;
			const parsed = Number.parseFloat(value?.trim() ?? "");
			q = Number.isFinite(parsed) ? parsed : 0;
			break;
		}
		if (token === encoding) return q > 0;
		if (token === "*") wildcardQ = q;
	}
	return wildcardQ !== undefined ? wildcardQ > 0 : false;
}

function serveStatic(req: HttpReq, res: ServerResponse, filePath: string, sendBody = true, staticRoot?: string): boolean {
	try {
		if (!existsSync(filePath) || !statSync(filePath).isFile()) return false;
		const ext = extname(filePath);
		const contentType = MIME_TYPES[ext] || "application/octet-stream";
		const acceptEncoding = acceptEncodingHeader(req);
		let responsePath = filePath;
		let contentEncoding: "br" | "gzip" | undefined;
		// The pre-compressed sibling never went through safeJoinReal, so verify
		// its realpath stays inside the static root — a planted symlink like
		// `assets/index.js.gz -> /etc/passwd` must not be served.
		const canonicalRoot = staticRoot ? canonicalContainmentRoot(staticRoot) : null;
		const pickCompressedSibling = (suffix: string): string | null => {
			const candidate = `${filePath}${suffix}`;
			try {
				if (!existsSync(candidate)) return null;
				if (canonicalRoot && !isWithin(canonicalRoot, realpathSync(candidate))) return null;
				return candidate;
			} catch {
				return null;
			}
		};
		const brSibling = encodingAccepted(acceptEncoding, "br") ? pickCompressedSibling(".br") : null;
		const gzSibling = !brSibling && encodingAccepted(acceptEncoding, "gzip") ? pickCompressedSibling(".gz") : null;
		if (brSibling) {
			responsePath = brSibling;
			contentEncoding = "br";
		} else if (gzSibling) {
			responsePath = gzSibling;
			contentEncoding = "gzip";
		}

		const content = readFileSync(responsePath);
		const headers: Record<string, string | number> = {
			"Content-Type": contentType,
			"Content-Length": content.length,
			"Cache-Control": ext === ".html"
				? "no-cache"
				: isHashedStaticAsset(filePath)
					? "public, max-age=31536000, immutable"
					: "no-cache",
		};
		if (contentEncoding) {
			headers["Content-Encoding"] = contentEncoding;
			headers.Vary = "Accept-Encoding";
		}
		res.writeHead(200, headers);
		res.end(sendBody ? content : undefined);
		return true;
	} catch (err) {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Local data helpers
// ---------------------------------------------------------------------------

function sessionFileFromId(sessionDir: string, id: string): string | null {
	const fileName = basename(id);
	if (fileName !== id || !fileName.endsWith(".jsonl")) return null;
	return safeJoinReal(sessionDir, fileName);
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const record = part as Record<string, unknown>;
			return record.type === "text" && typeof record.text === "string" ? record.text : "";
		})
		.filter(Boolean)
		.join("\n")
		.trim();
}

function imagesFromContent(content: unknown): Array<{ previewUrl: string; mimeType: string }> {
	if (!Array.isArray(content)) return [];
	const result: Array<{ previewUrl: string; mimeType: string }> = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const record = part as Record<string, unknown>;
		if (
			record.type === "image" &&
			typeof record.data === "string" &&
			typeof record.mimeType === "string"
		) {
			result.push({
				previewUrl: `data:${record.mimeType};base64,${record.data}`,
				mimeType: record.mimeType,
			});
		}
	}
	return result;
}

function parseSkillFrontmatter(content: string): Record<string, string | boolean> {
	const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const match = normalized.match(/^---\n([\s\S]*?)\n---\n?/);
	if (!match) return {};
	const fm: Record<string, string | boolean> = {};
	for (const line of match[1].split("\n")) {
		const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!kv) continue;
		const raw = kv[2].trim();
		if (kv[1] in fm) continue; // 保留第一个值（标准YAML行为）
		fm[kv[1]] = raw === "true" ? true : raw === "false" ? false : raw.replace(/^["']|["']$/g, "");
	}
	return fm;
}

function ensureSkillDocument(content: string, fallbackName: string): { name: string; content: string } {
	const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const frontmatter = parseSkillFrontmatter(normalized);
	const name = slugifySkillName(typeof frontmatter.name === "string" ? frontmatter.name : fallbackName);
	const description = typeof frontmatter.description === "string" && frontmatter.description.trim()
		? frontmatter.description.trim()
		: `Project skill uploaded for ${name}. Use when the user's task matches this skill package.`;

	if (normalized.startsWith("---\n")) {
		return { name, content: normalized };
	}

	return {
		name,
		content: `---\nname: ${name}\ndescription: ${description}\n---\n\n${normalized.trim()}\n`,
	};
}

function copyDirectoryContents(sourceDir: string, targetDir: string): void {
	ensureDir(targetDir);
	for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
		if (entry.name === "__MACOSX" || entry.name === ".DS_Store") continue;
		const source = join(sourceDir, entry.name);
		const target = join(targetDir, entry.name);
		if (entry.isDirectory()) {
			cpSync(source, target, { recursive: true });
		} else if (entry.isFile()) {
			cpSync(source, target);
		}
	}
}

function findSkillFile(dir: string): string | null {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "__MACOSX") continue;
		const fullPath = join(dir, entry.name);
		if (entry.isFile() && entry.name === "SKILL.md") return fullPath;
	}
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".") || entry.name === "__MACOSX") continue;
		const fullPath = join(dir, entry.name);
		if (!entry.isDirectory()) continue;
		const nested = findSkillFile(fullPath);
		if (nested) return nested;
	}
	return null;
}

function validateZipEntries(zipPath: string): void {
	if (process.platform === "win32") {
		// Windows: list zip entries via .NET ZipFile API (no system unzip).
		const ps = `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
			`$zip = [System.IO.Compression.ZipFile]::OpenRead('${zipPath.replace(/'/g, "''")}'); ` +
			`try { $zip.Entries | ForEach-Object { $_.FullName } } finally { $zip.Dispose() }`;
		const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", ps], { encoding: "utf-8" });
		if (result.status !== 0) {
			throw new Error((result.stderr || "").trim() || "Unable to inspect zip file");
		}
		for (const rawLine of result.stdout.split(/\r?\n/)) {
			const entry = rawLine.trim();
			if (!entry) continue;
			if (entry.startsWith("/") || entry.startsWith("\\") || entry.includes("..")) {
				throw new Error(`Unsafe zip entry path: ${entry}`);
			}
		}
		return;
	}
	const result = spawnSync("/usr/bin/unzip", ["-Z1", zipPath], { encoding: "utf-8" });
	if (result.status !== 0) {
			throw new Error((result.stderr || "").trim() || "Unable to inspect zip file");
	}
	for (const rawLine of result.stdout.split("\n")) {
		const entry = rawLine.trim();
		if (!entry) continue;
		if (entry.startsWith("/") || entry.includes("..") || entry.includes("\\")) {
			throw new Error(`Unsafe zip entry path: ${entry}`);
		}
	}
}

function installSkillZip(fileName: string, data: Buffer, targetRoot: string = skillsDir): { name: string; filePath: string } {
	const fallbackName = slugifySkillName(basename(fileName, extname(fileName)));
	const tempRoot = join(tmpdir(), `inno-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const zipPath = join(tempRoot, `${fallbackName}.zip`);
	const extractDir = join(tempRoot, "extract");
	ensureDir(extractDir);
	writeFileSync(zipPath, data);

	try {
		validateZipEntries(zipPath);
		if (process.platform === "win32") {
			// Windows: extract via .NET ZipFile.ExtractToDirectory (no system unzip).
			const ps = `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
				`[System.IO.Compression.ZipFile]::ExtractToDirectory(` +
				`'${zipPath.replace(/'/g, "''")}', '${extractDir.replace(/'/g, "''")}')`;
			const unzipResult = spawnSync("powershell.exe", ["-NoProfile", "-Command", ps], { encoding: "utf-8" });
			if (unzipResult.status !== 0) {
				throw new Error((unzipResult.stderr || "").trim() || "Unable to unzip skill package");
			}
		} else {
			const unzipResult = spawnSync("/usr/bin/unzip", ["-qq", "-o", zipPath, "-d", extractDir], { encoding: "utf-8" });
			if (unzipResult.status !== 0) {
				throw new Error((unzipResult.stderr || "").trim() || "Unable to unzip skill package");
			}
		}

		return installSkillFromExtractedDir(extractDir, fallbackName, targetRoot);
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

/**
 * Install a skill from an already-extracted directory: locate the SKILL.md,
 * normalize its frontmatter, and copy the package into the skills directory.
 * Shared by zip upload and skill-library import.
 */
function installSkillFromExtractedDir(extractDir: string, fallbackName: string, targetRoot: string = skillsDir): { name: string; filePath: string } {
	const skillFile = findSkillFile(extractDir);
	if (!skillFile) {
		throw new Error("Skill package must contain a SKILL.md file");
	}
	const skillRoot = dirname(skillFile);
	const skill = ensureSkillDocument(readText(skillFile), fallbackName);
	const targetDir = join(targetRoot, skill.name);
	rmSync(targetDir, { recursive: true, force: true });
	copyDirectoryContents(skillRoot, targetDir);
	writeText(join(targetDir, "SKILL.md"), skill.content);
	return { name: skill.name, filePath: join(targetDir, "SKILL.md") };
}

function installSkillMarkdown(fileName: string, data: Buffer, targetRoot: string = skillsDir): { name: string; filePath: string } {
	const skill = ensureSkillDocument(data.toString("utf-8"), basename(fileName, extname(fileName)));
	const skillDir = join(targetRoot, skill.name);
	rmSync(skillDir, { recursive: true, force: true });
	ensureDir(skillDir);
	writeText(join(skillDir, "SKILL.md"), skill.content);
	return { name: skill.name, filePath: join(skillDir, "SKILL.md") };
}

// ---------------------------------------------------------------------------
// Workspace zip import
// ---------------------------------------------------------------------------

/** Entries that are archive noise, not workspace content. */
function isImportNoise(name: string): boolean {
	return name === "__MACOSX" || name === ".DS_Store" || name.startsWith("._");
}

/**
 * Locate the actual content root inside an extracted workspace archive:
 * a single top-level folder (the common "folder zipped by Finder" shape) or
 * the extract dir itself when files sit at the archive root. Returns null
 * when the archive has no importable content.
 */
function findWorkspaceContentRoot(extractDir: string): string | null {
	const entries = readdirSync(extractDir, { withFileTypes: true })
		.filter((entry) => !isImportNoise(entry.name));
	if (entries.length === 0) return null;
	if (entries.length === 1 && entries[0].isDirectory()) {
		const nested = join(extractDir, entries[0].name);
		const inner = readdirSync(nested, { withFileTypes: true })
			.filter((entry) => !isImportNoise(entry.name));
		return inner.length > 0 ? nested : null;
	}
	return extractDir;
}

/**
 * Recursively copy imported content into the new workspace directory.
 * File-by-file (not cpSync) for robustness against asar-unpacked paths in
 * Electron packaged builds. `preset.json` is hub metadata, not content —
 * it only contributes the default workspace name and is not copied.
 */
function copyWorkspaceImportContents(sourceDir: string, targetDir: string): void {
	ensureDir(targetDir);
	for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
		if (isImportNoise(entry.name) || entry.name === "preset.json") continue;
		const source = join(sourceDir, entry.name);
		const target = join(targetDir, entry.name);
		if (entry.isDirectory()) {
			copyWorkspaceImportContents(source, target);
		} else if (entry.isFile()) {
			writeFileSync(target, readFileSync(source));
		}
	}
}

/**
 * Import a workspace from a zip archive (e.g. an exported preset workspace
 * bundle). Extraction reuses the skill-zip validation (no absolute paths or
 * `..` entries), then a fresh workspace is created and seeded with the
 * archive's content. Workspace name precedence: explicit `name` →
 * `preset.json` name → top-level folder name → zip file name.
 */
function importWorkspaceZip(fileName: string, data: Buffer, name?: string): WorkspaceMeta {
	const fallbackName = basename(fileName, extname(fileName)).trim() || "导入的工作区";
	const tempRoot = join(tmpdir(), `inno-ws-import-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const zipPath = join(tempRoot, "workspace.zip");
	const extractDir = join(tempRoot, "extract");
	ensureDir(extractDir);
	writeFileSync(zipPath, data);

	try {
		validateZipEntries(zipPath);
		if (process.platform === "win32") {
			const ps = `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
				`[System.IO.Compression.ZipFile]::ExtractToDirectory(` +
				`'${zipPath.replace(/'/g, "''")}', '${extractDir.replace(/'/g, "''")}')`;
			const unzipResult = spawnSync("powershell.exe", ["-NoProfile", "-Command", ps], { encoding: "utf-8" });
			if (unzipResult.status !== 0) {
				throw new Error((unzipResult.stderr || "").trim() || "Unable to unzip workspace archive");
			}
		} else {
			const unzipResult = spawnSync("/usr/bin/unzip", ["-qq", "-o", zipPath, "-d", extractDir], { encoding: "utf-8" });
			if (unzipResult.status !== 0) {
				throw new Error((unzipResult.stderr || "").trim() || "Unable to unzip workspace archive");
			}
		}

		const contentRoot = findWorkspaceContentRoot(extractDir);
		if (!contentRoot) {
			throw new Error("The archive does not contain any importable files");
		}

		// A bundled preset.json contributes the default display name.
		let presetName = "";
		const presetJsonPath = join(contentRoot, "preset.json");
		if (existsSync(presetJsonPath) && statSync(presetJsonPath).isFile()) {
			try {
				const meta = JSON.parse(readFileSync(presetJsonPath, "utf-8")) as { name?: unknown };
				if (typeof meta.name === "string") presetName = meta.name.trim();
			} catch {
				// Malformed preset.json is ignored — it is optional metadata.
			}
		}

		const wsName = name?.trim()
			|| presetName
			|| (contentRoot !== extractDir ? basename(contentRoot).trim() : "")
			|| fallbackName;
		const ws = workspaceRegistry.createWorkspace({ name: wsName });
		const destDir = workspaceRegistry.resolveWorkspaceDir(ws.id);
		if (!destDir) {
			throw new Error(`Failed to resolve workspace dir for ${ws.id}`);
		}
		copyWorkspaceImportContents(contentRoot, destDir);
		logger.info({ workspaceId: ws.id, fileName }, "imported workspace from zip archive");
		return ws;
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// Remote content hub (skill library + preset workspaces)
//
// Backed by a RemoteContentSource (GitHub repo by default, or a self-hosted
// bundle service). The source is created lazily from config.contentHub and
// recreated whenever the hub config changes, so settings edits take effect
// without a restart.
// ---------------------------------------------------------------------------
/** Get (or rebuild) the content source for the current config.contentHub. */
function getContentSource(): RemoteContentSource {
	return contentHubCatalog.getSource();
}

/** Drop the source so the next call rebuilds it (and its cache) from config. */
function invalidateContentSource(): void {
	contentHubCatalog.invalidate();
}

function listSkillLibrary(forceRefresh = false) {
	return contentHubCatalog.listSkillLibrary(forceRefresh);
}

function listPresetLibrary(forceRefresh = false) {
	return contentHubCatalog.listPresetLibrary(forceRefresh);
}

/**
 * Import a skill from the remote library into the global skills directory.
 * Downloads the item's files into a temp dir, then installs through the same
 * path as a zip upload (validates SKILL.md, normalizes frontmatter).
 */
async function importSkillFromLibrary(skillName: string): Promise<{ name: string; filePath: string }> {
	const source = getContentSource();
	const tempRoot = join(tmpdir(), `inno-libskill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const extractDir = join(tempRoot, "extract");
	ensureDir(extractDir);
	try {
		await source.downloadItem("skills", skillName, extractDir);
		return installSkillFromExtractedDir(extractDir, slugifySkillName(skillName), skillsDir);
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

function migrateLegacyPiSkills(): void {
	const legacySkillsDir = join(paths.workspaceDir, ".pi", "skills");
	if (!existsSync(legacySkillsDir)) return;
	ensureDir(skillsDir);
	for (const entry of readdirSync(legacySkillsDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const legacySkillDir = join(legacySkillsDir, entry.name);
		const legacySkillFile = join(legacySkillDir, "SKILL.md");
		if (!existsSync(legacySkillFile)) continue;
		const content = readText(legacySkillFile);
		const skill = ensureSkillDocument(content, entry.name);
		const targetDir = join(skillsDir, skill.name);
		if (!existsSync(targetDir)) {
			ensureDir(targetDir);
			cpSync(legacySkillDir, targetDir, { recursive: true });
			writeText(join(targetDir, "SKILL.md"), skill.content);
		}
	}
}

interface SkillRegistry {
	disabled: string[];
}

function skillRegistryPath(): string {
	return join(paths.configDir, "skills.json");
}

function readSkillRegistry(): SkillRegistry {
	const registry = readJson<Partial<SkillRegistry>>(skillRegistryPath(), {});
	return {
		disabled: Array.isArray(registry.disabled)
			? registry.disabled.filter((item): item is string => typeof item === "string")
			: [],
	};
}

function writeSkillRegistry(registry: SkillRegistry): void {
	ensureDir(paths.configDir);
	writeJson(skillRegistryPath(), registry);
}

function disabledSkillNames(): Set<string> {
	return new Set(readSkillRegistry().disabled);
}

function setSkillEnabled(name: string, enabled: boolean): void {
	const registry = readSkillRegistry();
	const disabled = new Set(registry.disabled);
	if (enabled) {
		disabled.delete(name);
	} else {
		disabled.add(name);
	}
	writeSkillRegistry({ disabled: Array.from(disabled).sort() });
	writeDisabledSkillsIgnoreFile(disabled);
}

function writeDisabledSkillsIgnoreFile(disabled: Set<string>): void {
	const lines = Array.from(disabled)
		.sort()
		.map((name) => `${name}/`);
	writeText(join(skillsDir, ".ignore"), lines.length > 0 ? `${lines.join("\n")}\n` : "");
}

function listProjectSkills(): unknown[] {
	ensureDir(skillsDir);
	const disabled = disabledSkillNames();
	const loaded = getLoadedSkills();
	const loadedByPath = new Map(loaded.skills.map((skill) => [resolve(skill.filePath), skill]));
	const diagnosticsByPath = new Map<string, string[]>();
	for (const diagnostic of loaded.diagnostics) {
		if (!diagnostic.path) continue;
		const diagnosticPath = resolve(diagnostic.path);
		const list = diagnosticsByPath.get(diagnosticPath) ?? [];
		list.push(diagnostic.message);
		diagnosticsByPath.set(diagnosticPath, list);
	}

	return readdirSync(skillsDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => {
			const name = entry.name;
			const filePath = join(skillsDir, name, "SKILL.md");
			const content = existsSync(filePath) ? readText(filePath) : "";
			const stat = existsSync(filePath) ? statSync(filePath) : statSync(join(skillsDir, name));
			const loadedSkill = loadedByPath.get(resolve(filePath));
			const fields = extractFrontmatterFields(content);
			return {
				name,
				description: fields.description,
				category: fields.category || undefined,
				enabled: !disabled.has(name),
				loaded: Boolean(loadedSkill),
				filePath: relative(paths.workspaceDir, filePath),
				size: existsSync(filePath) ? stat.size : 0,
				updatedAt: stat.mtime.toISOString(),
				diagnostics: diagnosticsByPath.get(resolve(filePath)) ?? [],
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Refresh the agent's in-memory skills in the background.
 *
 * Skill listings (`listProjectSkills`) read from disk, so callers can respond
 * immediately without waiting for the agent runtime to reload. Awaiting the
 * reload inside a request handler could block the HTTP response indefinitely
 * (the reload is serialized behind the agent prompt queue), which left the
 * upload UI stuck on "uploading". Fire-and-forget keeps the request snappy.
 */
function scheduleSkillsReload(): void {
	void reloadResources().catch((err) => {
		logger.warn({ err }, "[inno-server] skills reload failed");
	});
}

function sessionTopicMetadataPath(): string {
	return join(dataDir, "sessions", "meta.json");
}

function readSessionTopicMetadata(): SessionTopicMetadata {
	return readJson<SessionTopicMetadata>(sessionTopicMetadataPath(), {});
}

function writeSessionTopic(id: string, topic: string, generated = false, extra?: { upgraded?: boolean }): void {
	const metadata = readSessionTopicMetadata();
	metadata[id] = { topic, generated, updatedAt: new Date().toISOString(), ...(extra?.upgraded ? { upgraded: true } : {}) };
	writeJson(sessionTopicMetadataPath(), metadata);
}

function parseSessionFile(filePath: string): { summary: SessionSummary; messages: SessionMessageSummary[] } | null {
	try {
		const raw = readFileSync(filePath, "utf-8");
		const lines = raw.split("\n").filter((line) => line.trim().length > 0);
		const entries = selectActiveSessionEntries(lines.map((line) => JSON.parse(line) as Record<string, unknown>));
		const messages: SessionMessageSummary[] = [];
		const channels = new Set<SessionChannel>();
		let createdAt = "";
		let lastMessageAt = "";

		// Aggregator for the in-progress assistant turn. PI splits one assistant
		// turn into multiple JSONL entries (thinking + toolCalls + toolResults
		// + final text), so we merge them back into a single bubble.
		let pendingAssistant: SessionMessageSummary | null = null;
		const finalizeAssistant = () => {
			if (pendingAssistant) {
				messages.push(pendingAssistant);
				pendingAssistant = null;
			}
		};
		const ensureAssistant = (timestamp: number): SessionMessageSummary => {
			if (!pendingAssistant) {
				pendingAssistant = { role: "assistant", content: "", timestamp };
			}
			return pendingAssistant;
		};

		for (const entry of entries) {
			const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : "";
			if (!createdAt && timestamp) createdAt = timestamp;
			// Detect channel ONLY from structured JSON fields written by the system
			// (message.channel / message.source / message.api / message.model).
			// We intentionally do NOT substring-match the raw line for natural-language
			// keywords like "飞书" / "scheduled" — those appear in ordinary user/assistant
			// text and would falsely tag a web session as a feishu/scheduler session.
			// Verified on unmodified code: a learner asking "飞书的英文名?" (user text)
			// or a reply that merely mentions "飞书" (assistant text) both got mislabeled
			// as channel=feishu even though origin stayed web. The authoritative channel
			// record lives in channels.json (via recordCurrentSessionChannel); this
			// detection is only a best-effort hint for legacy sessions that predate it.
			let entryChannel: SessionChannel | undefined;
			const msgObj = entry.type === "message" && entry.message && typeof entry.message === "object"
				? entry.message as Record<string, unknown>
				: undefined;
			const channelField = typeof msgObj?.channel === "string" ? (msgObj.channel as string) : "";
			const sourceField = typeof msgObj?.source === "string" ? (msgObj.source as string) : "";
			const apiField = typeof msgObj?.api === "string" ? (msgObj.api as string) : "";
			const modelField = typeof msgObj?.model === "string" ? (msgObj.model as string) : "";
			if (channelField === "feishu") {
				channels.add("feishu");
				entryChannel = "feishu";
			}
			if (channelField === "wechat" || channelField === "wecom") {
				channels.add("wechat");
				entryChannel = entryChannel ?? "wechat";
			}
			if (channelField === "qq") {
				channels.add("qq");
				entryChannel = entryChannel ?? "qq";
			}
			if (sourceField === "web" || channelField === "web") {
				channels.add("web");
				entryChannel = entryChannel ?? "web";
			}
			// Scheduler-authored assistant messages carry a synthetic api/model marker.
			if (apiField === "inno-background" || modelField === "scheduler") {
				channels.add("scheduler");
				entryChannel = entryChannel ?? "scheduler";
			}

			if (!msgObj) continue;
			if (timestamp) lastMessageAt = timestamp;
			const message = msgObj;
			const role = message.role;
			const ts = timestamp ? Date.parse(timestamp) : Date.now();

			if (role === "user") {
				finalizeAssistant();
				const content = textFromContent(message.content);
				if (!content) continue;
				const images = imagesFromContent(message.content);
				const msg: SessionMessageSummary = {
					role: "user",
					content,
					timestamp: ts,
					channel: entryChannel,
					entryId: typeof entry.id === "string" ? entry.id : undefined,
					parentEntryId: typeof entry.parentId === "string" ? entry.parentId : null,
				};
				if (images.length > 0) msg.images = images;
				messages.push(msg);
				continue;
			}

			if (role === "assistant") {
				const pending = ensureAssistant(ts);
				if (entryChannel && !pending.channel) pending.channel = entryChannel;
				const content = message.content;
				if (Array.isArray(content)) {
					for (const part of content) {
						if (!part || typeof part !== "object") continue;
						const block = part as Record<string, unknown>;
						if (block.type === "text" && typeof block.text === "string") {
							pending.content = pending.content
								? `${pending.content}\n${block.text}`
								: block.text;
						} else if (block.type === "thinking" && typeof block.thinking === "string") {
							pending.thinking = pending.thinking
								? `${pending.thinking}\n${block.thinking}`
								: block.thinking;
						} else if (block.type === "toolCall") {
							const toolCallId = typeof block.id === "string" ? block.id : "";
							const toolName = typeof block.name === "string" ? block.name : "tool";
							const args = block.arguments;
							pending.tools = pending.tools ?? [];
							pending.tools.push({
								toolCallId,
								toolName,
								args,
								contentOffset: pending.content.length,
							});
						}
					}
				} else if (typeof content === "string" && content) {
					pending.content = pending.content ? `${pending.content}\n${content}` : content;
				}
				pending.timestamp = ts;
				// If this assistant entry ended the turn (stopReason "stop"), finalize.
				if (typeof message.stopReason === "string" && message.stopReason !== "toolUse") {
					finalizeAssistant();
				}
				continue;
			}

			if (role === "toolResult") {
				const pending = ensureAssistant(ts);
				const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : "";
				const toolName = typeof message.toolName === "string" ? message.toolName : "tool";
				// PI keeps a tool's structured details alongside its text content. Keep
				// those details in session history so completed questionnaires can be
				// rendered with the selected options, and the todo widget can rebuild
				// its task list, after the session is reopened.
				const result = (toolName === "ask_user_question" || toolName === "todo") && message.details !== undefined
					? message.details
					: textFromContent(message.content) || message.content;
				const isError = Boolean(message.isError);
				pending.tools = pending.tools ?? [];
				const existing = pending.tools.find((t) => t.toolCallId === toolCallId);
				if (existing) {
					existing.result = result;
					existing.isError = isError;
				} else {
					pending.tools.push({ toolCallId, toolName, args: undefined, result, isError });
				}
				continue;
			}
		}
		finalizeAssistant();

		// Filter out empty assistant entries (no text, no thinking, no tools).
		const filtered = messages.filter((m) =>
			m.role === "user" ? !!m.content : (m.content || m.thinking || (m.tools && m.tools.length > 0)),
		);

		const displayMessages = mergeSessionAgentCommands(dataDir, basename(filePath), filtered);
		const firstUser = displayMessages.find((message) => message.role === "user");
		const preview = firstUser?.content.trim() ?? "";
		const name = preview ? (preview.length > 48 ? `${preview.slice(0, 45)}...` : preview) : basename(filePath);
		const stat = statSync(filePath);
		const fallbackTime = stat.mtime.toISOString();
		return {
			summary: {
				id: basename(filePath),
				name,
				createdAt: createdAt || fallbackTime,
				updatedAt: lastMessageAt || createdAt || fallbackTime,
				messageCount: filtered.length,
				preview,
				channels: channels.size > 0 ? Array.from(channels) : [],
			},
			messages: displayMessages,
		};
	} catch (err) {
		return null;
	}
}

function sessionChannelMetadataPath(): string {
	return join(dataDir, "sessions", "channels.json");
}

// --- Pending question persistence (survives process restart) ---
function sessionQuestionMetadataPath(): string {
	return join(dataDir, "sessions", "questions.json");
}

/** In-memory cache of questions.json — read once, updated on every write.
 *  Avoids a synchronous readFileSync on every session-detail request. */
let _questionMetadataCache: SessionQuestionMetadata | null = null;

function readSessionQuestionMetadata(): SessionQuestionMetadata {
	if (_questionMetadataCache === null) {
		_questionMetadataCache = readJson<SessionQuestionMetadata>(sessionQuestionMetadataPath(), {});
	}
	return _questionMetadataCache;
}

function writeSessionQuestionMetadata(meta: SessionQuestionMetadata): void {
	_questionMetadataCache = meta;
	writeJson(sessionQuestionMetadataPath(), meta);
}

function readSessionChannelMetadata(): SessionChannelMetadata {
	return readJson<SessionChannelMetadata>(sessionChannelMetadataPath(), {});
}

function recordCurrentSessionChannel(
	channel: SessionChannel,
	explicitSessionId?: string,
	options?: { setOriginIfEmpty?: boolean },
): void {
	const id = explicitSessionId || (() => {
		const sessionFile = getSession().sessionFile;
		return sessionFile ? basename(sessionFile) : "";
	})();
	if (!id) return;
	const metadata = readSessionChannelMetadata();
	const prev = metadata[id];
	metadata[id] = {
		channels: mergeChannels(prev?.channels ?? [], [channel]),
		// origin is the immutable birthplace of the session: set once and never
		// overwritten. Interaction tagging (e.g. a web session pushing a file to
		// feishu) must NOT change origin, so it omits setOriginIfEmpty.
		origin: prev?.origin ?? (options?.setOriginIfEmpty ? channel : undefined),
		updatedAt: new Date().toISOString(),
	};
	writeJson(sessionChannelMetadataPath(), metadata);
}

function cleanGeneratedTopic(raw: string): string {
	return raw
		.replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "")
		.replace(/^标题[:：]\s*/i, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 32);
}

/** Strip machine-injected prefixes (e.g. the image-upload hint prepended to
 *  user prompts) so titles reflect the user's actual words. */
function stripInjectedPrefix(content: string): string {
	return content
		.replace(/^\[用户本轮上传了 \d+ 张图片，已保存到工作区：[\s\S]*?\]\s*/, "")
		.trim();
}

function fallbackTopicFromMessages(messages: SessionMessageSummary[], summary: SessionSummary): string {
	const source = stripInjectedPrefix(messages.find((message) => message.role === "user")?.content || "") || summary.preview || summary.name;
	const cleaned = source.replace(/\s+/g, " ").trim();
	return cleaned ? (cleaned.length > 28 ? `${cleaned.slice(0, 28)}...` : cleaned) : "New conversation";
}

/** Build the dialogue excerpt for topic generation: first 2 + last 4 usable
 *  messages (the opening states the goal, the tail captures where the
 *  conversation actually went), consecutive duplicates dropped (scheduler
 *  nudges repeat), machine prefixes stripped, ~2400 chars. */
function buildTopicExcerpt(messages: SessionMessageSummary[]): string {
	const usable = messages
		.map((message) => ({
			role: message.role,
			content: stripInjectedPrefix(message.content).replace(/\s+/g, " ").trim(),
		}))
		.filter((message) => message.content)
		.filter((message, index, all) => index === 0 || message.content !== all[index - 1].content);
	const picked = usable.length <= 6 ? usable : [...usable.slice(0, 2), ...usable.slice(-4)];
	return picked
		.map((message) => `${message.role === "user" ? "用户" : "助手"}: ${message.content}`)
		.join("\n")
		.slice(0, 2400);
}

async function generateSessionTopic(summary: SessionSummary, messages: SessionMessageSummary[]): Promise<string> {
	const excerpt = buildTopicExcerpt(messages);

	if (!excerpt) return fallbackTopicFromMessages(messages, summary);

	const prompt = `请用一句简短的中文短语概括下面学习对话中用户的学习目标或任务。
要求：
- 只输出标题本身，不要解释
- 8 到 16 个中文字符
- 聚焦用户想学的内容或要做的任务，忽略寒暄、客套话和系统提示
- 不要使用引号、句号或冒号

示例一：
对话：
用户: 你好
助手: 你好！今天想学点什么？
用户: 我一直搞不清贝叶斯定理，能举个生活中的例子讲讲吗
标题：贝叶斯定理入门

示例二：
对话：
用户: 帮我把这份教案改成 45 分钟公开课的版本
助手: 好的，我先看看教案的结构……
标题：教案改编公开课版

对话：
${excerpt}
标题：`;

	try {
		// Reasoning models burn tokens on a thinking block before any visible
		// text — a tiny maxTokens (e.g. 64) gets fully consumed by thinking and
		// yields an empty title. 1024 leaves ample room for both.
		const generated = cleanGeneratedTopic(await completePromptOnce(prompt, 1024));
		return generated || fallbackTopicFromMessages(messages, summary);
	} catch (err) {
		return fallbackTopicFromMessages(messages, summary);
	}
}

/**
 * Auto-generate a topic for a session if it doesn't already have one.
 * Runs asynchronously — fire and forget.
 *
 * Two passes, both guarded by `_pendingAutoTopics`:
 * 1. First pass: no topic recorded yet and ≥2 messages (the first exchange).
 * 2. Upgrade pass: the existing topic is auto-generated (never a manual
 *    rename), hasn't been upgraded yet, and the conversation has grown to
 *    TOPIC_UPGRADE_MESSAGE_THRESHOLD messages — the first-pass title was
 *    based on a single exchange and is often vague, so re-roll it once with
 *    richer context.
 */
const _pendingAutoTopics = new Set<string>();
const TOPIC_UPGRADE_MESSAGE_THRESHOLD = 6;

function maybeAutoGenerateTopic(sessionId: string): void {
	if (!sessionId || _pendingAutoTopics.has(sessionId)) return;
	const existing = readSessionTopicMetadata()[sessionId];
	if (existing && (!existing.generated || existing.upgraded)) return;

	const sessionPath = sessionFileFromId(join(dataDir, "sessions"), sessionId);
	if (!sessionPath || !existsSync(sessionPath)) return;

	_pendingAutoTopics.add(sessionId);
	void (async () => {
		try {
			const parsed = parseSessionFile(sessionPath);
			if (!parsed || parsed.messages.length < 2) return;
			if (existing && parsed.messages.length < TOPIC_UPGRADE_MESSAGE_THRESHOLD) return;
			const topic = await generateSessionTopic(parsed.summary, parsed.messages);
			writeSessionTopic(sessionId, topic, true, existing ? { upgraded: true } : undefined);
			logger.info(`[auto-topic] ${sessionId} → ${topic}${existing ? " (upgraded)" : ""}`);
		} catch (err) {
			logger.warn({ err }, `auto-topic generation failed for ${sessionId}`);
		} finally {
			_pendingAutoTopics.delete(sessionId);
		}
	})();
}

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------

/**
 * The prompt currently holding the shared serial queue, if any. Only prompts
 * hold queue slots for a meaningful duration; switch/create are instant.
 */
function getQueueBlocker(): { sessionId: string; turnId: string; questionPending: boolean } | null {
	const token = getActivePromptToken();
	if (!token) return null;
	const state = streamRegistry.getByTurn(token);
	if (!state || (state.status !== "queued" && state.status !== "running")) return null;
	const pending = questionBridge.pendingInfo();
	return {
		sessionId: state.sessionId,
		turnId: state.turnId,
		questionPending: pending?.turnId === state.turnId,
	};
}

/**
 * Session-retention policy (issue #124): a turn parked on a question card can
 * never progress without the user, yet it holds the shared prompt queue for
 * up to the 30-minute question timeout — blocking every session switch /
 * creation behind it. Navigating to a DIFFERENT session implicitly abandons
 * the card, so abort that turn to release the queue. Turns that are actively
 * generating are left alone (they end on their own; the user can still stop
 * them explicitly via the scoped abort endpoint).
 *
 * Mirrors the scoped abort route: cancel the registry state, resolve the
 * parked question (session.abort() alone cannot wake it), then abort.
 */
function releaseQueueFromQuestionBlockedTurn(targetSessionId: string): void {
	const blocker = getQueueBlocker();
	if (!blocker || !blocker.questionPending || blocker.sessionId === targetSessionId) return;
	const state = streamRegistry.getByTurn(blocker.turnId);
	if (!state) return;
	logger.info({ blockedSession: blocker.sessionId, turnId: blocker.turnId, targetSessionId }, "auto-aborting question-blocked turn to release the prompt queue");
	streamRegistry.requestCancel(state);
	questionBridge.unbindTurn({ sessionId: state.sessionId, turnId: state.turnId, reason: "switched_away" });
	if (state.status === "running") void abortPromptForTurnToken(state.turnId);
}

/**
 * Run an enqueue-backed operation with a hard wait bound. If the queue is
 * held by a long turn the caller gets a 409 with blocker details instead of
 * hanging for minutes; a client disconnect cancels the still-queued task so
 * it never executes out from under a user who already gave up.
 */
async function runQueueOpWithTimeout<T>(
	_req: HttpReq,
	res: ServerResponse,
	op: (signal: AbortSignal) => Promise<T>,
	timeoutMs = 8_000,
): Promise<T | null> {
	const aborter = new AbortController();
	// res "close" with the response unfinished = the client went away. (req
	// "close" is unusable here: it fires as soon as the request body is fully
	// received, long before we answer.)
	res.on("close", () => { if (!res.writableFinished) aborter.abort(); });
	const timer = setTimeout(() => aborter.abort(), timeoutMs);
	try {
		return await op(aborter.signal);
	} catch (err) {
		if (isQueueTaskCancelled(err)) {
			if (!res.writableFinished && !res.destroyed) {
				json(res, 409, { error: "session_busy", blocking: getQueueBlocker() ?? undefined });
			}
			return null;
		}
		throw err;
	} finally {
		clearTimeout(timer);
	}
}

const server = createServer(async (req, res) => {
	const url = req.url ?? "/";
	const method = req.method ?? "GET";

	try {
		// --- Health check (no bootstrap needed) ---
		if (method === "GET" && (url === "/health" || url === "/api/health")) {
			json(res, 200, { status: "ok" });
			return;
		}

		// --- Lazy bootstrap on first API request ---
		// All /api/* endpoints need the agent session and data stores.
		// Static files and SPA fallback skip this so no directories are
		// created until the user actually interacts with the web UI.
		if (url.startsWith("/api/")) {
			await ensureBootstrapped();
		}

		// --- Jobs CRUD (extracted to server/routes/jobs.ts) ---
		if (await handleJobsRoutes(req, res, method, url, { jobStore, channelRegistry })) return;

		// --- Channels + bridge (extracted to server/routes/channels.ts) ---
		if (await handleChannelsRoutes(req, res, method, url, {
			channelRegistry,
			dataDir,
			configPath: paths.configPath,
			getConfig: () => config,
			setConfig: (next) => { config = next; },
			getDispatcher: () => dispatcher,
			getBridgeToken: () => bridgeToken,
			reloadFeishuChannel,
			getWechatChannel: () => wechatChannel,
			setWechatChannel: (channel) => { wechatChannel = channel; },
		})) return;

		// --- Skills API ---
		if (await handleSkillsRoutes(req, res, method, url, {
			skillsDir,
			scheduleSkillsReload,
			listProjectSkills,
			setSkillEnabled,
			installSkillZip,
			installSkillMarkdown,
			listSkillLibrary,
			importSkillFromLibrary,
		})) return;

		// --- Sessions API (extracted to server/routes/sessions.ts) ---
		if (await handleSessionsRoutes(req, res, method, url, {
			workspaceRegistry, dataDir, paths, getContentSource,
			getCachedPresetAvailability: (presetId) => contentHubCatalog.getCachedPresetAvailability(presetId),
			parseSessionFile, sessionRevision,
			readSessionChannelMetadata, sessionChannelMetadataPath,
			readSessionTopicMetadata, sessionTopicMetadataPath, writeSessionTopic,
			readSessionQuestionMetadata, writeSessionQuestionMetadata,
			recordCurrentSessionChannel, generateSessionTopic,
			sessionFileFromId, releaseQueueFromQuestionBlockedTurn, runQueueOpWithTimeout,
		})) return;

		// --- Wiki + L2 raw upload API (extracted to server/routes/wiki.ts) ---
		if (await handleWikiRoutes(req, res, method, url, { l2DataDir })) return;

		// --- Learner profile API (extracted to server/routes/learner.ts) ---
		if (await handleLearnerRoutes(req, res, method, url, { paths, l2DataDir })) return;

		// --- Workspace API + registry + session binding (extracted to server/routes/workspaces.ts) ---
		if (await handleWorkspacesRoutes(req, res, method, url, {
			workspaceRegistry, dataDir, paths,
			installSkillZip, installSkillMarkdown, scheduleSkillsReload, importWorkspaceZip,
			sessionFileFromId, releaseQueueFromQuestionBlockedTurn, runQueueOpWithTimeout,
		})) return;

		// --- Presets API (extracted to server/routes/presets.ts) ---
		if (await handlePresetsRoutes(req, res, method, url, { paths, listPresetLibrary })) return;

		// --- Terminal sessions + Runs (extracted to server/routes/practice.ts) ---
		if (await handlePracticeRoutes(req, res, method, url, {
			workspaceRegistry, l2DataDir, terminalManager, runRecordStore,
		})) return;

		// --- Settings + MCP API (extracted to server/routes/settings.ts) ---
		if (await handleSettingsRoutes(req, res, method, url, {
			paths,
			getConfig: () => config,
			setConfig: (next) => { config = next; },
			reloadFeishuChannel,
			scheduleSkillsReload,
			invalidateContentSource,
		})) return;

		// --- Slash commands API (extracted to server/routes/commands.ts) ---
		if (await handleCommandsRoutes(req, res, method, url)) return;

		// --- Chat API (extracted to server/routes/chat.ts) ---
		if (await handleChatRoutes(req, res, method, url, {
			workspaceRegistry, dataDir, paths,
			sessionFileFromId, releaseQueueFromQuestionBlockedTurn,
			readSessionQuestionMetadata, writeSessionQuestionMetadata,
			recordCurrentSessionChannel, maybeAutoGenerateTopic,
			parseSessionFile, sessionRevision,
		})) return;

		// --- Static files / SPA fallback ---
		if (method === "GET" || method === "HEAD") {
			const urlPath = decodeURIComponent(url.split("?")[0]);
			const staticPath = safeJoinReal(webDistDir, urlPath.replace(/^\/+/, ""));
			const sendBody = method === "GET";
			// Try exact file in web/dist
			if (staticPath && serveStatic(req, res, staticPath, sendBody, webDistDir)) return;
			// Never route an asset miss through the SPA fallback. Returning
			// index.html with a 200 status for a stale hashed JS/CSS URL makes the
			// browser report an opaque dynamic-import failure instead of exposing
			// the real missing asset and prevents a panel retry from recovering.
			const isAssetRequest = urlPath === "/assets" || urlPath.startsWith("/assets/");
			// SPA fallback: serve index.html for non-API, non-asset paths only. An
			// unmatched /api/* route must fall through to the JSON 404 — returning
			// HTML with a 200 status breaks API client error handling.
			if (!isAssetRequest && urlPath !== "/api" && !urlPath.startsWith("/api/") && serveStatic(req, res, join(webDistDir, "index.html"), sendBody, webDistDir)) return;
		}

		// --- 404 ---
		json(res, 404, { error: "Not found" });
	} catch (err) {
		logger.error({ err }, "unhandled error in HTTP handler");
		// SSE/streaming responses have already sent headers — calling json()
		// here would throw ERR_HTTP_HEADERS_SENT from inside this catch block
		// and kill the process. The only safe move is to end the stream.
		if (res.headersSent) {
			try { res.end(); } catch { /* best effort */ }
			return;
		}
		// readBody failures carry a client-facing status (400/413); anything
		// else is an internal error and must not leak details.
		if (err instanceof HttpError) {
			if (err.statusCode === 413) {
				// The oversized body was never consumed, so this connection is
				// unsafe for keep-alive — Node closes it after the response.
				res.setHeader("Connection", "close");
			}
			json(res, err.statusCode, { error: err.message });
			return;
		}
		json(res, 500, { error: "Internal server error" });
	}
});

// ---------------------------------------------------------------------------
// Terminal WebSocket setup (the bindTerminalWs helper references the lazy
// terminalManager, but the upgrade handler only fires AFTER the first successful
// bootstrap — terminal WebSocket connections can't happen before then).
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
	const url = req.url ?? "";
		if (!bootstrapped) { socket.destroy(); return; }
	const m = /^\/api\/terminal\/sessions\/([^/?]+)\/ws$/.exec(url.split("?")[0]);
	if (!m) {
		socket.destroy();
		return;
	}
	const terminalId = decodeURIComponent(m[1]);
	const ts = terminalManager.get(terminalId);
	if (!ts) {
		socket.destroy();
		return;
	}
	wss.handleUpgrade(req, socket, head, (ws) => {
		bindTerminalWs(ws, terminalId);
	});
});

function sendTerminal(ws: WebSocket, event: ServerTerminalEvent): void {
	if (ws.readyState === ws.OPEN) {
		ws.send(JSON.stringify(event));
	}
}

function bindTerminalWs(ws: WebSocket, terminalId: string): void {
	const ts = terminalManager.get(terminalId);
	if (!ts) {
		sendTerminal(ws, { type: "error", message: "Terminal not found" });
		ws.close();
		return;
	}

	sendTerminal(ws, { type: "ready", sessionId: ts.sessionId, cwd: ts.cwd, workspaceId: ts.workspaceId });

	const offData = ts.pty.onData((chunk: string) => {
		const { cleaned, finishedRun } = terminalManager.processOutput(ts, chunk);
		if (cleaned) {
			terminalManager.recordOutput(ts, cleaned);
			sendTerminal(ws, { type: "output", data: cleaned });
		}
		if (finishedRun) {
			const run = terminalManager.finishActiveRun(ts, finishedRun.exitCode);
			sendTerminal(ws, { type: "exit", code: finishedRun.exitCode, runId: run?.id });
		}
	});
	const offExit = ts.pty.onExit(({ exitCode, signal }) => {
		const run = terminalManager.finishActiveRun(ts, exitCode, signal ? String(signal) : undefined);
		sendTerminal(ws, { type: "exit", code: exitCode, signal: signal ? String(signal) : undefined, runId: run?.id });
		ws.close();
	});

	ws.on("message", (raw) => {
		let event: ClientTerminalEvent;
		try {
			event = JSON.parse(raw.toString()) as ClientTerminalEvent;
		} catch (err) {
			sendTerminal(ws, { type: "error", message: "Invalid JSON" });
			return;
		}
		switch (event.type) {
			case "input":
				if (typeof event.data === "string") ts.pty.write(event.data);
				break;
			case "resize":
				if (typeof event.cols === "number" && typeof event.rows === "number") {
					ts.pty.resize(event.cols, event.rows);
				}
				break;
			case "run": {
				if (typeof event.command !== "string" || !event.command.trim()) break;
				if (event.command.length > 4096) {
					sendTerminal(ws, { type: "error", message: "Command too long" });
					break;
				}
				const record = terminalManager.startRun(ts, event.command, event.sourceFile);
				sendTerminal(ws, { type: "run_started", runId: record.id, command: event.command });
				break;
			}
			case "close":
				ws.close();
				break;
		}
	});

	ws.on("close", () => {
		offData();
		offExit();
		terminalManager.finishActiveRun(ts, null);
	});
}

// ---------------------------------------------------------------------------
// Start listening immediately — /health and static files work right away.
// All other endpoints call ensureBootstrapped() lazily on first request.
// ---------------------------------------------------------------------------

// Inject persistence callbacks into questionBridge so pending question cards
// survive a full process restart.
questionBridge.setPersistence({
	save: (sessionId, question) => {
		const meta = readSessionQuestionMetadata();
		meta[sessionId] = question;
		writeSessionQuestionMetadata(meta);
	},
	remove: (sessionId) => {
		const meta = readSessionQuestionMetadata();
		if (sessionId in meta) {
			delete meta[sessionId];
			writeSessionQuestionMetadata(meta);
		}
	},
});

// Process-level last resort: a stray rejection or an exception escaping a
// catch block would otherwise kill the process silently (or via a secondary
// ERR_HTTP_HEADERS_SENT from the catch-all). Log at fatal level, close the
// HTTP/WS servers so clients see a clean close, then exit — after an
// uncaught exception the process state is untrustworthy, so we do not
// attempt to continue serving.
installProcessFallbacks({
	onFatal: () => {
		try { server.close(); } catch { /* best effort */ }
		try { wss.close(); } catch { /* best effort */ }
	},
});

server.listen(port, () => {
	console.log(`[inno-server] listening on http://localhost:${port}`);
	console.log(`[inno-server] config: ${paths.configPath}`);
});
