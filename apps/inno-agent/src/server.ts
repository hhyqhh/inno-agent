import { createServer, type IncomingMessage as HttpReq, type ServerResponse } from "node:http";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { getConfiguredPort, loadConfig, saveConfig, setDefaultModel, upsertProvider, deleteProvider, type InnoModelConfig, type InnoProviderConfig } from "./config.js";
import { ensureDir, readJson, readText, writeJson, writeText } from "./storage/file-store.js";
import {
	createNewSession,
	getCurrentSessionId,
	getAvailableModels,
	getLoadedSkills,
	getSession,
	initSession,
	refreshConfiguredProviders,
	reloadResources,
	switchModel,
	switchSessionFile,
	syncConfig,
	applyWorkspaceCwd,
	setWorkspaceCwdResolver,
} from "./agent/pi-runner.js";
import { completePromptOnce, runPromptSerialized, runPromptStreaming, runPromptStreamingInSession, runPromptInSession, abortCurrentPrompt, persistPendingUserTurn } from "./agent/pi-runner.js";
import type { ImageContent } from "@earendil-works/pi-ai";
import { ChannelRegistry } from "./channels/channel.js";
import { FeishuChannel } from "./channels/feishu/feishu-channel.js";
import { PersonalChannelDispatcher } from "./channels/personal-dispatcher.js";
import { BridgeChannel } from "./channels/bridge/bridge-channel.js";
import { handleBridgeMessage } from "./channels/bridge/bridge-server.js";
import { WeChatChannel } from "./channels/wechat/wechat-channel.js";
import type { PersonalBridgeChannelConfig } from "./config.js";
import { JobStore } from "./scheduler/job-store.js";
import { executeJob } from "./scheduler/job-runner.js";
import { CronScheduler } from "./scheduler/cron-scheduler.js";
import { validateCron } from "./scheduler/cron-utils.js";
import { parseFrontmatter, serializeFrontmatter } from "./memory/l2/wiki-maintainer.js";
import { readManifest } from "./memory/l2/manifest-store.js";
import { loadProfile, saveProfile } from "./memory/learner/profile-store.js";
import type { LearnerProfile, LearningGoal, KnowledgeState, Misconception, LearnerPreferences } from "./memory/learner/types.js";
import { randomUUID } from "node:crypto";
import { applyRuntimeEnvironment, parseRuntimeArgs, resolveRuntimePaths } from "./runtime.js";
import { questionBridge, type QuestionBridgeResult } from "./agent/question-bridge.js";
import { DEFAULT_WORKSPACE_ID, TEMP_WORKSPACE_ID, WorkspaceRegistry } from "./workspace/workspace-registry.js";
import { RunRecordStore } from "./terminal/run-record-store.js";
import { TerminalSessionManager } from "./terminal/terminal-session-manager.js";
import type { ClientTerminalEvent, ServerTerminalEvent } from "./terminal/terminal-types.js";
import { WebSocketServer, type WebSocket } from "ws";

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

setGlobalDispatcher(new EnvHttpProxyAgent({ bodyTimeout: 0, headersTimeout: 0 }));

const parsed = parseRuntimeArgs(process.argv.slice(2));
const paths = resolveRuntimePaths(parsed.options);
applyRuntimeEnvironment(paths);
let config = loadConfig(paths.configPath);
const port = getConfiguredPort(config, parsed.options.port);

// Ensure directories
const dataDir = paths.dataDir;
ensureDir(paths.learnerDataDir);
ensureDir(paths.sessionDir);
ensureDir(paths.jobsDir);
ensureDir(paths.skillsDir);
ensureDir(paths.workspaceDir);

// Stores
const jobStore = new JobStore(paths.jobsDir);
jobStore.normalizePersistedJobs();
const l2DataDir = paths.l2DataDir;
const skillsDir = paths.skillsDir;
const channelRegistry = new ChannelRegistry(join(dataDir, "channels", "default-targets.json"));
const workspaceRegistry = new WorkspaceRegistry(paths.workspaceDir, dataDir);
workspaceRegistry.ensureBootstrapped();
// One-time: bind legacy unbound sessions to the default workspace IF it still
// exists (older installs). On fresh installs the default workspace is gone, so
// migrateUnboundSessions no-ops and unbound sessions fall back to tmp.
try {
	const sessionFiles = existsSync(paths.sessionDir)
		? readdirSync(paths.sessionDir).filter((f) => f.endsWith(".jsonl"))
		: [];
	workspaceRegistry.migrateUnboundSessions(sessionFiles, DEFAULT_WORKSPACE_ID);
} catch (err) {
	console.warn("[sessions] unbound-session migration failed:", err instanceof Error ? err.message : err);
}
const runRecordStore = new RunRecordStore(join(dataDir, "runs"));
const terminalManager = new TerminalSessionManager(workspaceRegistry, runRecordStore);

// Resolve agent cwd per session based on its workspace binding.
setWorkspaceCwdResolver((sessionPath: string) => {
	const id = basename(sessionPath);
	const workspaceId = workspaceRegistry.getSessionWorkspaceId(id);
	return workspaceRegistry.resolveWorkspaceDir(workspaceId);
});

migrateLegacyPiSkills();

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

// Register enabled channels
let feishuChannel: FeishuChannel | null = null;
if (config.feishu?.appId && config.channels?.feishu?.enabled) {
	feishuChannel = new FeishuChannel(config.feishu, dataDir, config.channels.feishu);
	channelRegistry.register(feishuChannel);
}

// Register bridge channels (QQ, and WeChat in bridge mode)
const bridgeToken = config.bridge?.token;
if (bridgeToken) {
	const qqConfig = config.channels?.qq as PersonalBridgeChannelConfig | undefined;
	if (qqConfig?.enabled && qqConfig.sidecarBaseUrl) {
		channelRegistry.register(new BridgeChannel("qq", qqConfig.sidecarBaseUrl, bridgeToken));
	}
	const wechatConfig = config.channels?.wechat;
	if (wechatConfig?.enabled && "sidecarBaseUrl" in wechatConfig && (wechatConfig as PersonalBridgeChannelConfig).mode === "bridge") {
		channelRegistry.register(new BridgeChannel("wechat", (wechatConfig as PersonalBridgeChannelConfig).sidecarBaseUrl, bridgeToken));
	}
}

// Register WeChat iLink channel (native mode, default)
let wechatChannel: WeChatChannel | null = null;
const wechatConfig = config.channels?.wechat;
if (wechatConfig?.enabled && (!("mode" in wechatConfig) || (wechatConfig as { mode?: string }).mode !== "bridge")) {
	wechatChannel = new WeChatChannel(dataDir, wechatConfig);
	channelRegistry.register(wechatChannel);
}
migrateReminderChannels();

let dispatcher: PersonalChannelDispatcher | null = null;

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function readBody(req: HttpReq): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let data = "";
		req.on("data", (chunk: Buffer) => {
			data += chunk.toString();
		});
		req.on("end", () => {
			try {
				resolve(data ? JSON.parse(data) : {});
			} catch {
				reject(new Error("Invalid JSON body"));
			}
		});
		req.on("error", reject);
	});
}

function json(res: ServerResponse, status: number, data: unknown): void {
	const body = data !== null ? JSON.stringify(data) : "";
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(body),
	});
	res.end(body);
}

function maskSecret(value: string | undefined): string {
	return value ? `****${value.slice(-4)}` : "";
}

function providerModelToRuntimeModel(model: InnoModelConfig, provider: string, baseUrl: string) {
	return {
		id: model.id,
		name: model.name,
		provider,
		reasoning: model.reasoning,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		baseUrl,
	};
}

function buildSafeSettings() {
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
				},
			]),
		),
		feishu: config.feishu
			? { ...config.feishu, appSecret: config.feishu.appSecret ? "****" : "" }
			: undefined,
		bridge: config.bridge
			? { token: maskSecret(config.bridge.token) }
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
		contextWindow: typeof record.contextWindow === "number" ? record.contextWindow : Number(record.contextWindow ?? 128000),
		maxTokens: typeof record.maxTokens === "number" ? record.maxTokens : Number(record.maxTokens ?? 8192),
	};
}

function parseProviderPayload(body: Record<string, unknown>): {
	providerId: string;
	provider: InnoProviderConfig;
	makeDefault: boolean;
	preserveApiKey: boolean;
} {
	const providerId = typeof body.providerId === "string" ? body.providerId.trim() : "";
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(providerId)) {
		throw new Error("Provider id must use letters, numbers, dot, underscore, or dash");
	}
	const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
	const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
	const api = typeof body.api === "string" ? body.api.trim() : "openai-completions";
	const rawModels = Array.isArray(body.models) ? body.models : [];
	const models = rawModels.map(parseModelConfig);
	return {
		providerId,
		provider: { baseUrl, apiKey, api, models },
		makeDefault: Boolean(body.makeDefault),
		preserveApiKey: Boolean(body.preserveApiKey),
	};
}

/**
 * Simple route matching with :param support.
 * Returns params object or null if no match.
 */
