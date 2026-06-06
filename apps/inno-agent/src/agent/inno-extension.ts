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
import { loadEvents, loadProfile } from "../memory/learner/profile-store.js";
import { buildContextPack, formatContextPackForPrompt } from "../memory/learner/context-pack.js";
import { JobStore } from "../scheduler/job-store.js";
import { createSchedulerTools } from "../scheduler/scheduler-tools.js";
import { createL2Tools } from "../memory/l2/l2-tools.js";
import { L3Memory, createL3Tools, formatRecallForPrompt } from "../memory/l3/l3-tools.js";
import { createPracticeTools } from "./practice-tools.js";
import { createDocumentTools } from "./document-tools.js";
import { INNO_SYSTEM_PROMPT } from "./system-prompt.js";
import { syncProvidersForSubagents } from "./provider-sync.js";
import { questionBridge } from "./question-bridge.js";
import type { ChannelRegistry } from "../channels/channel.js";
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
		} catch {
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
		} catch {
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
					sections.push(`# 本工作区私有技能${block}`);
				}
			}
		} catch {
			// Ignore skill discovery failures
		}
	}

	return sections;
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
				models: providerConfig.models.map((m) => ({
					id: m.id,
					name: m.name,
					reasoning: m.reasoning,
					input: ["text" as const, "image" as const],
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
			} catch {
				// The selected model may be a runtime-only model; leave persisted config unchanged.
			}
		});

		// 2. Register L1 learner tools
		const learnerTools = createLearnerTools(paths.learnerDataDir, "default");
		for (const tool of learnerTools) {
			pi.registerTool(tool);
		}

		// 3. Register scheduler tools
		const jobStore = new JobStore(paths.jobsDir);
		const schedulerTools = createSchedulerTools(jobStore, channelRegistry);
		for (const tool of schedulerTools) {
			pi.registerTool(tool);
		}

		// 4. Register L2 Wiki memory tools
		const l2Tools = createL2Tools(paths.l2DataDir);
		for (const tool of l2Tools) {
			pi.registerTool(tool);
		}

		// 4a. Register L3 cross-conversation memory (sqlite-backed recall)
		const l3Memory = new L3Memory(paths.l3DataDir, paths.sessionDir);
		const l3Tools = createL3Tools(l3Memory, deps?.getCurrentSessionId);
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

		// 5. Inject L1 context and custom system prompt before each agent turn
			pi.on("before_agent_start", async (event, ctx) => {
				const profile = loadProfile(paths.learnerDataDir);
				const recentEvents = loadEvents(paths.learnerDataDir).slice(-8);
				const contextPack = buildContextPack(profile, recentEvents);
				const contextSection = formatContextPackForPrompt(contextPack);

				const sections: string[] = [INNO_SYSTEM_PROMPT, contextSection];

				// Inject per-workspace context: agent.md + private skills.
				const workspaceDir = resolveActiveWorkspaceDir(paths, deps);
				sections.push(...buildWorkspaceContextSections(workspaceDir));

				// Inject threshold-gated cross-conversation recall (L3). Only
				// injects when past snippets clear the relevance threshold, so
				// unrelated turns stay clean.
				try {
					let currentSessionId = "";
					const sessionFile = ctx.sessionManager.getSessionFile?.();
					if (sessionFile) currentSessionId = sessionFile.split(/[\\/]/).pop() ?? "";
					if (!currentSessionId && deps?.getCurrentSessionId) currentSessionId = deps.getCurrentSessionId();
					const recalled = await l3Memory.recall(event.prompt, currentSessionId || undefined);
					const recallSection = formatRecallForPrompt(recalled);
					if (recallSection) sections.push(recallSection);
				} catch {
					// best-effort — recall failures must not block the turn
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
					} catch {
						// best-effort
					}
				}

				sections.push(event.systemPrompt);

				return {
					systemPrompt: sections.join("\n\n"),
				};
		});

		// 6. Custom startup header
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

		// 6b. Incrementally index the active session into L3 after each turn, so
		// the just-finished exchange becomes recallable in future conversations.
		pi.on("turn_end", async (_event, ctx) => {
			try {
				const sessionFile = ctx.sessionManager.getSessionFile?.();
				const sessionId = sessionFile ? sessionFile.split(/[\\/]/).pop() ?? "" : "";
				if (sessionId) await l3Memory.indexById(sessionId);
			} catch {
				// best-effort — indexing must not affect the turn
			}
		});

		// 7. Register pi-subagents extension (when enabled)
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
				console.warn(`[inno] Failed to load pi-subagents: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		// 8. Register ask_user_question tool with TUI / Web dual path
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
					const bridgeResult = await questionBridge.ask(typed);
					return buildQuestionnaireResponse(bridgeResult, typed);
				},
			} as Parameters<typeof pi.registerTool>[0]);
		} catch (err) {
			console.warn(`[inno] Failed to register ask_user_question: ${err instanceof Error ? err.message : String(err)}`);
		}
	};
}
