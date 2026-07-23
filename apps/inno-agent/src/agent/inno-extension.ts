import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	formatSkillsForPrompt,
	loadSkillsFromDir,
	type ExtensionAPI,
	type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { saveConfig, setDefaultModel, type InnoConfig } from "../config.js";
import { createLearnerTools } from "../memory/learner/learner-tools.js";
import { isProfileEmpty, loadEvents, loadProfile } from "../memory/learner/profile-store.js";
import { buildContextPack, formatContextPackForPrompt } from "../memory/learner/context-pack.js";
import { JobStore } from "../scheduler/job-store.js";
import { createSchedulerTools } from "../scheduler/scheduler-tools.js";
import { createChannelTools } from "../channels/channel-tools.js";
import { createL2Tools } from "../memory/l2/l2-tools.js";
import { getL2Memory } from "../memory/l2/l2-memory.js";
import { L3Memory, createL3Tools, formatRecallForPrompt } from "../memory/l3/l3-tools.js";
import { createPracticeTools } from "./practice-tools.js";
import { createDocumentTools } from "./document-tools.js";
import { createOcrTools } from "./ocr-tools.js";
import { checkWorkspaceMutationPath } from "./workspace-path-guard.js";
import { INNO_SYSTEM_PROMPT, ONBOARDING_GUIDE } from "./system-prompt.js";
import { syncProvidersForSubagents } from "./provider-sync.js";
import { questionBridge } from "./question-bridge.js";
import { logger } from "../logger.js";
import type { ChannelRegistry } from "../channels/channel.js";
import type { ChannelName } from "../channels/types.js";
import type { RuntimePaths } from "../runtime.js";
import type { WorkspaceRegistry } from "../workspace/workspace-registry.js";
import type { RunRecordStore } from "../terminal/run-record-store.js";

const INNO_VERSION = "0.0.1";

/**
 * Create the inno-agent extension factory.
 *
 * This extension:
 * 1. Registers the custom provider (InnoSpark OpenAI-compatible API)
 * 2. Registers L1 learner tools
 * 3. Registers scheduler tools (create/list/update/delete jobs)
 * 4. Registers L2 Wiki memory tools (archive/query)
 * 5. Injects L1 context into system prompt before each agent turn
 * 6. Customizes the startup header to show "inno" branding
 */
export interface ConfigHolder {
	current: InnoConfig;
}

export interface InnoExtensionDeps {
	workspaceRegistry?: WorkspaceRegistry;
	runRecordStore?: RunRecordStore;
	getCurrentSessionId?: () => string;
	/** Tag the active session as having interacted with a channel (file send, etc.). */
	recordChannelInteraction?: (channel: ChannelName) => void;
}

/** File name for per-workspace agent context, loaded into the prompt each turn. */
const WORKSPACE_AGENT_FILE = "agent.md";
/** Directory holding per-workspace private skills (merged with global skills). */
const WORKSPACE_SKILLS_DIR = ".skills";

/**
 * Resolve the directory of the workspace bound to the active session.
 * Server: maps the current session id → workspace via the registry.
 * CLI / no registry: falls back to the runtime workspace root.
 */
function resolveActiveWorkspaceDir(paths: RuntimePaths, deps?: InnoExtensionDeps): string {
	if (deps?.workspaceRegistry && deps.getCurrentSessionId) {
		try {
			const sessionId = deps.getCurrentSessionId();
			if (sessionId) {
				const workspaceId = deps.workspaceRegistry.getSessionWorkspaceId(sessionId);
				const dir = deps.workspaceRegistry.resolveWorkspaceDir(workspaceId);
				if (dir) return dir;
			}
		} catch (err) {
			logger.warn({ err }, "failed to resolve active workspace dir, falling back to root");
			// Fall through to the workspace root.
		}
	}
	return paths.workspaceDir;
}

/**
 * Build extra system-prompt sections for the active workspace:
 * - the workspace's `agent.md` content (if present)
 * - a private-skills block discovered under `<workspace>/.skills`
 */