function matchRoute(
	method: string,
	reqMethod: string,
	reqUrl: string,
	pattern: string,
): Record<string, string> | null {
	if (reqMethod !== method) return null;
	const url = reqUrl.split("?")[0];
	const patternParts = pattern.split("/");
	const urlParts = url.split("/");
	if (patternParts.length !== urlParts.length) return null;

	const params: Record<string, string> = {};
	for (let i = 0; i < patternParts.length; i++) {
		if (patternParts[i].startsWith(":")) {
			try {
				params[patternParts[i].slice(1)] = decodeURIComponent(urlParts[i]);
			} catch {
				params[patternParts[i].slice(1)] = urlParts[i];
			}
		} else if (patternParts[i] !== urlParts[i]) {
			return null;
		}
	}
	return params;
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

function serveStatic(res: ServerResponse, filePath: string, sendBody = true): boolean {
	try {
		if (!existsSync(filePath) || !statSync(filePath).isFile()) return false;
		const ext = extname(filePath);
		const contentType = MIME_TYPES[ext] || "application/octet-stream";
		const content = readFileSync(filePath);
		res.writeHead(200, { "Content-Type": contentType, "Content-Length": content.length });
		res.end(sendBody ? content : undefined);
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Local data helpers
// ---------------------------------------------------------------------------

function safeJoin(baseDir: string, userPath: string): string | null {
	const resolvedBase = resolve(baseDir);
	const resolvedPath = resolve(resolvedBase, userPath);
	const rel = relative(resolvedBase, resolvedPath);
	if (rel.startsWith("..") || resolve(rel) === rel) return null;
	return resolvedPath;
}

function safeWorkspacePath(workspaceId: string | null | undefined, userPath: string): string | null {
	const root = workspaceRegistry.resolveWorkspaceDir(workspaceId ?? TEMP_WORKSPACE_ID);
	if (!root) return null;
	return safeJoin(root, userPath.replace(/^\/+/, ""));
}

function workspaceIdFromQuery(url: string): string {
	try {
		const params = new URL(url, "http://localhost").searchParams;
		const id = params.get("workspaceId");
		return id && id.trim() ? id.trim() : TEMP_WORKSPACE_ID;
	} catch {
		return TEMP_WORKSPACE_ID;
	}
}

function workspaceIdFromBody(body: Record<string, unknown>): string {
	const id = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
	return id || TEMP_WORKSPACE_ID;
}

function clamp01(n: number): number {
	if (!Number.isFinite(n)) return 0;
	if (n < 0) return 0;
	if (n > 1) return 1;
	return n;
}

function normalizePreferences(input: Partial<LearnerPreferences>): LearnerPreferences {
	function arr(value: unknown): string[] {
		if (!Array.isArray(value)) return [];
		return value.filter((s): s is string => typeof s === "string" && s.trim().length > 0);
	}
	return {
		explanation_style: arr(input.explanation_style),
		practice_style: arr(input.practice_style),
		feedback_tone: arr(input.feedback_tone),
		avoid: arr(input.avoid),
	};
}

function sessionFileFromId(sessionDir: string, id: string): string | null {
	const fileName = basename(id);
	if (fileName !== id || !fileName.endsWith(".jsonl")) return null;
	return safeJoin(sessionDir, fileName);
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

function sanitizeUploadName(name: string): string {
	const cleaned = name
		.replace(/[/\\?%*:|"<>]/g, "-")
		.replace(/\s+/g, " ")
		.trim();
	return cleaned || "upload";
}

function uploadExtension(fileName: string, mimeType: string): string {
	const ext = extname(fileName);
	if (ext) return ext;
	if (mimeType === "application/pdf") return ".pdf";
	if (mimeType.includes("wordprocessingml")) return ".docx";
	if (mimeType.includes("spreadsheetml")) return ".xlsx";
	if (mimeType.includes("presentationml")) return ".pptx";
	if (mimeType === "text/markdown") return ".md";
	if (mimeType.startsWith("image/")) return `.${mimeType.slice("image/".length).replace("jpeg", "jpg")}`;
	if (mimeType.startsWith("text/")) return ".txt";
	return ".bin";
}

function slugifySkillName(value: string): string {
	const slug = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 64);
	return slug || "uploaded-skill";
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
		throw new Error(result.stderr.trim() || "Unable to inspect zip file");
	}
	for (const rawLine of result.stdout.split("\n")) {
		const entry = rawLine.trim();
		if (!entry) continue;
		if (entry.startsWith("/") || entry.includes("..") || entry.includes("\\")) {
			throw new Error(`Unsafe zip entry path: ${entry}`);
		}
	}
}

/**
 * Build a `Content-Disposition: attachment` header value that survives
 * non-ASCII filenames. Falls back to a sanitized ASCII name plus the RFC 5987
 * `filename*` form so browsers pick the UTF-8 variant when supported.
 */
function contentDispositionAttachment(fileName: string): string {
	const asciiFallback = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
	const encoded = encodeURIComponent(fileName);
	return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * Zip a directory and return the archive as a Buffer.
 *
 * Uses the system `zip` on macOS/Linux and PowerShell `Compress-Archive` on
 * Windows so we avoid pulling in a new dependency. The archive is built in a
 * temp dir and read back into memory (workspace folders are expected to be
 * small enough for an in-memory download).
 */
function zipDirectory(dirPath: string): Buffer {
	const tempRoot = join(tmpdir(), `inno-zip-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const zipPath = join(tempRoot, "archive.zip");
	ensureDir(tempRoot);
	try {
		if (process.platform === "win32") {
			const ps = `Compress-Archive -Path '${dirPath.replace(/'/g, "''")}\\*' ` +
				`-DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`;
			const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", ps], { encoding: "utf-8" });
			if (result.status !== 0) {
				throw new Error((result.stderr || "").trim() || "Unable to create zip archive");
			}
		} else {
			// `-r` recurse, run inside the dir so paths are relative to it.
			const result = spawnSync("/usr/bin/zip", ["-r", "-q", zipPath, "."], { cwd: dirPath, encoding: "utf-8" });
			if (result.status !== 0) {
				throw new Error((result.stderr || "").trim() || "Unable to create zip archive");
			}
		}
		return readFileSync(zipPath);
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
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
				throw new Error(unzipResult.stderr.trim() || "Unable to unzip skill package");
			}
		}

		const skillFile = findSkillFile(extractDir);
		if (!skillFile) {
			throw new Error("Zip package must contain a SKILL.md file");
		}
		const skillRoot = dirname(skillFile);
		const skill = ensureSkillDocument(readText(skillFile), fallbackName);
		const targetDir = join(targetRoot, skill.name);
		rmSync(targetDir, { recursive: true, force: true });
		copyDirectoryContents(skillRoot, targetDir);
		writeText(join(targetDir, "SKILL.md"), skill.content);
		return { name: skill.name, filePath: join(targetDir, "SKILL.md") };
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

function installSkillMarkdown(fileName: string, data: Buffer, targetRoot: string = skillsDir): { name: string; filePath: string } {
	const skill = ensureSkillDocument(data.toString("utf-8"), basename(fileName, extname(fileName)));
	const skillDir = join(targetRoot, skill.name);
	rmSync(skillDir, { recursive: true, force: true });
	ensureDir(skillDir);
	writeText(join(skillDir, "SKILL.md"), skill.content);
	return { name: skill.name, filePath: join(skillDir, "SKILL.md") };
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
			const frontmatter = parseSkillFrontmatter(content);
			const stat = existsSync(filePath) ? statSync(filePath) : statSync(join(skillsDir, name));
			const loadedSkill = loadedByPath.get(resolve(filePath));
			return {
				name,
				description: typeof frontmatter.description === "string" ? frontmatter.description : "",
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
		console.warn(`[inno-server] skills reload failed: ${err instanceof Error ? err.message : String(err)}`);
	});
}


const WIKI_PAGE_DIRS = ["sources", "entities", "concepts", "analysis"] as const;
const WORKSPACE_IGNORES = new Set([".git", "node_modules", "dist", ".DS_Store"]);
/** Per-workspace private skills directory (matches inno-extension WORKSPACE_SKILLS_DIR). */
const WORKSPACE_PRIVATE_SKILLS_DIR = ".skills";
const TEXT_PREVIEW_EXTENSIONS = new Set([
	".txt",
	".md",
	".markdown",
	".json",
	".jsonl",
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".css",
	".html",
	".htm",
	".xml",
	".yaml",
	".yml",
	".csv",
	".log",
	".py",
	".rb",
	".go",
	".rs",
	".java",
	".kt",
	".kts",
	".swift",
	".c",
	".cpp",
	".cc",
	".cxx",
	".h",
	".hpp",
	".cs",
	".php",
	".r",
	".R",
	".lua",
	".pl",
	".pm",
	".sh",
	".bash",
	".zsh",
	".fish",
	".bat",
	".ps1",
	".sql",
	".graphql",
	".gql",
	".toml",
	".ini",
	".cfg",
	".conf",
	".env",
	".gitignore",
	".dockerignore",
	".editorconfig",
	".prettierrc",
	".eslintrc",
	".scss",
	".sass",
	".less",
	".vue",
	".svelte",
	".astro",
	".tf",
	".proto",
	".gradle",
	".cmake",
	".makefile",
	".dockerfile",
]);

interface WorkspaceTreeNode {
	name: string;
	path: string;
	type: "file" | "directory";
	size?: number;
	updatedAt?: string;
	children?: WorkspaceTreeNode[];
}

function workspaceRelativePath(rootDir: string, filePath: string): string {
	return relative(rootDir, filePath) || "";
}

/** Build a tree node for an installed private skill directory under `<root>/.skills`. */
function workspaceSkillNode(root: string, skillName: string): { name: string; path: string; type: string; size: number; updatedAt: string } {
	const dir = join(root, WORKSPACE_PRIVATE_SKILLS_DIR, skillName);
	const stat = statSync(dir);
	return {
		name: skillName,
		path: workspaceRelativePath(root, dir),
		type: "directory",
		size: stat.size,
		updatedAt: stat.mtime.toISOString(),
	};
}

function readWorkspaceTree(rootDir: string, dir: string, depth = 0): WorkspaceTreeNode[] {
	if (depth > 4) return [];
	return readdirSync(dir, { withFileTypes: true })
		.filter((entry) => !WORKSPACE_IGNORES.has(entry.name))
		.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, "zh-CN"))
		.slice(0, 200)
		.map((entry) => {
			const fullPath = join(dir, entry.name);
			const stat = statSync(fullPath);
			const node: WorkspaceTreeNode = {
				name: entry.name,
				path: workspaceRelativePath(rootDir, fullPath),
				type: entry.isDirectory() ? "directory" : "file",
				size: stat.size,
				updatedAt: stat.mtime.toISOString(),
			};
			if (entry.isDirectory()) {
				node.children = readWorkspaceTree(rootDir, fullPath, depth + 1);
			}
			return node;
		});
}

