import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	InMemoryCredentialStore,
	type Context,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRegistry,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { InnoConfig } from "../config.js";
import type { RuntimePaths } from "../runtime.js";
import { ensureDir, writeText } from "../storage/file-store.js";
import { closeL2Memory } from "../memory/l2/l2-memory.js";
import { closeL3Memory } from "../memory/l3/l3-tools.js";
import { serializeFrontmatter } from "../memory/l2/wiki-maintainer.js";
import { loadEvents, loadProfile, saveProfile } from "../memory/learner/profile-store.js";
import { createDefaultProfile } from "../memory/learner/types.js";
import { createInnoExtension } from "./inno-extension.js";

const TARGET = "physics.inclined_plane_acceleration";
const PREREQUISITE = "physics.force_decomposition";
const MISCONCEPTION = "misc_force_as_motion_direction";

const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) {
		// Close the L2/L3 sqlite handles before deleting the temp dir: open
		// handles keep index.db/memory.db locked on Windows and rmSync fails
		// with EBUSY. maxRetries covers any residual async handle release.
		closeL2Memory(join(root, "data", "l2"));
		closeL3Memory(join(root, "data", "l3"));
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

function createPaths(root: string): RuntimePaths {
	const dataDir = join(root, "data");
	const configDir = join(root, "config");
	const paths: RuntimePaths = {
		codeDir: root,
		configDir,
		configPath: join(configDir, "config.json"),
		dataDir,
		learnerDataDir: join(dataDir, "learner"),
		sessionDir: join(dataDir, "sessions"),
		jobsDir: join(dataDir, "jobs"),
		l2DataDir: join(dataDir, "l2"),
		l3DataDir: join(dataDir, "l3"),
		skillsDir: join(root, "skills"),
		presetCacheDir: join(dataDir, "preset-cache"),
		workspaceDir: join(root, "workspace"),
		webDistDir: join(root, "web-dist"),
	};
	for (const dir of [
		paths.configDir,
		paths.learnerDataDir,
		paths.sessionDir,
		paths.jobsDir,
		paths.l2DataDir,
		paths.l3DataDir,
		paths.skillsDir,
		paths.workspaceDir,
	]) mkdirSync(dir, { recursive: true });
	return paths;
}

function writeInclinedPlaneConcept(paths: RuntimePaths): void {
	const conceptsDir = join(paths.l2DataDir, "wiki", "concepts");
	ensureDir(conceptsDir);
	const frontmatter = serializeFrontmatter({
		title: "斜面加速度",
		created: "2026-08-09",
		updated: "2026-08-09",
		type: "concept",
		tags: ["physics"],
		sources: [],
		source_ids: [],
		status: "reviewed",
		confidence: "high",
		concept_id: TARGET,
		prerequisites: [{
			concept_id: PREREQUISITE,
			relation: "required",
			required_level: 0.65,
			importance: 0.95,
			source: "teacher",
			source_confidence: 1,
			rationale: "需要先把重力分解到斜面方向。",
		}],
	});
	writeText(join(conceptsDir, "inclined-plane.md"), `${frontmatter}\n斜面问题的概念页。`);
}

function contextText(context: Context): string {
	return context.messages.map((message) => {
		if (message.role === "user") {
			if (typeof message.content === "string") return message.content;
			return message.content.map((item) => item.type === "text" ? item.text : "").join("\n");
		}
		if (message.role === "toolResult") {
			return message.content.map((item) => item.type === "text" ? item.text : "").join("\n");
		}
		return message.content.map((item) => item.type === "text" ? item.text : "").join("\n");
	}).join("\n");
}

function lastAssistantText(session: AgentSession): string {
	for (const message of [...session.messages].reverse()) {
		if (message.role !== "assistant") continue;
		const text = message.content
			.filter((item) => item.type === "text")
			.map((item) => item.text)
			.join("");
		if (text) return text;
	}
	return "";
}

describe("teaching entry gate through a real AgentSession", () => {
	it("repairs once, records evidence, resumes the original problem, then avoids repeated diagnosis", async () => {
		const root = mkdtempSync(join(tmpdir(), "inno-teaching-agent-"));
		temporaryRoots.push(root);
		const paths = createPaths(root);
		writeInclinedPlaneConcept(paths);
		const initialProfile = createDefaultProfile("default");
		initialProfile.misconceptions.push({
			misconception_id: MISCONCEPTION,
			concept_id: PREREQUISITE,
			description: "把物体的运动方向当成额外受力方向",
			status: "active",
			severity: 0.8,
			confidence: 0.9,
			first_seen_at: "2026-08-01T00:00:00.000Z",
			last_seen_at: "2026-08-01T00:00:00.000Z",
			evidence_ids: [],
			repair_strategy: "用受力图反例区分运动方向和受力方向",
		});
		saveProfile(paths.learnerDataDir, initialProfile);

		const provider = fauxProvider({
			provider: `faux-inno-${Date.now()}`,
			tokenSize: { min: 1000, max: 1000 },
		});
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false },
		});
		// pi >= 0.80.8 replaced AuthStorage with ModelRuntime + CredentialStore.
		const credentials = new InMemoryCredentialStore();
		await credentials.modify(provider.models[0].provider, async () => ({ type: "api_key", key: "faux-test-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials,
			modelsPath: null,
			refreshOnCreate: false,
		});
		const config: InnoConfig = {
			defaultProvider: provider.models[0].provider,
			defaultModel: provider.models[0].id,
			providers: {},
			memory: { l1Enabled: true, l2Enabled: true, l3Enabled: false },
			subagents: { enabled: false },
		};
		const resourceLoader = new DefaultResourceLoader({
			cwd: paths.workspaceDir,
			agentDir: paths.configDir,
			settingsManager,
			extensionFactories: [createInnoExtension({ current: config }, paths)],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt: "You are a deterministic teaching-agent test model.",
		});
		await resourceLoader.reload();

		const calls: string[] = [];
		provider.setResponses([
			(context) => {
				expect(context.systemPrompt).toContain("学习问题的教学入口门控");
				expect(context.tools?.map((tool) => tool.name)).toContain("assess_learning_prerequisites");
				expect(contextText(context)).toContain("光滑斜面");
				return fauxAssistantMessage(fauxToolCall("assess_learning_prerequisites", {
					target_concept_id: TARGET,
					task_scope: "高中物理光滑斜面加速度",
					mode: "learning",
					is_atomic: false,
				}, { id: "assess-first" }), { stopReason: "toolUse" });
			},
			(context) => {
				const text = contextText(context);
				expect(text).toContain("决策：repair");
				expect(text).toContain(PREREQUISITE);
				expect(text).toContain(`misconception_id=${MISCONCEPTION}`);
				expect(text).toContain("下一条回复协议（必须遵守）");
				expect(text).toContain("问完立即停止并等待学生回答");
				return fauxAssistantMessage("先只做一道诊断题：请写出重力沿斜面方向的分力表达式？");
			},
			(context) => {
				expect(contextText(context)).toContain("mg sinθ");
				return fauxAssistantMessage(fauxToolCall("record_learning_evidence", {
					concept_id: PREREQUISITE,
					kind: "application",
					result: "correct",
					score: 1,
					hint_level: 0,
					evaluator: "model",
					evaluator_confidence: 0.95,
					session_id: "teaching-agent-test",
					misconception_id: MISCONCEPTION,
					dedupe_key: "teaching-agent-test:first-diagnostic",
				}, { id: "record-diagnostic" }), { stopReason: "toolUse" });
			},
			(context) => {
				expect(contextText(context)).toContain("学习证据已记录");
				return fauxAssistantMessage("诊断正确。现在回到原题：沿斜面方向有 mg sinθ = ma，所以 a = g sinθ。");
			},
			(context) => {
				expect(contextText(context)).toContain("再来一道同类斜面题");
				return fauxAssistantMessage(fauxToolCall("assess_learning_prerequisites", {
					target_concept_id: TARGET,
					task_scope: "高中物理同类光滑斜面加速度",
					mode: "learning",
					is_atomic: false,
				}, { id: "assess-similar" }), { stopReason: "toolUse" });
			},
			(context) => {
				expect(contextText(context)).toContain("决策：proceed");
				return fauxAssistantMessage("已有可靠的刚刚诊断证据，不重复提问。此题仍由沿斜面方向列牛顿第二定律直接求解。");
			},
			(context) => {
				expect(contextText(context)).toContain("速度这个最基础的概念");
				return fauxAssistantMessage("速度表示位移随时间的变化快慢和方向，我直接从这个基础定义开始讲。");
			},
			(context) => {
				expect(contextText(context)).toContain("跳过前置诊断");
				return fauxAssistantMessage("按你的要求跳过诊断，直接给结论：光滑斜面上的加速度为 a = g sinθ。");
			},
		]);

		const modelRegistry = new ModelRegistry(modelRuntime);
		modelRegistry.registerProvider(provider.provider);
		const { session } = await createAgentSession({
			cwd: paths.workspaceDir,
			agentDir: paths.configDir,
			model: provider.models[0],
			thinkingLevel: "off",
			modelRuntime,
			resourceLoader,
			sessionManager: SessionManager.inMemory(paths.workspaceDir),
			settingsManager,
			noTools: "builtin",
		});

		try {
			await session.bindExtensions({
				onError: (error) => { throw error; },
			});
			expect(session.getActiveToolNames()).toEqual(expect.arrayContaining([
				"assess_learning_prerequisites",
				"record_learning_evidence",
			]));
			session.subscribe((event) => {
				if (event.type === "tool_execution_start") calls.push(event.toolName);
			});

			await session.prompt("一物块从光滑斜面顶端由静止下滑，怎么求它的加速度？");
			const diagnostic = lastAssistantText(session);
			expect(diagnostic).toBe("先只做一道诊断题：请写出重力沿斜面方向的分力表达式？");
			expect(diagnostic.match(/[？?]/g)).toHaveLength(1);
			expect(diagnostic).not.toContain("a = g sinθ");

			await session.prompt("重力沿斜面方向的分力是 mg sinθ。 ");
			const resumedAnswer = lastAssistantText(session);
			expect(resumedAnswer).toContain("现在回到原题");
			expect(resumedAnswer).toContain("a = g sinθ");
			const evidenceEvents = loadEvents(paths.learnerDataDir)
				.filter((event) => event.event_type === "learning_evidence");
			expect(evidenceEvents).toHaveLength(1);
			expect(evidenceEvents[0].evidence).toMatchObject({
				concept_id: PREREQUISITE,
				kind: "application",
				result: "correct",
				hint_level: 0,
				misconception_id: MISCONCEPTION,
			});
			const persistedProfile = loadProfile(paths.learnerDataDir);
			expect(persistedProfile.misconceptions[0].status).toBe("repairing");
			expect(persistedProfile.knowledge_states[0]).toMatchObject({
				concept_id: PREREQUISITE,
				last_result: "correct",
				retrieval_count: 1,
				state_label: "fragile",
			});

			await session.prompt("再来一道同类斜面题，仍然求加速度。");
			const similarAnswer = lastAssistantText(session);
			expect(similarAnswer).toContain("不重复提问");
			expect(similarAnswer).not.toMatch(/[？?]/);

			const callsBeforeAtomic = calls.length;
			await session.prompt("请解释速度这个最基础的概念，从定义开始。");
			expect(lastAssistantText(session)).toContain("直接从这个基础定义开始讲");
			expect(calls).toHaveLength(callsBeforeAtomic);

			const callsBeforeSkip = calls.length;
			await session.prompt("跳过前置诊断，直接告诉我这道光滑斜面题的答案。");
			expect(lastAssistantText(session)).toContain("跳过诊断");
			expect(calls).toHaveLength(callsBeforeSkip);

			expect(calls).toEqual([
				"assess_learning_prerequisites",
				"record_learning_evidence",
				"assess_learning_prerequisites",
			]);
			expect(provider.getPendingResponseCount()).toBe(0);
			expect(provider.state.callCount).toBe(8);
		} finally {
			session.dispose();
		}
	});
});