function buildWorkspaceContextSections(workspaceDir: string): string[] {
	const sections: string[] = [];

	const agentFile = join(workspaceDir, WORKSPACE_AGENT_FILE);
	if (existsSync(agentFile)) {
		try {
			const content = readFileSync(agentFile, "utf-8").trim();
			if (content) {
				sections.push(`# 工作区上下文 (${WORKSPACE_AGENT_FILE})\n\n${content}`);
			}
		} catch (err) {
			logger.warn({ err }, "failed to read workspace agent.md");
			// Ignore unreadable agent.md
		}
	}

	const skillsDir = join(workspaceDir, WORKSPACE_SKILLS_DIR);
	if (existsSync(skillsDir)) {
		try {
			const { skills } = loadSkillsFromDir({ dir: skillsDir, source: "path" });
			if (skills.length > 0) {
				const block = formatSkillsForPrompt(skills);
				if (block.trim()) {
					sections.push(`# 本工作区私有技能\n${block}`);
				}
			}
		} catch (err) {
			logger.warn({ err }, "failed to discover workspace skills");
			// Ignore skill discovery failures
		}
	}

	return sections;
}

function formatWorkspaceFileInstructions(workspaceDir: string): string {
	return [
		"# 当前会话文件工作区",
		`文件浏览器只显示此目录中的文件：\`${workspaceDir}\``,
		"调用 write 或 edit 时必须使用相对于该目录的路径，例如 `notes.md` 或 `src/main.py`。",
		"不要使用该目录之外的绝对路径，也不要通过 `..` 或符号链接越过该目录；越界修改会被拒绝。",
	].join("\n");
}

/**
 * Detect whether a bash command tries to launch a file/URL via `open` (macOS)
 * or `xdg-open` (Linux). In browser-accessible deployments these execute on
 * the server host where the user can't see them; the web file panel already
 * auto-opens a preview when files are written.
 */
const OPEN_LAUNCH_CMD_RE = /(?:^|[;&|]|\s&&\s)\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:xdg-)?open\s+\S/;

function isOpenLaunchCommand(command: string): boolean {
	return OPEN_LAUNCH_CMD_RE.test(command);
}