function contentTypeForWorkspaceFile(filePath: string): string {
	const ext = extname(filePath).toLowerCase();
	if (ext === ".pdf") return "application/pdf";
	if (ext === ".html" || ext === ".htm") return "text/html; charset=utf-8";
	if (ext === ".md" || ext === ".markdown") return "text/markdown; charset=utf-8";
	if (ext === ".json") return "application/json; charset=utf-8";
	if (ext === ".png") return "image/png";
	if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
	if (ext === ".gif") return "image/gif";
	if (ext === ".svg") return "image/svg+xml";
	if (ext === ".webp") return "image/webp";
	if (ext === ".docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
	if (ext === ".xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
	if (ext === ".pptx") return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
	return TEXT_PREVIEW_EXTENSIONS.has(ext) ? "text/plain; charset=utf-8" : "application/octet-stream";
}

const TEXT_NOEXT_NAMES = new Set(["makefile", "dockerfile", "gemfile", "rakefile", "procfile", "vagrantfile"]);

/** Office document extensions previewable via LiteParse text extraction. */
const OFFICE_PREVIEW_EXTENSIONS = new Set([".docx", ".xlsx", ".pptx"]);

function workspaceFileKind(filePath: string): "markdown" | "html" | "pdf" | "image" | "office" | "text" | "binary" {
	const ext = extname(filePath).toLowerCase();
	if (ext === ".md" || ext === ".markdown") return "markdown";
	if (ext === ".html" || ext === ".htm") return "html";
	if (ext === ".pdf") return "pdf";
	if ([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"].includes(ext)) return "image";
	if (OFFICE_PREVIEW_EXTENSIONS.has(ext)) return "office";
	if (TEXT_PREVIEW_EXTENSIONS.has(ext)) return "text";
	if (!ext && TEXT_NOEXT_NAMES.has(basename(filePath).toLowerCase())) return "text";
	return "binary";
}

function listWikiPagePaths(): string[] {
	const wikiRoot = join(l2DataDir, "wiki");
	const paths: string[] = [];
	for (const dirName of WIKI_PAGE_DIRS) {
		const dir = join(wikiRoot, dirName);
		if (!existsSync(dir)) continue;
		for (const file of readdirSync(dir)) {
			if (file.endsWith(".md")) {
				paths.push(join("wiki", dirName, file));
			}
		}
	}
	return paths.sort((a, b) => a.localeCompare(b, "zh-CN"));
}

function manifestSourceIdByWikiPath(): Map<string, string> {
	const map = new Map<string, string>();
	for (const entry of readManifest(l2DataDir)) {
		for (const wikiPath of entry.wikiPages) {
			map.set(wikiPath, entry.id);
		}
	}
	return map;
}

interface SessionMessageSummary {
	role: "user" | "assistant";
	content: string;
	timestamp: number;
	thinking?: string;
	tools?: Array<{
		toolCallId: string;
		toolName: string;
		args: unknown;
		result?: unknown;
		isError?: boolean;
	}>;
	channel?: SessionChannel;
	images?: Array<{ previewUrl: string; mimeType: string }>;
}

type SessionChannel = "cli" | "web" | "feishu" | "qq" | "wechat" | "scheduler" | "unknown";

interface SessionSummary {
	id: string;
	name: string;
	createdAt: string;
	updatedAt: string;
	messageCount: number;
	preview: string;
	channels: SessionChannel[];
	/** Immutable birthplace of the session (web/cli/feishu/wechat/scheduler). */
	origin?: SessionChannel;
}

type SessionTopicMetadata = Record<string, { topic: string; updatedAt: string; generated?: boolean }>;

function sessionTopicMetadataPath(): string {
	return join(dataDir, "sessions", "meta.json");
}

function readSessionTopicMetadata(): SessionTopicMetadata {
	return readJson<SessionTopicMetadata>(sessionTopicMetadataPath(), {});
}

function writeSessionTopic(id: string, topic: string, generated = false): void {
	const metadata = readSessionTopicMetadata();
	metadata[id] = { topic, generated, updatedAt: new Date().toISOString() };
	writeJson(sessionTopicMetadataPath(), metadata);
}

function parseSessionFile(filePath: string): { summary: SessionSummary; messages: SessionMessageSummary[] } | null {
	try {
		const raw = readFileSync(filePath, "utf-8");
		const lines = raw.split("\n").filter((line) => line.trim().length > 0);
		const messages: SessionMessageSummary[] = [];
		const channels = new Set<SessionChannel>();
		let createdAt = "";
		let updatedAt = "";

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

		for (const line of lines) {
			const entry = JSON.parse(line) as Record<string, unknown>;
			const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : "";
			if (!createdAt && timestamp) createdAt = timestamp;
			if (timestamp) updatedAt = timestamp;
			const entryText = line.toLowerCase();
			// Detect channel from entry content
			let entryChannel: SessionChannel | undefined;
			if (entryText.includes('"channel":"feishu"') || entryText.includes("飞书") || entryText.includes("附件已下载到")) {
				channels.add("feishu");
				entryChannel = "feishu";
			}
			if (entryText.includes('"channel":"wechat"') || entryText.includes('"channel":"wecom"')) {
				channels.add("wechat");
				entryChannel = entryChannel ?? "wechat";
			}
			if (entryText.includes('"channel":"qq"')) {
				channels.add("qq");
				entryChannel = entryChannel ?? "qq";
			}
			if (entryText.includes('"source":"web"') || entryText.includes('"channel":"web"')) {
				channels.add("web");
				entryChannel = entryChannel ?? "web";
			}
			if (entryText.includes('"tasktype"') || entryText.includes("scheduled")) {
				channels.add("scheduler");
				entryChannel = entryChannel ?? "scheduler";
			}
			// Check for scheduler-authored assistant messages
			if (entryText.includes('"api":"inno-background"') || entryText.includes('"model":"scheduler"')) {
				channels.add("scheduler");
				entryChannel = entryChannel ?? "scheduler";
			}

			if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
			const message = entry.message as Record<string, unknown>;
			const role = message.role;
			const ts = timestamp ? Date.parse(timestamp) : Date.now();

			if (role === "user") {
				finalizeAssistant();
				const content = textFromContent(message.content);
				if (!content) continue;
				const images = imagesFromContent(message.content);
				const msg: SessionMessageSummary = { role: "user", content, timestamp: ts, channel: entryChannel };
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
							pending.tools.push({ toolCallId, toolName, args });
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
				const result = textFromContent(message.content) || message.content;
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

		const firstUser = filtered.find((message) => message.role === "user");
		const preview = firstUser?.content.trim() ?? "";
		const name = preview ? (preview.length > 48 ? `${preview.slice(0, 45)}...` : preview) : basename(filePath);
		const stat = statSync(filePath);
		const fallbackTime = stat.mtime.toISOString();
		return {
			summary: {
				id: basename(filePath),
				name,
				createdAt: createdAt || fallbackTime,
				updatedAt: updatedAt || fallbackTime,
				messageCount: filtered.length,
				preview,
				channels: channels.size > 0 ? Array.from(channels) : [],
			},
			messages: filtered,
		};
	} catch {
		return null;
	}
}

type SessionChannelMetadata = Record<string, { channels: SessionChannel[]; origin?: SessionChannel; updatedAt: string }>;

function sessionChannelMetadataPath(): string {
	return join(dataDir, "sessions", "channels.json");
}

function sessionArchiveMetadataPath(): string {
	return join(dataDir, "sessions", "archives.json");
}

function readSessionChannelMetadata(): SessionChannelMetadata {
	return readJson<SessionChannelMetadata>(sessionChannelMetadataPath(), {});
}

function mergeChannels(a: SessionChannel[], b: SessionChannel[]): SessionChannel[] {
	return Array.from(new Set([...a, ...b])).sort();
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

/** Derive a session's origin, with backfill for legacy sessions lacking one. */
function deriveOrigin(meta: { channels: SessionChannel[]; origin?: SessionChannel } | undefined): SessionChannel {
	if (meta?.origin) return meta.origin;
	// Legacy backfill: prefer the first non-web channel the session touched
	// (channel-native sessions), otherwise treat it as web.
	const nonWeb = (meta?.channels ?? []).find((c) => c !== "web");
	return nonWeb ?? "web";
}

function withRecordedChannels(summary: SessionSummary, metadata: SessionChannelMetadata): SessionSummary {
	const meta = metadata[summary.id];
	const explicit = meta?.channels ?? [];
	if (explicit.length > 0) {
		// channels.json is the source of truth — merge with content-detected channels
		// but exclude the empty-array fallback from parseSessionFile.
		const contentChannels = summary.channels; // may be [] if nothing detected from JSONL
		return { ...summary, channels: mergeChannels(contentChannels, explicit), origin: deriveOrigin(meta) };
	}
	// No explicit metadata — use content-detected channels, or fall back to "cli"
	// for legacy sessions that predate channel tracking.
	const channels = summary.channels.length > 0 ? summary.channels : ["cli" as SessionChannel];
	return {
		...summary,
		channels,
		origin: deriveOrigin({ channels }),
	};
}

function withRecordedTopic(summary: SessionSummary, metadata: SessionTopicMetadata): SessionSummary {
	const topic = metadata[summary.id]?.topic?.trim();
	return topic ? { ...summary, name: topic } : summary;
}

/**
 * CLI-origin sessions are created by the terminal agent, which never touches
 * the workspace registry, so they stay unbound and fall back to tmp. Lazily
 * bind them to the dedicated CLI workspace so they group under "CLI 区".
 */
function bindCliSessionWorkspace(summary: SessionSummary): SessionSummary {
	if (summary.origin !== "cli") return summary;
	try {
		if (!workspaceRegistry.isSessionBound(summary.id)) {
			const ws = workspaceRegistry.ensureChannelWorkspace("cli");
			workspaceRegistry.bindSession(summary.id, ws.id);
		}
	} catch {
		// best-effort — never fail the listing on a binding hiccup
	}
	return summary;
}

function cleanGeneratedTopic(raw: string): string {
	return raw
		.replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "")
		.replace(/^标题[:：]\s*/i, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 32);
}

function fallbackTopicFromMessages(messages: SessionMessageSummary[], summary: SessionSummary): string {
	const source = messages.find((message) => message.role === "user")?.content || summary.preview || summary.name;
	const cleaned = source.replace(/\s+/g, " ").trim();
	return cleaned ? (cleaned.length > 28 ? `${cleaned.slice(0, 28)}...` : cleaned) : "New conversation";
}

async function generateSessionTopic(summary: SessionSummary, messages: SessionMessageSummary[]): Promise<string> {
	const excerpt = messages
		.slice(0, 4)
		.map((message) => `${message.role === "user" ? "用户" : "助手"}: ${message.content.replace(/\s+/g, " ").trim()}`)
		.join("\n")
		.slice(0, 800);

	if (!excerpt) return fallbackTopicFromMessages(messages, summary);

	const prompt = `请根据下面的对话内容生成一个简短中文话题标题。
要求：
- 只输出标题本身，不要解释
- 8 到 16 个中文字符左右
- 不要使用引号、句号或冒号

对话：
${excerpt}`;

	try {
		const generated = cleanGeneratedTopic(await completePromptOnce(prompt, 64));
		return generated || fallbackTopicFromMessages(messages, summary);
	} catch {
		return fallbackTopicFromMessages(messages, summary);
	}
}

/**
 * Auto-generate a topic for a session if it doesn't already have one.
 * Runs asynchronously — fire and forget.
 */
const _pendingAutoTopics = new Set<string>();

function maybeAutoGenerateTopic(sessionId: string): void {
	if (!sessionId || _pendingAutoTopics.has(sessionId)) return;
	const topicMeta = readSessionTopicMetadata();
	if (topicMeta[sessionId]) return; // already has a topic

	const sessionPath = sessionFileFromId(join(dataDir, "sessions"), sessionId);
	if (!sessionPath || !existsSync(sessionPath)) return;

	_pendingAutoTopics.add(sessionId);
	void (async () => {
		try {
			const parsed = parseSessionFile(sessionPath);
			if (!parsed || parsed.messages.length < 2) return;
			const topic = await generateSessionTopic(parsed.summary, parsed.messages);
			writeSessionTopic(sessionId, topic, true);
			console.log(`[auto-topic] ${sessionId} → ${topic}`);
		} catch (err) {
			console.warn(`[auto-topic] failed for ${sessionId}:`, err instanceof Error ? err.message : String(err));
		} finally {
			_pendingAutoTopics.delete(sessionId);
		}
	})();
}

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
	const url = req.url ?? "/";
	const method = req.method ?? "GET";

	try {
		// --- Health check ---
		if (method === "GET" && url === "/health") {
			json(res, 200, { status: "ok" });
			return;
		}

		// --- Jobs CRUD ---
		if (method === "GET" && url === "/api/jobs") {
			json(res, 200, jobStore.list());
			return;
		}

		if (method === "GET" && url === "/api/jobs/status") {
			json(res, 200, jobStore.getStatus());
			return;
		}

		if (method === "GET" && url === "/api/jobs/runs") {
			json(res, 200, jobStore.listRuns());
			return;
		}

		if (method === "GET" && url === "/api/channels") {
			json(res, 200, channelRegistry.all().map((channel) => {
				const isBridge = channel instanceof BridgeChannel;
				return {
					name: channel.name,
					mode: isBridge ? "bridge" : "native",
					enabled: true,
					hasDefaultTarget: Boolean(channelRegistry.getDefaultTarget(channel.name)),
				};
			}));
			return;
		}

		const defaultTargetMatch = matchRoute("POST", method, url, "/api/channels/:name/default-target");
		if (defaultTargetMatch) {
			const body = await readBody(req) as Record<string, unknown>;
			const channel = channelRegistry.get(defaultTargetMatch.name);
			const chatId = typeof body.chatId === "string" ? body.chatId.trim() : "";
			if (!channel) {
				json(res, 404, { error: "Channel not found" });
				return;
			}
			if (!chatId) {
				json(res, 400, { error: "Missing chatId" });
				return;
			}
			channelRegistry.setDefaultTarget({
				channel: defaultTargetMatch.name as import("./channels/types.js").ChannelName,
				chatId,
			});
			json(res, 200, { channel: defaultTargetMatch.name, chatId });
			return;
		}

		const channelTestMatch = matchRoute("POST", method, url, "/api/channels/:name/test");
		if (channelTestMatch) {
			const body = await readBody(req) as Record<string, unknown>;
			const channel = channelRegistry.get(channelTestMatch.name);
			const target = channelRegistry.getDefaultTarget(channelTestMatch.name);
			const text = typeof body.text === "string" && body.text.trim()
				? body.text.trim()
				: "Inno Agent 飞书主动推送测试。";
			if (!channel) {
				json(res, 404, { error: "Channel not found" });
				return;
			}
			if (!target) {
				json(res, 400, { error: "No default target configured" });
				return;
			}
			await channel.push(target, text);
			json(res, 200, { channel: channelTestMatch.name, chatId: target.chatId, pushed: true });
			return;
		}

		// Bridge message endpoint
		if (method === "POST" && url === "/api/bridge/messages") {
			if (!bridgeToken || !dispatcher) {
				json(res, 404, { error: "Bridge not configured" });
				return;
			}
			const body = await readBody(req);
			const authHeader = req.headers.authorization;
			const result = handleBridgeMessage(
				{ token: bridgeToken, channelRegistry, dispatcher },
				authHeader,
				body,
			);
			json(res, result.status, result.body);
			return;
		}

		// Channel health endpoint
		const channelHealthMatch = matchRoute("GET", method, url, "/api/channels/:name/health");
		if (channelHealthMatch) {
			const channel = channelRegistry.get(channelHealthMatch.name);
			if (!channel) {
				json(res, 404, { error: "Channel not found" });
				return;
			}
			if (channel instanceof BridgeChannel) {
				const health = await channel.checkHealth();
				json(res, 200, health);
			} else {
				json(res, 200, { channel: channel.name, mode: "native", healthy: true, checkedAt: new Date().toISOString() });
			}
			return;
		}

		// WeChat iLink QR login
		if (method === "POST" && url === "/api/channels/wechat/qr-login") {
			// Lazily create the WeChat channel if not yet instantiated
			if (!wechatChannel) {
				wechatChannel = new WeChatChannel(dataDir, config.channels?.wechat);
				channelRegistry.register(wechatChannel);
			}
			try {
				const qr = await wechatChannel.getClient().getQrCode();
				const raw = qr.qrcode_img_content ?? "";
				console.log(`[wechat] QR response: qrcode=${qr.qrcode}, img_content length=${raw.length}, prefix=${raw.slice(0, 40)}`);
				let qrUrl = raw;
				if (qrUrl && !qrUrl.startsWith("data:") && !qrUrl.startsWith("http")) {
					qrUrl = `data:image/png;base64,${qrUrl}`;
				}
				json(res, 200, { qrId: qr.qrcode, qrUrl });
			} catch (err) {
				json(res, 500, { error: err instanceof Error ? err.message : "Failed to get QR code" });
			}
			return;
		}

		if (method === "GET" && url.startsWith("/api/channels/wechat/qr-status")) {
			const qrId = new URL(url, "http://localhost").searchParams.get("qrId");
			if (!qrId) {
				json(res, 400, { error: "Missing qrId" });
				return;
			}
			if (!wechatChannel) {
				json(res, 400, { error: "WeChat channel not initialized" });
				return;
			}
			try {
				const status = await wechatChannel.getClient().getQrCodeStatus(qrId);
				if (status.status === "confirmed" && status.bot_token) {
					wechatChannel.getClient().confirmLogin(status);
					// Start polling if not already running
					if (!wechatChannel.isConnected && dispatcher) {
						wechatChannel.onMessage((msg) => dispatcher!.handle(wechatChannel!, msg));
						wechatChannel.start();
					}
				}
				json(res, 200, { status: status.status, botId: status.ilink_bot_id });
			} catch (err) {
				json(res, 500, { error: err instanceof Error ? err.message : "Failed to check QR status" });
			}
			return;
		}

		if (method === "GET" && url === "/api/channels/wechat/status") {
			if (!wechatChannel) {
				json(res, 200, { configured: false, connected: false });
				return;
			}
			json(res, 200, {
				configured: true,
				connected: wechatChannel.isConnected,
				botId: wechatChannel.botId || undefined,
				loggedIn: wechatChannel.getClient().isLoggedIn,
			});
			return;
		}

		// Channel runs log
		if (method === "GET" && url === "/api/channels/runs") {
			if (dispatcher) {
				json(res, 200, dispatcher.getRunLog().list());
			} else {
				json(res, 200, []);
			}
			return;
		}

		if (method === "POST" && url === "/api/jobs") {
			const body = await readBody(req) as Record<string, unknown> & Parameters<JobStore["create"]>[0];
			if (typeof body.cron !== "string") {
				json(res, 400, { error: "cron is required" });
				return;
			}
			const cronCheck = validateCron(body.cron, typeof body.timezone === "string" ? body.timezone : undefined);
			if (!cronCheck.ok) {
				json(res, 400, { error: `Invalid cron: ${cronCheck.error}` });
				return;
			}
			if (body.channel && !channelRegistry.get(body.channel)) {
				json(res, 400, { error: `Channel not registered: ${body.channel}. Enable it in settings first.` });
				return;
			}
			const job = jobStore.create(body);
			json(res, 201, job);
			return;
		}

		const runsMatch = matchRoute("GET", method, url, "/api/jobs/:id/runs");
		if (runsMatch) {
			json(res, 200, jobStore.listRuns(runsMatch.id));
			return;
		}

		const runMatch = matchRoute("POST", method, url, "/api/jobs/:id/run");
		if (runMatch) {
			const job = jobStore.get(runMatch.id);
			if (!job) {
				json(res, 404, { error: "Job not found" });
				return;
			}
			const result = await executeJob(job, jobStore, channelRegistry, "api");
			json(res, 200, result);
			return;
		}

		const patchMatch = matchRoute("PATCH", method, url, "/api/jobs/:id");
		if (patchMatch) {
			const body = await readBody(req) as Partial<import("./scheduler/types.js").ScheduledJob>;
			if (typeof body.cron === "string") {
				const cronCheck = validateCron(body.cron, body.timezone);
				if (!cronCheck.ok) {
					json(res, 400, { error: `Invalid cron: ${cronCheck.error}` });
					return;
				}
			}
			if (body.channel && !channelRegistry.get(body.channel)) {
				json(res, 400, { error: `Channel not registered: ${body.channel}. Enable it in settings first.` });
				return;
			}
			const updated = jobStore.update(patchMatch.id, body);
			if (!updated) {
				json(res, 404, { error: "Job not found" });
				return;
			}
			json(res, 200, updated);
			return;
		}

		const deleteMatch = matchRoute("DELETE", method, url, "/api/jobs/:id");
		if (deleteMatch) {
			const deleted = jobStore.delete(deleteMatch.id);
			if (!deleted) {
				json(res, 404, { error: "Job not found" });
				return;
			}
			json(res, 204, null);
			return;
		}

		// --- Skills API ---
		if (method === "GET" && url === "/api/skills") {
			// Do not call reloadResources() here — it is queued behind the agent
			// loop, so it stalls while an LLM turn is streaming. Listing from
			// disk is enough for displaying the panel.
			json(res, 200, listProjectSkills());
			return;
		}

		if (method === "POST" && url === "/api/skills/upload") {
			const body = (await readBody(req)) as Record<string, unknown>;
			const fileName = typeof body.fileName === "string" ? body.fileName : "";
			const dataBase64 = typeof body.dataBase64 === "string" ? body.dataBase64 : "";
			if (!fileName || !dataBase64) {
				json(res, 400, { error: "Missing fileName or dataBase64" });
				return;
			}
			const data = Buffer.from(dataBase64, "base64");
			const ext = extname(fileName).toLowerCase();
			const skill = ext === ".zip"
				? installSkillZip(fileName, data)
				: installSkillMarkdown(fileName, data);
			setSkillEnabled(skill.name, true);
			const installed = listProjectSkills().find((entry) => (entry as { name: string }).name === skill.name);
			json(res, 201, installed ?? { name: skill.name });
			scheduleSkillsReload();
			return;
		}

		if (method === "POST" && url === "/api/skills/reload") {
			scheduleSkillsReload();
			json(res, 200, { reloaded: true, skills: listProjectSkills() });
			return;
		}

		const skillToggleMatch = matchRoute("PATCH", method, url, "/api/skills/:name");
		if (skillToggleMatch) {
			const name = slugifySkillName(decodeURIComponent(skillToggleMatch.name));
			const skillFile = join(skillsDir, name, "SKILL.md");
			if (!existsSync(skillFile)) {
				json(res, 404, { error: "Skill not found" });
				return;
			}
			const body = (await readBody(req)) as Record<string, unknown>;
			if (typeof body.enabled === "boolean") {
				setSkillEnabled(name, body.enabled);
			}
			scheduleSkillsReload();
			json(res, 200, listProjectSkills().find((entry) => (entry as { name: string }).name === name));
			return;
		}

		const skillDeleteMatch = matchRoute("DELETE", method, url, "/api/skills/:name");
		if (skillDeleteMatch) {
			const name = slugifySkillName(decodeURIComponent(skillDeleteMatch.name));
			const skillDir = join(skillsDir, name);
			if (!existsSync(skillDir)) {
				json(res, 404, { error: "Skill not found" });
				return;
			}
			rmSync(skillDir, { recursive: true, force: true });
			setSkillEnabled(name, true);
			scheduleSkillsReload();
			json(res, 204, null);
			return;
		}

		// GET /api/skills/:name/content — read SKILL.md content
		const skillContentGetMatch = matchRoute("GET", method, url, "/api/skills/:name/content");
		if (skillContentGetMatch) {
			const name = slugifySkillName(decodeURIComponent(skillContentGetMatch.name));
			const filePath = join(skillsDir, name, "SKILL.md");
			if (!existsSync(filePath)) { json(res, 404, { error: "Skill not found" }); return; }
			json(res, 200, { name, content: readFileSync(filePath, "utf-8") });
			return;
		}

		// PUT /api/skills/:name/content — save SKILL.md content
		const skillContentPutMatch = matchRoute("PUT", method, url, "/api/skills/:name/content");
		if (skillContentPutMatch) {
			const name = slugifySkillName(decodeURIComponent(skillContentPutMatch.name));
			const filePath = join(skillsDir, name, "SKILL.md");
			if (!existsSync(filePath)) { json(res, 404, { error: "Skill not found" }); return; }
			const body = (await readBody(req)) as Record<string, unknown>;
			const content = typeof body.content === "string" ? body.content : "";
			writeFileSync(filePath, content, "utf-8");
			await reloadResources();
			json(res, 200, { name, saved: true });
			return;
		}

		// GET /api/skills/:name/tree — file tree of a skill directory
		const skillTreeMatch = matchRoute("GET", method, url, "/api/skills/:name/tree");
		if (skillTreeMatch) {
			const name = slugifySkillName(decodeURIComponent(skillTreeMatch.name));
			const skillDir = join(skillsDir, name);
			if (!existsSync(skillDir) || !statSync(skillDir).isDirectory()) {
				json(res, 404, { error: "Skill not found" });
				return;
			}
			function readSkillTree(dir: string, depth = 0): WorkspaceTreeNode[] {
				if (depth > 4) return [];
				return readdirSync(dir, { withFileTypes: true })
					.filter((e) => !e.name.startsWith(".") && e.name !== "__MACOSX" && e.name !== "node_modules")
					.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, "zh-CN"))
					.slice(0, 200)
					.map((entry) => {
						const fullPath = join(dir, entry.name);
						const st = statSync(fullPath);
						const node: WorkspaceTreeNode = {
							name: entry.name,
							path: relative(skillDir, fullPath),
							type: entry.isDirectory() ? "directory" : "file",
							size: st.size,
							updatedAt: st.mtime.toISOString(),
						};
						if (entry.isDirectory()) node.children = readSkillTree(fullPath, depth + 1);
						return node;
					});
			}
			const st = statSync(skillDir);
			json(res, 200, {
				name,
				path: "",
				type: "directory",
				size: st.size,
				updatedAt: st.mtime.toISOString(),
				children: readSkillTree(skillDir),
			});
			return;
		}

		// GET /api/skills/:name/file?path=... — read a file inside a skill
		const skillFileGetMatch = matchRoute("GET", method, url.split("?")[0], "/api/skills/:name/file");
		if (skillFileGetMatch && method === "GET") {
			const name = slugifySkillName(decodeURIComponent(skillFileGetMatch.name));
			const skillDir = join(skillsDir, name);
			if (!existsSync(skillDir)) { json(res, 404, { error: "Skill not found" }); return; }
			const params = new URL(url, "http://localhost").searchParams;
			const relPath = params.get("path") ?? "";
			const fullPath = safeJoin(skillDir, relPath.replace(/^\/+/, ""));
			if (!fullPath || !existsSync(fullPath) || !statSync(fullPath).isFile()) {
				json(res, 404, { error: "File not found" });
				return;
			}
			const st = statSync(fullPath);
			const kind = workspaceFileKind(fullPath);
			if (kind === "binary" || kind === "pdf" || kind === "image") {
				json(res, 200, {
					path: relative(skillDir, fullPath),
					name: basename(fullPath),
					kind,
					mimeType: contentTypeForWorkspaceFile(fullPath),
					size: st.size,
					updatedAt: st.mtime.toISOString(),
					url: `/api/skills/${encodeURIComponent(name)}/raw?path=${encodeURIComponent(relative(skillDir, fullPath))}`,
				});
				return;
			}
			if (st.size > 1024 * 1024) { json(res, 413, { error: "File too large" }); return; }
			json(res, 200, {
				path: relative(skillDir, fullPath),
				name: basename(fullPath),
				kind,
				mimeType: contentTypeForWorkspaceFile(fullPath),
				size: st.size,
				updatedAt: st.mtime.toISOString(),
				content: readFileSync(fullPath, "utf-8"),
			});
			return;
		}

		// PUT /api/skills/:name/file — save a file inside a skill
		const skillFilePutMatch = matchRoute("PUT", method, url, "/api/skills/:name/file");
		if (skillFilePutMatch) {
			const name = slugifySkillName(decodeURIComponent(skillFilePutMatch.name));
			const skillDir = join(skillsDir, name);
			if (!existsSync(skillDir)) { json(res, 404, { error: "Skill not found" }); return; }
			const body = (await readBody(req)) as Record<string, unknown>;
			const relPath = typeof body.path === "string" ? body.path.trim() : "";
			const content = typeof body.content === "string" ? body.content : "";
			if (!relPath) { json(res, 400, { error: "Missing path" }); return; }
			const fullPath = safeJoin(skillDir, relPath.replace(/^\/+/, ""));
			if (!fullPath || !existsSync(fullPath) || !statSync(fullPath).isFile()) {
				json(res, 404, { error: "File not found" });
				return;
			}
			writeFileSync(fullPath, content, "utf-8");
			if (basename(fullPath) === "SKILL.md") await reloadResources();
			const st = statSync(fullPath);
			json(res, 200, { path: relPath, saved: true, size: st.size, updatedAt: st.mtime.toISOString() });
			return;
		}

		// GET /api/skills/:name/raw?path=... — serve raw file bytes
		const skillRawMatch = matchRoute("GET", method, url.split("?")[0], "/api/skills/:name/raw");
		if (skillRawMatch) {
			const name = slugifySkillName(decodeURIComponent(skillRawMatch.name));
			const skillDir = join(skillsDir, name);
			if (!existsSync(skillDir)) { json(res, 404, { error: "Skill not found" }); return; }
			const params = new URL(url, "http://localhost").searchParams;
			const relPath = params.get("path") ?? "";
			const fullPath = safeJoin(skillDir, relPath.replace(/^\/+/, ""));
			if (!fullPath || !existsSync(fullPath) || !statSync(fullPath).isFile()) {
				json(res, 404, { error: "File not found" });
				return;
			}
			const ct = contentTypeForWorkspaceFile(fullPath);
			res.writeHead(200, { "Content-Type": ct, "Cache-Control": "no-cache" });
			res.end(readFileSync(fullPath));
			return;
		}

		// --- Sessions API ---
		if (method === "GET" && url === "/api/sessions") {
			const sessionDir = join(dataDir, "sessions");
			const channelMetadata = readSessionChannelMetadata();
			const topicMetadata = readSessionTopicMetadata();
			const archiveMetadata = readJson<Record<string, boolean>>(sessionArchiveMetadataPath(), {});
			const sessions = existsSync(sessionDir)
				? readdirSync(sessionDir)
						.filter((file) => file.endsWith(".jsonl"))
						.map((file) => parseSessionFile(join(sessionDir, file))?.summary)
						.filter((summary): summary is SessionSummary => Boolean(summary))
						.map((summary) => withRecordedChannels(summary, channelMetadata))
						.map((summary) => bindCliSessionWorkspace(summary))
						.map((summary) => withRecordedTopic(summary, topicMetadata))
						.map((summary) => ({ ...summary, archived: archiveMetadata[summary.id] === true }))
						.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
				: [];
			json(res, 200, sessions);
			return;
		}

		const sessionMatch = matchRoute("GET", method, url, "/api/sessions/:id");
		if (sessionMatch) {
			const sessionPath = sessionFileFromId(join(dataDir, "sessions"), decodeURIComponent(sessionMatch.id));
			if (!sessionPath || !existsSync(sessionPath)) {
				json(res, 404, { error: "Session not found" });
				return;
			}
			const parsed = parseSessionFile(sessionPath);
			if (!parsed) {
				json(res, 422, { error: "Unable to parse session" });
				return;
			}
			const channelMetadata = readSessionChannelMetadata();
			const topicMetadata = readSessionTopicMetadata();
			const summary = withRecordedTopic(
				withRecordedChannels(parsed.summary, channelMetadata),
				topicMetadata,
			);
			json(res, 200, { ...summary, messages: parsed.messages });
			return;
		}

		const updateSessionMatch = matchRoute("PATCH", method, url, "/api/sessions/:id");
		if (updateSessionMatch) {
			const id = decodeURIComponent(updateSessionMatch.id);
			const sessionPath = sessionFileFromId(join(dataDir, "sessions"), id);
			if (!sessionPath || !existsSync(sessionPath)) {
				json(res, 404, { error: "Session not found" });
				return;
			}
			const body = await readBody(req) as Record<string, unknown>;
			const topic = typeof body.name === "string" ? body.name.trim() : "";
			if (!topic) {
				json(res, 400, { error: "Missing session topic" });
				return;
			}
			writeSessionTopic(basename(sessionPath), topic.slice(0, 120), Boolean(body.generated));
			const parsed = parseSessionFile(sessionPath);
			if (!parsed) {
				json(res, 422, { error: "Unable to parse session" });
				return;
			}
			const summary = withRecordedTopic(
				withRecordedChannels(parsed.summary, readSessionChannelMetadata()),
				readSessionTopicMetadata(),
			);
			json(res, 200, summary);
			return;
		}

		const generateSessionTopicMatch = matchRoute("POST", method, url, "/api/sessions/:id/generate-topic");
		if (generateSessionTopicMatch) {
			const id = decodeURIComponent(generateSessionTopicMatch.id);
			const sessionPath = sessionFileFromId(join(dataDir, "sessions"), id);
			if (!sessionPath || !existsSync(sessionPath)) {
				json(res, 404, { error: "Session not found" });
				return;
			}
			const parsed = parseSessionFile(sessionPath);
			if (!parsed) {
				json(res, 422, { error: "Unable to parse session" });
				return;
			}
			const topic = await generateSessionTopic(parsed.summary, parsed.messages);
			writeSessionTopic(basename(sessionPath), topic, true);
			const summary = withRecordedTopic(
				withRecordedChannels(parsed.summary, readSessionChannelMetadata()),
				readSessionTopicMetadata(),
			);
			json(res, 200, summary);
			return;
		}

		const activateSessionMatch = matchRoute("POST", method, url, "/api/sessions/:id/activate");
		if (activateSessionMatch) {
			const sessionPath = sessionFileFromId(join(dataDir, "sessions"), decodeURIComponent(activateSessionMatch.id));
			if (!sessionPath || !existsSync(sessionPath)) {
				json(res, 404, { error: "Session not found" });
				return;
			}
			await switchSessionFile(sessionPath);
			json(res, 200, { id: basename(sessionPath), active: getCurrentSessionId() === basename(sessionPath) });
			return;
		}

		if (method === "POST" && url === "/api/sessions") {
			const body = await readBody(req).catch(() => ({})) as Record<string, unknown>;
			const id = await createNewSession();

			// Determine target workspace. The UI chooser always sends an explicit
			// choice (new/existing); temp is only a safety fallback.
			let workspaceId: string = TEMP_WORKSPACE_ID;
			const explicitWorkspaceId = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
			const newWorkspaceSpec = body.newWorkspace && typeof body.newWorkspace === "object"
				? body.newWorkspace as { name?: unknown; isTemp?: unknown }
				: null;
			try {
				if (newWorkspaceSpec) {
					const created = workspaceRegistry.createWorkspace({
						name: typeof newWorkspaceSpec.name === "string" ? newWorkspaceSpec.name : undefined,
						isTemp: Boolean(newWorkspaceSpec.isTemp),
					});
					workspaceId = created.id;
				} else if (explicitWorkspaceId && workspaceRegistry.getWorkspace(explicitWorkspaceId)) {
					workspaceId = explicitWorkspaceId;
				}
				workspaceRegistry.bindSession(id, workspaceId);
				// Apply the new workspace cwd to the active runtime so the agent's
				// tools (read/write/bash) operate inside the bound directory.
				const sessionPath = sessionFileFromId(join(dataDir, "sessions"), id);
				if (sessionPath) {
					await applyWorkspaceCwd(sessionPath);
				}
			} catch (err) {
				console.warn(`[sessions] failed to bind workspace for ${id}:`, err instanceof Error ? err.message : err);
			}

			json(res, 201, { id, active: true, workspaceId });
			return;
		}

		const deleteSessionMatch = matchRoute("DELETE", method, url, "/api/sessions/:id");
		if (deleteSessionMatch) {
			const id = decodeURIComponent(deleteSessionMatch.id);
			const sessionPath = sessionFileFromId(join(dataDir, "sessions"), id);
			if (!sessionPath || !existsSync(sessionPath)) {
				json(res, 404, { error: "Session not found" });
				return;
			}
			const sessionId = basename(sessionPath);
			// If deleting the currently active session, swap to a fresh one
			// first so the agent runtime doesn't keep writing to a deleted file.
			let newActiveId: string | null = null;
			if (getCurrentSessionId() === sessionId) {
				newActiveId = await createNewSession();
			}

			// If this session is the sole owner of a temp workspace, remove the
			// workspace folder + registry entry as well.
			const boundWorkspaceId = workspaceRegistry.getSessionWorkspaceId(sessionId);
			const shouldDropTempWorkspace = workspaceRegistry.isOnlyTempSessionOwner(sessionId, boundWorkspaceId);

			rmSync(sessionPath, { force: true });
			// Clean sidecar metadata.
			try {
				const topicMeta = readSessionTopicMetadata();
				if (topicMeta[sessionId]) {
					delete topicMeta[sessionId];
					writeJson(sessionTopicMetadataPath(), topicMeta);
				}
				const channelMeta = readSessionChannelMetadata();
				if (channelMeta[sessionId]) {
					delete channelMeta[sessionId];
					writeJson(sessionChannelMetadataPath(), channelMeta);
				}
				const archiveMeta = readJson<Record<string, boolean>>(sessionArchiveMetadataPath(), {});
				if (archiveMeta[sessionId]) {
					delete archiveMeta[sessionId];
					writeJson(sessionArchiveMetadataPath(), archiveMeta);
				}
				workspaceRegistry.unbindSession(sessionId);
				if (shouldDropTempWorkspace) {
					workspaceRegistry.deleteWorkspace(boundWorkspaceId, { removeFiles: true });
				}
			} catch {
				// best-effort cleanup
			}
			json(res, 200, { id: sessionId, deleted: true, newActiveId });
			return;
		}

		// --- Session Archive ---
		const archiveMatch = matchRoute("POST", method, url, "/api/sessions/:id/archive");
		if (archiveMatch) {
			const id = decodeURIComponent(archiveMatch.id);
			const archiveMeta = readJson<Record<string, boolean>>(sessionArchiveMetadataPath(), {});
			archiveMeta[id] = true;
			writeJson(sessionArchiveMetadataPath(), archiveMeta);
			json(res, 200, { id, archived: true });
			return;
		}

		const unarchiveMatch = matchRoute("POST", method, url, "/api/sessions/:id/unarchive");
		if (unarchiveMatch) {
			const id = decodeURIComponent(unarchiveMatch.id);
			const archiveMeta = readJson<Record<string, boolean>>(sessionArchiveMetadataPath(), {});
			delete archiveMeta[id];
			writeJson(sessionArchiveMetadataPath(), archiveMeta);
			json(res, 200, { id, archived: false });
			return;
		}

		// --- Wiki API ---
		if (method === "GET" && url === "/api/wiki/pages") {
			try {
				const sourceIds = manifestSourceIdByWikiPath();
				const pages: unknown[] = [];
				for (const wikiPath of listWikiPagePaths()) {
					const fullPath = join(l2DataDir, wikiPath);
					if (existsSync(fullPath)) {
						const content = readText(fullPath);
						const { frontmatter, body } = parseFrontmatter(content);
						pages.push({
							path: wikiPath,
							frontmatter,
							bodyPreview: body.slice(0, 200),
							sourceId: sourceIds.get(wikiPath) ?? "",
						});
					}
				}
				json(res, 200, pages);
			} catch {
				json(res, 200, []);
			}
			return;
		}

		if (method === "GET" && url.startsWith("/api/wiki/page?")) {
			const params = new URL(url, "http://localhost").searchParams;
			const path = params.get("path");
			if (!path) {
				json(res, 400, { error: "Missing path parameter" });
				return;
			}
			const fullPath = safeJoin(l2DataDir, path);
			if (!fullPath) {
				json(res, 400, { error: "Invalid wiki path" });
				return;
			}
			if (!existsSync(fullPath)) {
				json(res, 404, { error: "Wiki page not found" });
				return;
			}
			const content = readText(fullPath);
			json(res, 200, { path, content });
			return;
		}

		if (method === "PUT" && url === "/api/wiki/page") {
			const body = (await readBody(req)) as Record<string, unknown>;
			const path = body.path as string | undefined;
			const content = body.content as string | undefined;
			if (!path || content === undefined) {
				json(res, 400, { error: "Missing path or content" });
				return;
			}
			const fullPath = safeJoin(l2DataDir, path);
			if (!fullPath) {
				json(res, 400, { error: "Invalid wiki path" });
				return;
			}
			writeText(fullPath, content);
			json(res, 200, { path, saved: true });
			return;
		}

		if (method === "GET" && url === "/api/wiki/graph") {
			try {
				const nodes: unknown[] = [];
				const edges: unknown[] = [];
				const titleToNodeId = new Map<string, string>();
				const pendingLinks: { source: string; target: string }[] = [];

				for (const wikiPath of listWikiPagePaths()) {
					const fullPath = join(l2DataDir, wikiPath);
					if (!existsSync(fullPath)) continue;
					const content = readText(fullPath);
					const { frontmatter, body } = parseFrontmatter(content);
					if (!frontmatter) continue;

					const nodeId = wikiPath;
					titleToNodeId.set(frontmatter.title, nodeId);
					titleToNodeId.set(wikiPath, nodeId);
					titleToNodeId.set(basename(wikiPath, extname(wikiPath)), nodeId);
					nodes.push({
						id: nodeId,
						title: frontmatter.title,
						type: frontmatter.type,
						tags: frontmatter.tags,
					});

					// Extract [[wiki links]] from body
					const linkPattern = /\[\[([^\]]+)\]\]/g;
					let match;
					while ((match = linkPattern.exec(body)) !== null) {
						const linkText = match[1].split("|")[0].trim();
						pendingLinks.push({ source: nodeId, target: linkText });
					}

					// Shared tag edges
					for (const tag of frontmatter.tags) {
						edges.push({ source: nodeId, target: `tag:${tag}`, type: "tag" });
					}
				}

				for (const link of pendingLinks) {
					edges.push({ source: link.source, target: titleToNodeId.get(link.target) ?? link.target, type: "link" });
				}

				// Add tag and unresolved wiki-link nodes
				const tagNodes = new Set<string>();
				for (const edge of edges as { source: string; target: string; type: string }[]) {
					if (edge.type === "tag" && !tagNodes.has(edge.target)) {
						tagNodes.add(edge.target);
						nodes.push({ id: edge.target, title: edge.target.replace("tag:", "#"), type: "tag", tags: [] });
					}
					if (edge.type === "link" && !titleToNodeId.has(edge.target)) {
						titleToNodeId.set(edge.target, edge.target);
						nodes.push({ id: edge.target, title: edge.target, type: "concept", tags: [] });
					}
				}

				json(res, 200, { nodes, edges });
			} catch {
				json(res, 200, { nodes: [], edges: [] });
			}
			return;
		}

		if (method === "GET" && url === "/api/wiki/stats") {
			try {
				const entries = readManifest(l2DataDir);
				let totalSize = 0;
				let pageCount = 0;
				for (const wikiPath of listWikiPagePaths()) {
					const fullPath = join(l2DataDir, wikiPath);
					if (existsSync(fullPath)) {
						totalSize += statSync(fullPath).size;
						pageCount++;
					}
				}
				json(res, 200, { pageCount, totalSize, entryCount: entries.length });
			} catch {
				json(res, 200, { pageCount: 0, totalSize: 0, entryCount: 0 });
			}
			return;
		}

		// --- Learner profile API (L1) ---
		if (method === "GET" && url === "/api/learner/profile") {
			const profile = loadProfile(paths.learnerDataDir);
			json(res, 200, profile);
			return;
		}

		if (method === "PATCH" && url === "/api/learner/profile") {
			const body = await readBody(req) as Partial<LearnerProfile>;
			const profile = loadProfile(paths.learnerDataDir);
			if (typeof body.profile_summary === "string") {
				profile.profile_summary = body.profile_summary;
			}
			if (body.preferences && typeof body.preferences === "object") {
				profile.preferences = normalizePreferences(body.preferences as Partial<LearnerPreferences>);
			}
			saveProfile(paths.learnerDataDir, profile);
			json(res, 200, profile);
			return;
		}

		if (method === "POST" && url === "/api/learner/profile/goals") {
			const body = await readBody(req) as Partial<LearningGoal>;
			const profile = loadProfile(paths.learnerDataDir);
			const goal: LearningGoal = {
				goal_id: `goal_${randomUUID().slice(0, 8)}`,
				title: typeof body.title === "string" ? body.title : "新目标",
				type: (body.type as LearningGoal["type"]) || "skill",
				priority: typeof body.priority === "number" ? body.priority : 0.5,
				status: (body.status as LearningGoal["status"]) || "active",
				success_criteria: Array.isArray(body.success_criteria) ? body.success_criteria.filter((s) => typeof s === "string") : [],
				source: "user_declared",
				updated_at: new Date().toISOString(),
			};
			profile.goals = [goal, ...profile.goals];
			saveProfile(paths.learnerDataDir, profile);
			json(res, 201, goal);
			return;
		}

		const goalPatchMatch = matchRoute("PATCH", method, url, "/api/learner/profile/goals/:goalId");
		if (goalPatchMatch) {
			const body = await readBody(req) as Partial<LearningGoal>;
			const profile = loadProfile(paths.learnerDataDir);
			const index = profile.goals.findIndex((g) => g.goal_id === goalPatchMatch.goalId);
			if (index < 0) {
				json(res, 404, { error: "Goal not found" });
				return;
			}
			const current = profile.goals[index];
			profile.goals[index] = {
				...current,
				title: typeof body.title === "string" ? body.title : current.title,
				type: (body.type as LearningGoal["type"]) ?? current.type,
				priority: typeof body.priority === "number" ? body.priority : current.priority,
				status: (body.status as LearningGoal["status"]) ?? current.status,
				success_criteria: Array.isArray(body.success_criteria)
					? body.success_criteria.filter((s) => typeof s === "string")
					: current.success_criteria,
				updated_at: new Date().toISOString(),
			};
			saveProfile(paths.learnerDataDir, profile);
			json(res, 200, profile.goals[index]);
			return;
		}

		const goalDeleteMatch = matchRoute("DELETE", method, url, "/api/learner/profile/goals/:goalId");
		if (goalDeleteMatch) {
			const profile = loadProfile(paths.learnerDataDir);
			const before = profile.goals.length;
			profile.goals = profile.goals.filter((g) => g.goal_id !== goalDeleteMatch.goalId);
			if (profile.goals.length === before) {
				json(res, 404, { error: "Goal not found" });
				return;
			}
			saveProfile(paths.learnerDataDir, profile);
			json(res, 200, { deleted: true });
			return;
		}

		const knowledgePatchMatch = matchRoute("PATCH", method, url, "/api/learner/profile/knowledge/:conceptId");
		if (knowledgePatchMatch) {
			const body = await readBody(req) as Partial<KnowledgeState>;
			const profile = loadProfile(paths.learnerDataDir);
			const index = profile.knowledge_states.findIndex((k) => k.concept_id === knowledgePatchMatch.conceptId);
			if (index < 0) {
				json(res, 404, { error: "Concept not found" });
				return;
			}
			const current = profile.knowledge_states[index];
			profile.knowledge_states[index] = {
				...current,
				mastery: typeof body.mastery === "number" ? clamp01(body.mastery) : current.mastery,
				confidence: typeof body.confidence === "number" ? clamp01(body.confidence) : current.confidence,
				stability: typeof body.stability === "number" ? clamp01(body.stability) : current.stability,
				diagnosis: typeof body.diagnosis === "string" ? body.diagnosis : current.diagnosis,
				next_actions: Array.isArray(body.next_actions)
					? body.next_actions.filter((s) => typeof s === "string")
					: current.next_actions,
			};
			saveProfile(paths.learnerDataDir, profile);
			json(res, 200, profile.knowledge_states[index]);
			return;
		}

		const misconceptionPatchMatch = matchRoute("PATCH", method, url, "/api/learner/profile/misconceptions/:miscId");
		if (misconceptionPatchMatch) {
			const body = await readBody(req) as Partial<Misconception>;
			const profile = loadProfile(paths.learnerDataDir);
			const index = profile.misconceptions.findIndex((m) => m.misconception_id === misconceptionPatchMatch.miscId);
			if (index < 0) {
				json(res, 404, { error: "Misconception not found" });
				return;
			}
			const current = profile.misconceptions[index];
			profile.misconceptions[index] = {
				...current,
				status: (body.status as Misconception["status"]) ?? current.status,
				severity: typeof body.severity === "number" ? clamp01(body.severity) : current.severity,
				repair_strategy: typeof body.repair_strategy === "string" ? body.repair_strategy : current.repair_strategy,
				last_seen_at: new Date().toISOString(),
			};
			saveProfile(paths.learnerDataDir, profile);
			json(res, 200, profile.misconceptions[index]);
			return;
		}

		// --- Workspace API ---
		if (method === "GET" && url.split("?")[0] === "/api/workspace/tree") {
			const wsId = workspaceIdFromQuery(url);
			const root = workspaceRegistry.resolveWorkspaceDir(wsId);
			if (!root) { json(res, 404, { error: "Workspace not found" }); return; }
			ensureDir(root);
			const stat = statSync(root);
			json(res, 200, {
				root,
				workspaceId: wsId,
				name: basename(root),
				path: "",
				type: "directory",
				size: stat.size,
				updatedAt: stat.mtime.toISOString(),
				children: readWorkspaceTree(root, root),
			});
			return;
		}

		if (method === "GET" && url.startsWith("/api/workspace/file?")) {
			const params = new URL(url, "http://localhost").searchParams;
			const requestedPath = params.get("path") ?? "";
			const wsId = workspaceIdFromQuery(url);
			const root = workspaceRegistry.resolveWorkspaceDir(wsId);
			if (!root) { json(res, 404, { error: "Workspace not found" }); return; }
			const filePath = safeWorkspacePath(wsId, requestedPath);
			if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
				json(res, 404, { error: "Workspace file not found" });
				return;
			}
			const stat = statSync(filePath);
			const kind = workspaceFileKind(filePath);
			const contentType = contentTypeForWorkspaceFile(filePath);
			if (kind === "binary" || kind === "pdf" || kind === "image" || kind === "office") {
				const relPath = workspaceRelativePath(root, filePath);
				const rawUrl = `/api/workspace/raw?workspaceId=${encodeURIComponent(wsId)}&path=${encodeURIComponent(relPath)}`;
				json(res, 200, {
					path: relPath,
					name: basename(filePath),
					kind,
					mimeType: contentType,
					size: stat.size,
					updatedAt: stat.mtime.toISOString(),
					url: rawUrl,
					// Office docs carry a separate URL that returns extracted text JSON.
					previewUrl: kind === "office"
						? `/api/workspace/office-preview?workspaceId=${encodeURIComponent(wsId)}&path=${encodeURIComponent(relPath)}`
						: undefined,
				});
				return;
			}
			if (stat.size > 1024 * 1024) {
				json(res, 413, { error: "File is too large to preview as text" });
				return;
			}
			json(res, 200, {
				path: workspaceRelativePath(root, filePath),
				name: basename(filePath),
				kind,
				mimeType: contentType,
				size: stat.size,
				updatedAt: stat.mtime.toISOString(),
				content: readFileSync(filePath, "utf-8"),
			});
			return;
		}

		if ((method === "GET" || method === "HEAD") && url.startsWith("/api/workspace/raw?")) {
			const params = new URL(url, "http://localhost").searchParams;
			const requestedPath = params.get("path") ?? "";
			const wantsDownload = params.get("download") === "1";
			const wsId = workspaceIdFromQuery(url);
			const filePath = safeWorkspacePath(wsId, requestedPath);
			if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
				json(res, 404, { error: "Workspace file not found" });
				return;
			}
			const content = readFileSync(filePath);
			const headers: Record<string, string | number> = {
				"Content-Type": contentTypeForWorkspaceFile(filePath),
				"Content-Length": content.length,
				"Cache-Control": "no-store",
			};
			if (wantsDownload) {
				headers["Content-Disposition"] = contentDispositionAttachment(basename(filePath));
			}
			res.writeHead(200, headers);
			res.end(method === "GET" ? content : undefined);
			return;
		}

		// Download a directory as a zip archive.
		if ((method === "GET" || method === "HEAD") && url.startsWith("/api/workspace/download-folder?")) {
			const params = new URL(url, "http://localhost").searchParams;
			const requestedPath = params.get("path") ?? "";
			const wsId = workspaceIdFromQuery(url);
			const root = workspaceRegistry.resolveWorkspaceDir(wsId);
			if (!root) { json(res, 404, { error: "Workspace not found" }); return; }
			// Empty path → zip the whole workspace root.
			const dirPath = requestedPath ? safeWorkspacePath(wsId, requestedPath) : root;
			if (!dirPath || !existsSync(dirPath) || !statSync(dirPath).isDirectory()) {
				json(res, 404, { error: "Workspace folder not found" });
				return;
			}
			const archiveName = `${basename(dirPath) || basename(root) || "workspace"}.zip`;
			if (method === "HEAD") {
				res.writeHead(200, {
					"Content-Type": "application/zip",
					"Content-Disposition": contentDispositionAttachment(archiveName),
					"Cache-Control": "no-store",
				});
				res.end();
				return;
			}
			try {
				const zipData = zipDirectory(dirPath);
				res.writeHead(200, {
					"Content-Type": "application/zip",
					"Content-Length": zipData.length,
					"Content-Disposition": contentDispositionAttachment(archiveName),
					"Cache-Control": "no-store",
				});
				res.end(zipData);
			} catch (err) {
				json(res, 500, { error: err instanceof Error ? err.message : "Failed to create zip archive" });
			}
			return;
		}

		// Extract text from office documents (docx/xlsx/pptx) for in-browser preview.
		if (method === "GET" && url.startsWith("/api/workspace/office-preview?")) {
			const params = new URL(url, "http://localhost").searchParams;
			const requestedPath = params.get("path") ?? "";
			const wsId = workspaceIdFromQuery(url);
			const filePath = safeWorkspacePath(wsId, requestedPath);
			if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
				json(res, 404, { error: "Workspace file not found" });
				return;
			}
			try {
				const { parseDocument } = await import("./memory/l2/document-parser.js");
				const parsed = await parseDocument(filePath);
				json(res, 200, {
					name: basename(filePath),
					pageCount: parsed.pageCount,
					text: parsed.text,
					pages: parsed.pages,
				});
			} catch (err) {
				json(res, 422, { error: err instanceof Error ? err.message : "Failed to parse document" });
			}
			return;
		}

		// --- Workspace Mutations API ---

		if (method === "PUT" && url === "/api/workspace/file") {
			const body = (await readBody(req)) as Record<string, unknown>;
			const wsId = workspaceIdFromBody(body);
			const filePath = typeof body.path === "string" ? body.path.trim() : "";
			const content = typeof body.content === "string" ? body.content : "";
			if (!filePath) { json(res, 400, { error: "Missing path" }); return; }
			const fullPath = safeWorkspacePath(wsId, filePath);
			if (!fullPath) { json(res, 400, { error: "Invalid path" }); return; }
			if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
				json(res, 404, { error: "File not found" }); return;
			}
			writeFileSync(fullPath, content, "utf-8");
			const stat = statSync(fullPath);
			json(res, 200, { path: filePath, saved: true, size: stat.size, updatedAt: stat.mtime.toISOString() });
			return;
		}

		if (method === "POST" && url === "/api/workspace/create") {
			const body = (await readBody(req)) as Record<string, unknown>;
			const wsId = workspaceIdFromBody(body);
			const root = workspaceRegistry.resolveWorkspaceDir(wsId);
			if (!root) { json(res, 404, { error: "Workspace not found" }); return; }
			const itemPath = typeof body.path === "string" ? body.path.trim() : "";
			const itemType = body.type === "directory" ? "directory" : "file";
			if (!itemPath) { json(res, 400, { error: "Missing path" }); return; }
			const fullPath = safeWorkspacePath(wsId, itemPath);
			if (!fullPath) { json(res, 400, { error: "Invalid path" }); return; }
			if (existsSync(fullPath)) { json(res, 409, { error: "Already exists" }); return; }
			if (itemType === "directory") {
				mkdirSync(fullPath, { recursive: true });
			} else {
				ensureDir(dirname(fullPath));
				writeFileSync(fullPath, "");
			}
			const stat = statSync(fullPath);
			json(res, 201, {
				name: basename(fullPath),
				path: workspaceRelativePath(root, fullPath),
				type: itemType,
				size: stat.size,
				updatedAt: stat.mtime.toISOString(),
			});
			return;
		}

		if (method === "POST" && url === "/api/workspace/rename") {
			const body = (await readBody(req)) as Record<string, unknown>;
			const wsId = workspaceIdFromBody(body);
			const root = workspaceRegistry.resolveWorkspaceDir(wsId);
			if (!root) { json(res, 404, { error: "Workspace not found" }); return; }
			const oldPath = typeof body.oldPath === "string" ? body.oldPath.trim() : "";
			const newPath = typeof body.newPath === "string" ? body.newPath.trim() : "";
			if (!oldPath || !newPath) { json(res, 400, { error: "Missing oldPath or newPath" }); return; }
			if (oldPath === newPath) { json(res, 400, { error: "Paths are identical" }); return; }
			const fullOld = safeWorkspacePath(wsId, oldPath);
			const fullNew = safeWorkspacePath(wsId, newPath);
			if (!fullOld || !fullNew) { json(res, 400, { error: "Invalid path" }); return; }
			if (!existsSync(fullOld)) { json(res, 404, { error: "Source not found" }); return; }
			if (existsSync(fullNew)) { json(res, 409, { error: "Target already exists" }); return; }
			ensureDir(dirname(fullNew));
			renameSync(fullOld, fullNew);
			const stat = statSync(fullNew);
			json(res, 200, {
				name: basename(fullNew),
				path: workspaceRelativePath(root, fullNew),
				type: stat.isDirectory() ? "directory" : "file",
				size: stat.size,
				updatedAt: stat.mtime.toISOString(),
			});
			return;
		}

		if (method === "POST" && url === "/api/workspace/delete") {
			const body = (await readBody(req)) as Record<string, unknown>;
			const wsId = workspaceIdFromBody(body);
			const itemPath = typeof body.path === "string" ? body.path.trim() : "";
			if (!itemPath) { json(res, 400, { error: "Cannot delete workspace root" }); return; }
			const fullPath = safeWorkspacePath(wsId, itemPath);
			if (!fullPath) { json(res, 400, { error: "Invalid path" }); return; }
			if (!existsSync(fullPath)) { json(res, 404, { error: "Not found" }); return; }
			rmSync(fullPath, { recursive: true, force: true });
			json(res, 200, { deleted: true, path: itemPath });
			return;
		}

		if (method === "POST" && url === "/api/workspace/move") {
			const body = (await readBody(req)) as Record<string, unknown>;
			const wsId = workspaceIdFromBody(body);
			const root = workspaceRegistry.resolveWorkspaceDir(wsId);
			if (!root) { json(res, 404, { error: "Workspace not found" }); return; }
			const sourcePath = typeof body.sourcePath === "string" ? body.sourcePath.trim() : "";
			const targetDir = typeof body.targetDir === "string" ? body.targetDir.trim() : "";
			if (!sourcePath) { json(res, 400, { error: "Missing sourcePath" }); return; }
			const fullSource = safeWorkspacePath(wsId, sourcePath);
			const fullTargetDir = targetDir ? safeWorkspacePath(wsId, targetDir) : root;
			if (!fullSource || !fullTargetDir) { json(res, 400, { error: "Invalid path" }); return; }
			if (!existsSync(fullSource)) { json(res, 404, { error: "Source not found" }); return; }
			const newFullPath = join(fullTargetDir, basename(fullSource));
			if (existsSync(newFullPath)) { json(res, 409, { error: "Target already exists" }); return; }
			ensureDir(fullTargetDir);
			renameSync(fullSource, newFullPath);
			const stat = statSync(newFullPath);
			json(res, 200, {
				name: basename(newFullPath),
				path: workspaceRelativePath(root, newFullPath),
				type: stat.isDirectory() ? "directory" : "file",
				size: stat.size,
				updatedAt: stat.mtime.toISOString(),
			});
			return;
		}

		if (method === "POST" && url === "/api/workspace/upload") {
			const body = (await readBody(req)) as Record<string, unknown>;
			const wsId = workspaceIdFromBody(body);
			const root = workspaceRegistry.resolveWorkspaceDir(wsId);
			if (!root) { json(res, 404, { error: "Workspace not found" }); return; }
			const files = Array.isArray(body.files) ? body.files : [];
			if (!files.length) { json(res, 400, { error: "No files provided" }); return; }
			const uploaded: Array<{ name: string; path: string; type: string; size: number; updatedAt: string }> = [];
			let installedSkill = false;
			for (const entry of files) {
				const filePath = typeof entry.path === "string" ? entry.path.trim() : "";
				const dataBase64 = typeof entry.dataBase64 === "string" ? entry.dataBase64 : "";
				if (!filePath || !dataBase64) continue;
				const fullPath = safeWorkspacePath(wsId, filePath);
				if (!fullPath) continue;
				const data = Buffer.from(dataBase64, "base64");
				const ext = extname(filePath).toLowerCase();

				// A .zip or .md dropped into the workspace's private skills dir is
				// installed as a skill (zip is extracted) rather than written raw.
				if (filePath.split("/").includes(WORKSPACE_PRIVATE_SKILLS_DIR) && (ext === ".zip" || ext === ".md")) {
					try {
						const skill = ext === ".zip"
							? installSkillZip(basename(filePath), data, join(root, WORKSPACE_PRIVATE_SKILLS_DIR))
							: installSkillMarkdown(basename(filePath), data, join(root, WORKSPACE_PRIVATE_SKILLS_DIR));
						uploaded.push(workspaceSkillNode(root, skill.name));
						installedSkill = true;
						continue;
					} catch (err) {
						json(res, 400, { error: err instanceof Error ? err.message : "Failed to install skill package" });
						return;
					}
				}

				ensureDir(dirname(fullPath));
				writeFileSync(fullPath, data);
				const stat = statSync(fullPath);
				uploaded.push({
					name: basename(fullPath),
					path: workspaceRelativePath(root, fullPath),
					type: "file",
					size: stat.size,
					updatedAt: stat.mtime.toISOString(),
				});
			}
			if (installedSkill) scheduleSkillsReload();
			json(res, 201, { uploaded });
			return;
		}

		// Install a skill package (.zip / .md) into the workspace's private .skills dir.
		if (method === "POST" && url === "/api/workspace/skills/upload") {
			const body = (await readBody(req)) as Record<string, unknown>;
			const wsId = workspaceIdFromBody(body);
			const root = workspaceRegistry.resolveWorkspaceDir(wsId);
			if (!root) { json(res, 404, { error: "Workspace not found" }); return; }
			const fileName = typeof body.fileName === "string" ? body.fileName : "";
			const dataBase64 = typeof body.dataBase64 === "string" ? body.dataBase64 : "";
			if (!fileName || !dataBase64) { json(res, 400, { error: "Missing fileName or dataBase64" }); return; }
			const ext = extname(fileName).toLowerCase();
			if (ext !== ".zip" && ext !== ".md") { json(res, 400, { error: "Only .zip or .md skill packages are supported" }); return; }
			const data = Buffer.from(dataBase64, "base64");
			try {
				const skill = ext === ".zip"
					? installSkillZip(fileName, data, join(root, WORKSPACE_PRIVATE_SKILLS_DIR))
					: installSkillMarkdown(fileName, data, join(root, WORKSPACE_PRIVATE_SKILLS_DIR));
				scheduleSkillsReload();
				json(res, 201, workspaceSkillNode(root, skill.name));
			} catch (err) {
				json(res, 400, { error: err instanceof Error ? err.message : "Failed to install skill package" });
			}
			return;
		}

		// --- Workspaces registry API ---
		if (method === "GET" && url === "/api/workspaces") {
			const sessionDir = join(dataDir, "sessions");
			const allSessionIds = existsSync(sessionDir)
				? readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"))
				: [];
			json(res, 200, workspaceRegistry.listWorkspaces(allSessionIds));
			return;
		}

		if (method === "POST" && url === "/api/workspaces") {
			const body = (await readBody(req)) as Record<string, unknown>;
			const name = typeof body.name === "string" ? body.name : undefined;
			const isTemp = Boolean(body.isTemp);
			try {
				const ws = workspaceRegistry.createWorkspace({ name, isTemp });
				json(res, 201, ws);
			} catch (err) {
				json(res, 400, { error: err instanceof Error ? err.message : "Failed to create workspace" });
			}
			return;
		}

		const workspacePatchMatch = matchRoute("PATCH", method, url, "/api/workspaces/:id");
		if (workspacePatchMatch) {
			const body = (await readBody(req)) as Record<string, unknown>;
			const name = typeof body.name === "string" ? body.name : "";
			if (!name.trim()) { json(res, 400, { error: "Missing name" }); return; }
			const updated = workspaceRegistry.renameWorkspace(decodeURIComponent(workspacePatchMatch.id), name);
			if (!updated) { json(res, 404, { error: "Workspace not found" }); return; }
			json(res, 200, updated);
			return;
		}

		const workspaceDeleteMatch = matchRoute("DELETE", method, url.split("?")[0], "/api/workspaces/:id");
		if (workspaceDeleteMatch) {
			const id = decodeURIComponent(workspaceDeleteMatch.id);
			if (id === TEMP_WORKSPACE_ID) {
				json(res, 400, { error: "Cannot delete the shared tmp workspace" });
				return;
			}
			const params = new URL(url, "http://localhost").searchParams;
			const removeFiles = params.get("removeFiles") === "1" || params.get("removeFiles") === "true";
			const ok = workspaceRegistry.deleteWorkspace(id, { removeFiles });
			if (!ok) { json(res, 404, { error: "Workspace not found" }); return; }
			json(res, 200, { id, deleted: true, removedFiles: removeFiles });
			return;
		}

		// --- Session ↔ workspace binding ---
		const sessionWorkspaceGetMatch = matchRoute("GET", method, url, "/api/sessions/:id/workspace");
		if (sessionWorkspaceGetMatch) {
			const sessionId = decodeURIComponent(sessionWorkspaceGetMatch.id);
			const workspaceId = workspaceRegistry.getSessionWorkspaceId(sessionId);
			const ws = workspaceRegistry.getWorkspace(workspaceId);
			json(res, 200, { sessionId, workspaceId, workspace: ws });
			return;
		}

		const sessionWorkspacePutMatch = matchRoute("PUT", method, url, "/api/sessions/:id/workspace");
		if (sessionWorkspacePutMatch) {
			const sessionId = decodeURIComponent(sessionWorkspacePutMatch.id);
			const body = (await readBody(req)) as Record<string, unknown>;
			const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
			if (!workspaceId) { json(res, 400, { error: "Missing workspaceId" }); return; }
			const ok = workspaceRegistry.bindSession(sessionId, workspaceId);
			if (!ok) { json(res, 404, { error: "Workspace not found" }); return; }
			// If the rebinding affects the currently active session, refresh agent cwd.
			if (getCurrentSessionId() === sessionId) {
				const sessionPath = sessionFileFromId(join(dataDir, "sessions"), sessionId);
				if (sessionPath) {
					await applyWorkspaceCwd(sessionPath);
				}
			}
			json(res, 200, { sessionId, workspaceId });
			return;
		}

		// --- Terminal sessions ---
		if (method === "POST" && url === "/api/terminal/sessions") {
			const body = (await readBody(req)) as Record<string, unknown>;
			const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
			if (!sessionId) { json(res, 400, { error: "Missing sessionId" }); return; }
			const requestedWs = typeof body.workspaceId === "string" && body.workspaceId.trim()
				? body.workspaceId.trim()
				: workspaceRegistry.getSessionWorkspaceId(sessionId);
			const cols = typeof body.cols === "number" ? body.cols : 100;
			const rows = typeof body.rows === "number" ? body.rows : 24;
			try {
				const ts = terminalManager.create({ sessionId, workspaceId: requestedWs, cols, rows });
				json(res, 201, { id: ts.id, sessionId: ts.sessionId, workspaceId: ts.workspaceId, cwd: ts.cwd, status: "ready" });
			} catch (err) {
				json(res, 400, { error: err instanceof Error ? err.message : "Failed to create terminal" });
			}
			return;
		}

		const terminalCloseMatch = matchRoute("POST", method, url, "/api/terminal/sessions/:id/close");
		if (terminalCloseMatch) {
			terminalManager.close(decodeURIComponent(terminalCloseMatch.id));
			json(res, 200, { closed: true });
			return;
		}

		// --- Runs ---
		if (method === "GET" && url.startsWith("/api/runs?")) {
			const params = new URL(url, "http://localhost").searchParams;
			const sessionId = params.get("sessionId") ?? "";
			const limit = Math.min(Number.parseInt(params.get("limit") ?? "20", 10) || 20, 100);
			if (!sessionId) { json(res, 400, { error: "Missing sessionId" }); return; }
			json(res, 200, runRecordStore.listForSession(sessionId, limit));
			return;
		}

		const runDetailMatch = matchRoute("GET", method, url.split("?")[0], "/api/runs/:id");
		if (runDetailMatch) {
			const record = runRecordStore.get(decodeURIComponent(runDetailMatch.id));
			if (!record) { json(res, 404, { error: "Run not found" }); return; }
			const params = new URL(url, "http://localhost").searchParams;
			const lines = Math.min(Number.parseInt(params.get("lines") ?? "200", 10) || 200, 2000);
			const tail = runRecordStore.getOutputTail(record, lines);
			json(res, 200, { ...record, outputTail: tail });
			return;
		}

		const runArchiveMatch = matchRoute("POST", method, url, "/api/runs/:id/archive");
		if (runArchiveMatch) {
			const record = runRecordStore.get(decodeURIComponent(runArchiveMatch.id));
			if (!record) { json(res, 404, { error: "Run not found" }); return; }
			const body = (await readBody(req)) as Record<string, unknown>;
			const title = typeof body.title === "string" && body.title.trim()
				? body.title.trim()
				: `Run: ${record.command.slice(0, 40)}`;
			const note = typeof body.note === "string" ? body.note.trim() : "";
			const outputTail = runRecordStore.getOutputTail(record, 500);
			const ws = workspaceRegistry.getWorkspace(record.workspaceId);

			const now = new Date().toISOString();
			const wikiRelPath = join("wiki", "analysis", `run-${record.id}.md`);
			const fullPath = join(l2DataDir, wikiRelPath);
			if (existsSync(fullPath)) {
				json(res, 409, { error: "Run already archived", path: wikiRelPath });
				return;
			}
			ensureDir(dirname(fullPath));

			const tags = ["run", "code-execution"];
			if (ws) tags.push(`workspace:${ws.name}`);
			if (record.sourceFile) {
				const ext = extname(record.sourceFile).slice(1);
				if (ext) tags.push(`lang:${ext}`);
			}
			const exitCodeText = record.exitCode === null || record.exitCode === undefined
				? "(unknown)"
				: String(record.exitCode);
			const exitStatus = record.exitCode === 0 ? "成功" : record.exitCode !== null && record.exitCode !== undefined ? "失败" : "未完成";

			const frontmatter = serializeFrontmatter({
				title,
				created: record.startedAt,
				updated: now,
				type: "analysis",
				tags,
				sources: record.sourceFile ? [record.sourceFile] : [],
				source_ids: [],
				status: "draft",
				confidence: "high",
			});

			const bodyLines = [
				`# ${title}`,
				"",
				"## 元信息",
				`- 命令: \`${record.command}\``,
				`- 工作区: ${ws?.name ?? record.workspaceId} (\`${record.cwd}\`)`,
				record.sourceFile ? `- 源文件: \`${record.sourceFile}\`` : "",
				`- 开始: ${record.startedAt}`,
				record.endedAt ? `- 结束: ${record.endedAt}` : "",
				`- 退出码: ${exitCodeText} (${exitStatus})`,
				record.signal ? `- 信号: ${record.signal}` : "",
				`- run id: ${record.id}`,
				"",
				"## 输出",
				"```",
				outputTail || "(无输出)",
				"```",
			].filter(Boolean);
			if (note) {
				bodyLines.push("", "## 备注", note);
			}

			const content = `${frontmatter}\n\n${bodyLines.join("\n")}\n`;
			writeText(fullPath, content);
			json(res, 201, { path: wikiRelPath, title, runId: record.id });
			return;
		}


		// --- L2 Raw Upload API ---
		if (method === "POST" && url === "/api/l2/raw/upload") {
			const body = (await readBody(req)) as Record<string, unknown>;
			const fileName = typeof body.fileName === "string" ? body.fileName : "";
			const mimeType = typeof body.mimeType === "string" ? body.mimeType : "application/octet-stream";
			const dataBase64 = typeof body.dataBase64 === "string" ? body.dataBase64 : "";
			if (!fileName || !dataBase64) {
				json(res, 400, { error: "Missing fileName or dataBase64" });
				return;
			}

			const dir = join(l2DataDir, "raw", "uploads");
			ensureDir(dir);
			const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
			const safeName = sanitizeUploadName(fileName);
			const ext = uploadExtension(safeName, mimeType);
			const base = basename(safeName, ext).slice(0, 80) || "upload";
			const outputName = `${timestamp}-${base}${ext}`;
			const outputPath = join(dir, outputName);
			const data = Buffer.from(dataBase64, "base64");
			writeFileSync(outputPath, data);
			const rawPath = join("raw", "uploads", outputName);
			json(res, 201, {
				fileName,
				mimeType,
				size: data.length,
				rawPath,
			});
			return;
		}

		// --- Settings API ---
		if (method === "GET" && url === "/api/settings") {
			json(res, 200, buildSafeSettings());
			return;
		}

		if (method === "POST" && url === "/api/settings/model") {
			const body = (await readBody(req)) as Record<string, unknown>;
			const provider = typeof body.provider === "string" ? body.provider.trim() : "";
			const model = typeof body.model === "string" ? body.model.trim() : "";
			if (!provider || !model) {
				json(res, 400, { error: "Missing provider or model" });
				return;
			}

			await switchModel(provider, model);
			config = saveConfig(paths.configPath, setDefaultModel(config, provider, model));
			syncConfig(config);
			const currentModel = getSession().model;
			json(res, 200, {
				defaultProvider: currentModel?.provider ?? provider,
				defaultModel: currentModel?.id ?? model,
			});
			return;
		}

		if ((method === "PUT" || method === "POST" || method === "PATCH") && url === "/api/settings/providers") {
			const body = (await readBody(req)) as Record<string, unknown>;
			const payload = parseProviderPayload(body);
			config = saveConfig(
				paths.configPath,
				upsertProvider(config, payload.providerId, payload.provider, {
					makeDefault: payload.makeDefault,
					preserveApiKey: payload.preserveApiKey,
				}),
			);
			await refreshConfiguredProviders(config);
			if (payload.makeDefault) {
				await switchModel(config.defaultProvider, config.defaultModel);
				config = saveConfig(paths.configPath, setDefaultModel(config, config.defaultProvider, config.defaultModel));
			}
			json(res, 200, buildSafeSettings());
			return;
		}

		if (method === "DELETE" && url.startsWith("/api/settings/providers/")) {
			const providerId = decodeURIComponent(url.slice("/api/settings/providers/".length));
			if (!providerId) {
				json(res, 400, { error: "Missing provider id" });
				return;
			}
			try {
				config = saveConfig(paths.configPath, deleteProvider(config, providerId));
				await refreshConfiguredProviders(config);
			} catch (err) {
				json(res, 400, { error: err instanceof Error ? err.message : String(err) });
				return;
			}
			json(res, 200, buildSafeSettings());
			return;
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
				config = saveConfig(paths.configPath, config);
			} catch (err) {
				json(res, 400, { error: err instanceof Error ? err.message : String(err) });
				return;
			}
			json(res, 200, buildSafeSettings());
			return;
		}

		// --- Memory Settings (L3 cross-conversation recall toggle) ---
		if (method === "PUT" && url === "/api/settings/memory") {
			const body = (await readBody(req)) as Record<string, unknown>;
			if (typeof body.l3Enabled !== "boolean") {
				json(res, 400, { error: "Missing l3Enabled (boolean)" });
				return;
			}
			config.memory = { l3Enabled: body.l3Enabled };
			config = saveConfig(paths.configPath, config);
			syncConfig(config);
			json(res, 200, buildSafeSettings());
			return;
		}

		// --- Chat API ---
		if (method === "POST" && url === "/api/chat") {
			const body = (await readBody(req)) as Record<string, unknown>;
			const prompt = body.prompt as string | undefined;
			if (!prompt) {
				json(res, 400, { error: "Missing prompt" });
				return;
			}
			const rawImages = Array.isArray(body.images) ? body.images : [];
			const images = rawImages
				.filter((img): img is { data: string; mimeType: string } =>
					img && typeof img.data === "string" && typeof img.mimeType === "string")
				.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
			// Use atomic switch+prompt when a specific session is requested.
			const requestedSessionId = typeof body.sessionId === "string" ? body.sessionId : null;
			let output: string;
			if (requestedSessionId) {
				const sessionPath = sessionFileFromId(join(dataDir, "sessions"), requestedSessionId);
				if (sessionPath && existsSync(sessionPath)) {
					output = await runPromptInSession(sessionPath, prompt, images.length ? images : undefined);
				} else {
					output = await runPromptSerialized(prompt, images.length ? images : undefined);
				}
			} else {
				output = await runPromptSerialized(prompt, images.length ? images : undefined);
			}
			recordCurrentSessionChannel("web", requestedSessionId || undefined, { setOriginIfEmpty: true });
			maybeAutoGenerateTopic(requestedSessionId || getCurrentSessionId());
			json(res, 200, { response: output });
			return;
		}

		// --- Question response (from web UI) ---
		if (method === "POST" && url === "/api/chat/question-response") {
			const body = (await readBody(req)) as Record<string, unknown>;
			const questionId = typeof body.questionId === "string" ? body.questionId : "";
			const result = body.result as QuestionBridgeResult | undefined;
			if (!questionId || !result) {
				json(res, 400, { error: "Missing questionId or result" });
				return;
			}
			const accepted = questionBridge.respond(questionId, result);
			json(res, accepted ? 200 : 404, { accepted });
			return;
		}

		// --- Chat Abort (explicit stop from UI) ---
		// The SSE req.on("close") handler also aborts, but connection-close is
		// unreliable through dev proxies and during rapid terminate→switch flows.
		// This gives the client a deterministic way to stop the backend stream so
		// the shared prompt queue is released immediately (otherwise new-session /
		// switch-session block behind a still-running turn).
		if (method === "POST" && url === "/api/chat/abort") {
			await abortCurrentPrompt();
			json(res, 200, { aborted: true });
			return;
		}

		// --- Chat Streaming (SSE) ---
		if (method === "POST" && url === "/api/chat/stream") {
			const body = (await readBody(req)) as Record<string, unknown>;
			const prompt = body.prompt as string | undefined;
			if (!prompt) {
				json(res, 400, { error: "Missing prompt" });
				return;
			}
			const rawImages = Array.isArray(body.images) ? body.images : [];
			const images = rawImages
				.filter((img): img is { data: string; mimeType: string } =>
					img && typeof img.data === "string" && typeof img.mimeType === "string")
				.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
			const imageArgs = images.length ? images : undefined;

			// Resolve target session path for atomic switch+stream.
			const requestedSessionId = typeof body.sessionId === "string" ? body.sessionId : null;
			let targetSessionPath: string | null = null;
			if (requestedSessionId) {
				const sessionPath = sessionFileFromId(join(dataDir, "sessions"), requestedSessionId);
				if (sessionPath && existsSync(sessionPath)) {
					targetSessionPath = sessionPath;
				}
			}
			const capturedSessionId = requestedSessionId || getCurrentSessionId();

			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				"Connection": "keep-alive",
				"X-Accel-Buffering": "no",
			});

			const sseWrite = (data: unknown) => {
				res.write(`data: ${JSON.stringify(data)}\n\n`);
			};

			let aborted = false;
			req.on("close", () => {
				aborted = true;
				questionBridge.setEmitter(null);
				questionBridge.cancel();
				void abortCurrentPrompt();
			});

			questionBridge.setEmitter(sseWrite);

			// Track whether the model API surfaced an error this turn. The PI SDK
			// does NOT throw on model API errors (e.g. HTTP 413 from an over-long
			// context) — it converts them into a terminal assistant message with
			// stopReason "error" + errorMessage, delivered via message_end. If we
			// don't forward that, runPromptStreaming resolves with empty text and
			// the UI shows nothing. So we detect it here and emit an error event.
			let emittedError = false;
			const onEvent = (event: import("@earendil-works/pi-coding-agent").AgentSessionEvent) => {
				if (aborted) return;
				switch (event.type) {
					case "message_update": {
						const ev = event.assistantMessageEvent;
						if (ev.type === "text_delta") {
							sseWrite({ type: "text_delta", delta: ev.delta });
						} else if (ev.type === "thinking_delta") {
							sseWrite({ type: "thinking_delta", delta: ev.delta });
						}
						break;
					}
					case "message_end": {
						const msg = event.message;
						if (
							msg && typeof msg === "object" && "stopReason" in msg &&
							(msg as { stopReason?: string }).stopReason === "error"
						) {
							emittedError = true;
							const detail = (msg as { errorMessage?: string }).errorMessage;
							sseWrite({ type: "error", message: detail || "The model request failed." });
						}
						break;
					}
					case "tool_execution_start":
						sseWrite({
							type: "tool_start",
							toolCallId: event.toolCallId,
							toolName: event.toolName,
							args: event.args,
						});
						break;
					case "tool_execution_end":
						sseWrite({
							type: "tool_end",
							toolCallId: event.toolCallId,
							toolName: event.toolName,
							result: event.result,
							isError: event.isError,
						});
						break;
				}
			};

			try {
				// Use atomic switch+stream when a specific session is requested,
				// preventing race conditions with channel session switches.
				const fullText = targetSessionPath
					? await runPromptStreamingInSession(targetSessionPath, prompt, onEvent, imageArgs)
					: await runPromptStreaming(prompt, onEvent, imageArgs);
				if (!aborted) sseWrite({ type: "done", fullText });
				// Skip topic auto-generation when the turn errored — there is no
				// meaningful assistant reply to summarize and the model API is
				// likely still failing (which would just block again).
				if (!emittedError) maybeAutoGenerateTopic(capturedSessionId);
			} catch (err) {
				if (!aborted && !emittedError) {
					sseWrite({ type: "error", message: err instanceof Error ? err.message : "Unknown error" });
				}
			} finally {
				// Always attribute this turn to the web channel — even on abort or
				// error — so an interrupted first prompt keeps origin "web" instead
				// of being mislabeled "cli" (which happens when no channels.json
				// entry exists) and grouped/lost incorrectly in the sidebar.
				recordCurrentSessionChannel("web", capturedSessionId, { setOriginIfEmpty: true });
				// If the turn was interrupted before any assistant content was
				// committed, the PI SDK never flushes the session to disk (it stays
				// header-only / 0-byte), so the conversation disappears once the user
				// switches away. Force a flush of the header + user message so the
				// session stays in the sidebar and can be reopened. No-op when an
				// assistant message already exists (normal/errored turns).
				persistPendingUserTurn(capturedSessionId);
			}
			if (!aborted) {
				res.write("data: [DONE]\n\n");
			}
			questionBridge.setEmitter(null);
			res.end();
			return;
		}

		// --- Static files / SPA fallback ---
		if (method === "GET" || method === "HEAD") {
			const urlPath = decodeURIComponent(url.split("?")[0]);
			const staticPath = safeJoin(webDistDir, urlPath.replace(/^\/+/, ""));
			const sendBody = method === "GET";
			// Try exact file in web/dist
			if (staticPath && serveStatic(res, staticPath, sendBody)) return;
			// SPA fallback: serve index.html for non-API paths
			if (serveStatic(res, join(webDistDir, "index.html"), sendBody)) return;
		}

		// --- 404 ---
		json(res, 404, { error: "Not found" });
	} catch (err) {
		console.error("[inno-server] error:", err);
		json(res, 500, { error: "Internal server error" });
	}
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

console.log("[inno-server] initializing agent session...");
initSession(config, paths, channelRegistry, {
	sandbox: parsed.options.sandbox,
	extensionDeps: {
		workspaceRegistry,
		runRecordStore,
		getCurrentSessionId,
		recordChannelInteraction: (channel) => recordCurrentSessionChannel(channel as SessionChannel),
	},
})
	.then(() => {
		// Create dispatcher now that agent session is ready
		const channelsDataDir = join(dataDir, "channels");
		ensureDir(channelsDataDir);
		dispatcher = new PersonalChannelDispatcher({
			channelRegistry,
			runPrompt: runPromptSerialized,
			runPromptInSession,
			createNewSession,
			getCurrentSessionId,
			recordSessionChannel: (ch, sid?) => recordCurrentSessionChannel(ch as SessionChannel, sid, { setOriginIfEmpty: true }),
			maybeAutoGenerateTopic,
			onSessionCreated: (sessionId, channel) => {
				// Channel-originated sessions bind to a fixed per-channel workspace
				// (they cannot prompt the user to choose one).
				try {
					const ws = workspaceRegistry.ensureChannelWorkspace(channel);
					workspaceRegistry.bindSession(sessionId, ws.id);
				} catch (err) {
					console.warn(`[sessions] failed to bind channel session ${sessionId}:`, err instanceof Error ? err.message : err);
				}
			},
			channelsDataDir,
			sessionDir: join(dataDir, "sessions"),
		});

		// Start Feishu WebSocket if enabled
		if (feishuChannel) {
			feishuChannel.onMessage((msg) => dispatcher!.handle(feishuChannel!, msg));
			feishuChannel.start();
		}

		// Start WeChat iLink if logged in
		if (wechatChannel) {
			wechatChannel.onMessage((msg) => dispatcher!.handle(wechatChannel!, msg));
			wechatChannel.start();
		}

		// Start cron scheduler
		const scheduler = new CronScheduler(jobStore, channelRegistry);
		scheduler.start();

		// --- WebSocket: terminal sessions ---
		const wss = new WebSocketServer({ noServer: true });
		server.on("upgrade", (req, socket, head) => {
			const url = req.url ?? "";
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

		function send(ws: WebSocket, event: ServerTerminalEvent): void {
			if (ws.readyState === ws.OPEN) {
				ws.send(JSON.stringify(event));
			}
		}

		function bindTerminalWs(ws: WebSocket, terminalId: string): void {
			const ts = terminalManager.get(terminalId);
			if (!ts) {
				send(ws, { type: "error", message: "Terminal not found" });
				ws.close();
				return;
			}

			send(ws, { type: "ready", sessionId: ts.sessionId, cwd: ts.cwd, workspaceId: ts.workspaceId });

			const offData = ts.pty.onData((chunk: string) => {
				const { cleaned, finishedRun } = terminalManager.processOutput(ts, chunk);
				if (cleaned) {
					terminalManager.recordOutput(ts, cleaned);
					send(ws, { type: "output", data: cleaned });
				}
				if (finishedRun) {
					const run = terminalManager.finishActiveRun(ts, finishedRun.exitCode);
					send(ws, { type: "exit", code: finishedRun.exitCode, runId: run?.id });
				}
			});
			const offExit = ts.pty.onExit(({ exitCode, signal }) => {
				const run = terminalManager.finishActiveRun(ts, exitCode, signal ? String(signal) : undefined);
				send(ws, { type: "exit", code: exitCode, signal: signal ? String(signal) : undefined, runId: run?.id });
				ws.close();
			});

			ws.on("message", (raw) => {
				let event: ClientTerminalEvent;
				try {
					event = JSON.parse(raw.toString()) as ClientTerminalEvent;
				} catch {
					send(ws, { type: "error", message: "Invalid JSON" });
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
							send(ws, { type: "error", message: "Command too long" });
							break;
						}
						const record = terminalManager.startRun(ts, event.command, event.sourceFile);
						send(ws, { type: "run_started", runId: record.id, command: event.command });
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
				// Mark any in-flight run as unfinished but recorded.
				terminalManager.finishActiveRun(ts, null);
			});
		}

		server.listen(port, () => {
			console.log(`[inno-server] listening on http://localhost:${port}`);
			console.log(`[inno-server] config: ${paths.configPath}`);
			console.log(`[inno-server] data: ${paths.dataDir}`);
			console.log(`[inno-server] skills: ${paths.skillsDir}`);
			console.log(`[inno-server] workspace: ${paths.workspaceDir}`);
			console.log(`[inno-server] channels: ${channelRegistry.all().map((c) => c.name).join(", ") || "none"}`);
			console.log(`[inno-server] jobs loaded: ${jobStore.list().length}`);
		});
	})
	.catch((err) => {
		console.error("[inno-server] failed to initialize:", err);
		process.exit(1);
	});