export function createInnoExtension(
	configHolder: ConfigHolder,
	paths: RuntimePaths,
	channelRegistry?: ChannelRegistry,
	deps?: InnoExtensionDeps,
): ExtensionFactory {
	return async (pi: ExtensionAPI) => {
		// 1. Register configured backend model providers.
		const config = configHolder.current;
		for (const [providerId, providerConfig] of Object.entries(config.providers)) {
			pi.registerProvider(providerId, {
				baseUrl: providerConfig.baseUrl,
				apiKey: providerConfig.apiKey || "local",
				api: providerConfig.api ?? "openai-completions",
				headers: providerConfig.headers,
				authHeader: providerConfig.authHeader,
				models: providerConfig.models.map((m) => ({
					id: m.id,
					name: m.name,
					reasoning: m.reasoning,
					input: m.input,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: m.contextWindow,
					maxTokens: m.maxTokens,
					compat: {
						supportsDeveloperRole: false,
					},
				})),
			});
		}

		pi.on("model_select", async (event) => {
			const cfg = configHolder.current;
			if (!cfg.providers[event.model.provider]) return;
			try {
				configHolder.current = saveConfig(paths.configPath, setDefaultModel(cfg, event.model.provider, event.model.id));
			} catch (err) {
				// The selected model may be a runtime-only model; leave persisted config unchanged.
				logger.warn({ err, provider: event.model.provider, modelId: event.model.id }, "model_select: failed to persist default model to config");
			}
		});

		// Memory-layer runtime gates. All default ON; only an explicit `false`
		// in config.memory disables a layer. Read live from configHolder so the
		// toggles take effect without a restart.
		// Simple Mode is a global override: when enabled it force-locks all three
		// memory layers OFF, regardless of config.memory, without mutating those
		// values — so turning Simple Mode off restores the user's preferences.
		const isSimpleMode = () => configHolder.current.simpleMode?.enabled === true;
		const isL1Enabled = () => !isSimpleMode() && configHolder.current.memory?.l1Enabled !== false;
		const isL2Enabled = () => !isSimpleMode() && configHolder.current.memory?.l2Enabled !== false;

		// 2. Register L1 learner tools (gated on config.memory.l1Enabled)
		const learnerTools = createLearnerTools(paths.learnerDataDir, "default", isL1Enabled);
		for (const tool of learnerTools) {
			pi.registerTool(tool);
		}

		// 3. Register scheduler tools
		const jobStore = new JobStore(paths.jobsDir);
		const schedulerTools = createSchedulerTools(jobStore, channelRegistry);
		for (const tool of schedulerTools) {
			pi.registerTool(tool);
		}

		// 3a. Register channel tools (send workspace files out to chat channels)
		if (channelRegistry) {
			const channelTools = createChannelTools({
				channelRegistry,
				workspaceRegistry: deps?.workspaceRegistry,
				getCurrentSessionId: deps?.getCurrentSessionId,
				workspaceDir: paths.workspaceDir,
				recordChannelInteraction: deps?.recordChannelInteraction,
			});
			for (const tool of channelTools) {
				pi.registerTool(tool);
			}
		}

		// 4. Register L2 Wiki memory tools (gated on config.memory.l2Enabled)
		const l2Memory = getL2Memory(paths.l2DataDir);
		const l2Tools = createL2Tools(paths.l2DataDir, isL2Enabled, l2Memory);
		for (const tool of l2Tools) {
			pi.registerTool(tool);
		}
		// Backfill the retrieval index from existing wiki pages; never block boot.
		// Index sync runs even when L2 is disabled (so re-enabling has no gap),
		// but overview generation — a visible write to the knowledge base — is
		// gated on L2 being enabled.
		void l2Memory.backfill({ generateOverview: isL2Enabled() });

		// 4a. Register L3 cross-conversation memory (sqlite-backed recall).
		// Recall (auto-inject + the l3_recall tool) is gated at runtime on
		// config.memory.l3Enabled (default on); indexing always runs so the
		// switch can be flipped back on without a backfill gap.
		const l3Memory = new L3Memory(paths.l3DataDir, paths.sessionDir);
		const isL3Enabled = () => !isSimpleMode() && configHolder.current.memory?.l3Enabled !== false;
		const l3Tools = createL3Tools(l3Memory, deps?.getCurrentSessionId, isL3Enabled);
		for (const tool of l3Tools) {
			pi.registerTool(tool);
		}
		// Backfill the index from existing sessions in the background; never block boot.
		void l3Memory.backfill();

		// 4b. Register document parsing tools
		const documentTools = createDocumentTools();
		for (const tool of documentTools) {
			pi.registerTool(tool);
		}

		// 4c. Register OCR tool (Baidu PaddleOCR-VL). Used when the configured
		// chat model cannot natively recognize images. Reads credentials live
		// from configHolder so settings changes take effect without restart.
		const ocrTools = createOcrTools(configHolder);
		for (const tool of ocrTools) {
			pi.registerTool(tool);
		}

		// 4b. Register practice-lab tools (when workspace registry available)
		if (deps?.workspaceRegistry && deps.getCurrentSessionId) {
			const practiceTools = createPracticeTools({
				registry: deps.workspaceRegistry,
				getCurrentSessionId: deps.getCurrentSessionId,
			});
			for (const tool of practiceTools) {
				pi.registerTool(tool);
			}
		}

		// 5. Keep built-in file mutations inside the workspace bound to the
		// active session. PI accepts absolute paths, so cwd alone is not a
		// sufficient boundary when the model emits a stale parent path.
		pi.on("tool_call", async (event) => {
			if (event.toolName !== "write" && event.toolName !== "edit") return undefined;

			const requestedPath = event.input.path;
			const workspaceDir = resolveActiveWorkspaceDir(paths, deps);
			if (typeof requestedPath !== "string") {
				return { block: true, reason: "文件路径无效，请使用当前工作区内的相对路径。" };
			}

			const check = checkWorkspaceMutationPath(workspaceDir, requestedPath);
			if (check.allowed) return undefined;

			logger.warn(
				{
					toolName: event.toolName,
					requestedPath,
					resolvedPath: check.resolvedPath,
					workspaceDir,
					reason: check.reason,
				},
				"blocked file mutation outside active workspace",
			);
			return {
				block: true,
				reason: `文件路径不在当前工作区内。当前工作区是 ${workspaceDir}，请改用相对路径后重试。`,
			};
		});

		// 5b. Block `open`/`xdg-open` shell commands. In server deployments
		// these run on the host where the user can't see the result; the web
		// file panel already auto-opens a preview when files are written.
		pi.on("tool_call", async (event) => {
			if (event.toolName !== "bash") return undefined;
			const command = event.input?.command;
			if (typeof command !== "string" || !isOpenLaunchCommand(command)) return undefined;
			logger.warn({ command }, "blocked open/xdg-open command in bash tool");
			return {
				block: true,
				reason: "不要使用 open/xdg-open 命令打开文件。文件生成后用户会在浏览器右侧的文件预览面板自动看到结果；如需引导用户查看，在回复里说明文件路径即可。",
			};
		});

		// 5a. Log all tool execution errors centrally. This covers every tool
				// registered with the PI SDK — both Inno's custom tools and the
				// built-in bash/read/edit/write/grep/find/ls tools — without needing
			// per-tool try/catch blocks.
			pi.on("tool_result", async (event) => {
				if (event.isError) {
					const text = Array.isArray(event.content)
						? event.content.map((c) => (c as { text?: string }).text ?? "").join(" ").slice(0, 500)
						: String(event.content ?? "").slice(0, 500);
					logger.warn(
						{ toolName: event.toolName, toolCallId: event.toolCallId, input: event.input },
						"Tool call failed: %s — %s",
						event.toolName,
						text || "(no error text)",
					);
				}
			});

			// 6. Inject L1 context and custom system prompt before each agent turn
			pi.on("before_agent_start", async (event, ctx) => {
				const sections: string[] = [INNO_SYSTEM_PROMPT];

				// Inject the L1 learner context pack (profile + recent events)
				// unless the learner has turned L1 off in settings.
				if (isL1Enabled()) {
					const profile = loadProfile(paths.learnerDataDir);

					// If the profile is empty (new user), inject the structured
					// onboarding guide so the agent prioritises building a baseline
					// learner profile over casual conversation.
					if (isProfileEmpty(profile)) {
						sections.push(ONBOARDING_GUIDE);
					}

					const recentEvents = loadEvents(paths.learnerDataDir).slice(-8);
					const contextPack = buildContextPack(profile, recentEvents);
					const contextSection = formatContextPackForPrompt(contextPack);
					sections.push(contextSection);
				}

				// Inject per-workspace context: agent.md + private skills.
				const workspaceDir = resolveActiveWorkspaceDir(paths, deps);
				sections.push(formatWorkspaceFileInstructions(workspaceDir));
				sections.push(...buildWorkspaceContextSections(workspaceDir));

				// Inject threshold-gated cross-conversation recall (L3). Only
				// injects when past snippets clear the relevance threshold, so
				// unrelated turns stay clean. Skipped entirely when the user has
				// turned L3 recall off in settings.
				if (isL3Enabled()) {
					try {
						let currentSessionId = "";
						const sessionFile = ctx.sessionManager.getSessionFile?.();
						if (sessionFile) currentSessionId = sessionFile.split(/[\\/]/).pop() ?? "";
						if (!currentSessionId && deps?.getCurrentSessionId) currentSessionId = deps.getCurrentSessionId();
						const recalled = await l3Memory.recall(event.prompt, currentSessionId || undefined);
						const recallSection = formatRecallForPrompt(recalled);
						if (recallSection) sections.push(recallSection);
					} catch(err) {
						// best-effort — recall failures must not block the turn
						logger.warn({err}, "L3 recall failed (non-fatal)");

					}
				}

				// Inject the latest run record for this session, so the agent can
				// answer "explain the last run" without separate tool calls.
				if (deps?.runRecordStore && deps.getCurrentSessionId) {
					try {
						const sid = deps.getCurrentSessionId();
						const last = deps.runRecordStore.getLatestForSession(sid);
						if (last) {
							const tail = deps.runRecordStore.getOutputTail(last, 80);
							sections.push(
								[
									"[最近一次代码运行]",
									`命令: ${last.command}`,
									`目录: ${last.cwd}`,
									`开始: ${last.startedAt}`,
									last.endedAt ? `结束: ${last.endedAt}` : "结束: (运行中或异常退出)",
									last.exitCode !== undefined ? `exit: ${last.exitCode}` : "exit: ?",
									last.sourceFile ? `源文件: ${last.sourceFile}` : "",
									"输出 (tail 80 行):",
									"```",
									tail || "(空)",
									"```",
								].filter(Boolean).join("\n"),
							);
						}
					} catch (err) {
						logger.warn({ err }, "Failed to fetch run record (non-fatal)");
					}
				}

				sections.push(event.systemPrompt);

				return {
					systemPrompt: sections.join("\n\n"),
				};
		});

		// 7. Custom startup header
		pi.on("session_start", async (_event, ctx) => {
			if (ctx.hasUI) {
				ctx.ui.setHeader((_tui, theme) => ({
					render(_width: number): string[] {
						const logo = theme.bold(theme.fg("accent", "inno")) + theme.fg("dim", ` v${INNO_VERSION}`);
						const hints = [
							"escape interrupt",
							"ctrl+c/ctrl+d clear/exit",
							"/ commands",
							"! bash",
							"ctrl+o more",
						].join(theme.fg("muted", " · "));
						const onboarding = theme.fg("dim", "Inno is your personal learning agent with L1 learner profile memory.");
						return ["", `${logo}`, `${hints}`, `${onboarding}`];
					},
					invalidate() {},
				}));
				ctx.ui.setTitle("inno");
			}
		});

		// 7b. Incrementally index the active session into L3 after each turn, so
		// the just-finished exchange becomes recallable in future conversations.
		pi.on("turn_end", async (_event, ctx) => {
			try {
				const sessionFile = ctx.sessionManager.getSessionFile?.();
				const sessionId = sessionFile ? sessionFile.split(/[\\/]/).pop() ?? "" : "";
				if (sessionId) await l3Memory.indexById(sessionId);
			} catch (err) {
				// best-effort — indexing must not affect the turn
				logger.warn({ err }, "L3 turn_end indexing failed (non-fatal)");
			}
		});

		// 8. Register pi-subagents extension (when enabled)
		if (config.subagents?.enabled) {
			try {
				syncProvidersForSubagents(config);
				const { createJiti } = await import("jiti/static");
				const jiti = createJiti(import.meta.url, { moduleCache: false });
				const subagentModulePath = ["pi-subagents", "src", "extension", "index.ts"].join("/");
				const mod = await jiti.import(subagentModulePath, { default: true });
				const registerSubagentExtension = mod as (pi: ExtensionAPI) => void;
				if (typeof registerSubagentExtension === "function") {
					registerSubagentExtension(pi);
				}
			} catch (err) {
				logger.warn({ err }, "Failed to load pi-subagents extension");
			}
		}

		// 9. Register ask_user_question tool with TUI / Web dual path
		try {
			const { createJiti: createJiti2 } = await import("jiti/static");
			const jiti2 = createJiti2(import.meta.url, { moduleCache: false });

			// Resolve the package's real filesystem path to bypass exports restrictions
			const { fileURLToPath } = await import("node:url");
			const { dirname } = await import("node:path");
			const rpivEntry = import.meta.resolve("@juicesharp/rpiv-ask-user-question");
			const rpivDir = dirname(fileURLToPath(rpivEntry));

			const typesPath = `${rpivDir}/tool/types.ts`;
			const envelopePath = `${rpivDir}/tool/response-envelope.ts`;
			const validatePath = `${rpivDir}/tool/validate-questionnaire.ts`;
			const typesModule = await jiti2.import(typesPath) as Record<string, unknown>;
			const envelopeModule = await jiti2.import(envelopePath) as Record<string, unknown>;
			const validateModule = await jiti2.import(validatePath) as Record<string, unknown>;

			const QuestionParamsSchema = typesModule.QuestionParamsSchema as Record<string, unknown>;
			const buildQuestionnaireResponse = envelopeModule.buildQuestionnaireResponse as (result: unknown, params: unknown) => { content: Array<{ type: string; text: string }>; details: unknown };
			const buildToolResult = envelopeModule.buildToolResult as (text: string, details: unknown) => { content: Array<{ type: string; text: string }>; details: unknown };
			const validateQuestionnaire = validateModule.validateQuestionnaire as (params: unknown) => { ok: boolean; error?: string; message?: string };

			// Lazy-load TUI modules only when needed
			let tuiModulesLoaded = false;
			let QuestionnaireSession: unknown;
			let buildItemsForQuestion: unknown;

			async function ensureTuiModules() {
				if (tuiModulesLoaded) return;
				const sessionPath = `${rpivDir}/state/questionnaire-session.ts`;
				const askPath = `${rpivDir}/ask-user-question.ts`;
				const sessionModule = await jiti2.import(sessionPath) as Record<string, unknown>;
				const askModule = await jiti2.import(askPath) as Record<string, unknown>;
				QuestionnaireSession = sessionModule.QuestionnaireSession;
				buildItemsForQuestion = askModule.buildItemsForQuestion;
				tuiModulesLoaded = true;
			}

			pi.registerTool({
				name: "ask_user_question",
				label: "Ask User Question",
				description: "Ask the user one or more questions with predefined options. Supports single-select, multi-select, free text input, and option previews.",
				parameters: QuestionParamsSchema,
				async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
					const typed = params as { questions: Array<{ question: string; header: string; options: Array<{ label: string; description: string; preview?: string }>; multiSelect?: boolean }> };

					const validation = validateQuestionnaire(typed);
					if (!validation.ok) {
						return buildToolResult(validation.message ?? "Invalid questionnaire", {
							answers: [],
							cancelled: true,
							error: validation.error,
						});
					}

					// TUI mode: delegate to rpiv's QuestionnaireSession
					if (ctx.hasUI) {
						await ensureTuiModules();
						const buildItems = buildItemsForQuestion as (q: unknown) => unknown[];
						const itemsByTab = typed.questions.map((q) => buildItems(q));
						const ui = ctx.ui as { custom: <T>(fn: (tui: unknown, theme: unknown, kb: unknown, done: (r: T) => void) => unknown) => Promise<T> };
						const SessionClass = QuestionnaireSession as new (config: unknown) => { component: unknown };

						const result = await ui.custom((tui: unknown, theme: unknown, _kb: unknown, done: (r: unknown) => void) => {
							const session = new SessionClass({
								tui,
								theme,
								params: typed,
								itemsByTab,
								done,
							});
							return session.component;
						});
						return buildQuestionnaireResponse(result, typed);
					}

					// Web mode: delegate to QuestionBridge
					let currentSessionId: string | undefined;
					if (deps?.getCurrentSessionId) currentSessionId = deps.getCurrentSessionId();
					const bridgeResult = await questionBridge.ask(typed, currentSessionId);
					return buildQuestionnaireResponse(bridgeResult, typed);
				},
			} as Parameters<typeof pi.registerTool>[0]);
		} catch (err) {
			logger.warn({ err }, "Failed to register ask_user_question tool");
		}
	};
}
