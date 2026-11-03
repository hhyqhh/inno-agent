import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { L3Memory } from "../memory/l3/l3-tools.js";
import { formatSkillGeneratorMethods, isSkillGeneratorMethod, type SkillGeneratorMethod } from "./methods.js";
import { extractSessionTrace, formatSkillTraces, type SkillTrace } from "./trace.js";
import { inspectGeneratedSkill, saveGeneratedSkill } from "./store.js";

type SkillScope = "global" | "workspace";

export interface SkillGeneratorToolDeps {
	dataDir: string;
	sessionDir: string;
	skillsDir: string;
	l3Memory: L3Memory;
	isL3Enabled: () => boolean;
	getWorkspaceDir: () => string;
	onSkillsChanged?: () => void;
}

const ScopeSchema = Type.Union([Type.Literal("global"), Type.Literal("workspace")], {
	description: "global 写入全局 skills 目录；workspace 写入当前工作区 .skills。",
	default: "global",
});

function listSkillNames(rootDir: string): string[] {
	if (!existsSync(rootDir)) return [];
	try {
		return readdirSync(rootDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && existsSync(join(rootDir, entry.name, "SKILL.md")))
			.map((entry) => entry.name)
			.sort()
			.slice(0, 100);
	} catch {
		return [];
	}
}

function textResult(text: string, details: Record<string, unknown>) {
	return { content: [{ type: "text" as const, text }], details };
}

export function createSkillGeneratorTools(deps: SkillGeneratorToolDeps): ToolDefinition[] {
	const rootFor = (scope: SkillScope) => scope === "workspace" ? join(deps.getWorkspaceDir(), ".skills") : deps.skillsDir;

	const inspectTool = defineTool({
		name: "skill_generator_inspect",
		label: "检查技能生成器与现有技能",
		description: "技能生成器入口。无 name 时列出四种生成方法和已有技能；提供 name 时读取原 SKILL.md 与生成元数据，供 evolution 修订。",
		parameters: Type.Object({
			name: Type.Optional(Type.String({ description: "现有技能的小写连字符名称；不填则列出方法和使用方式。" })),
			scope: Type.Optional(ScopeSchema),
		}),
		async execute(_toolCallId, params) {
			const typed = params as { name?: string; scope?: SkillScope };
			const scope = typed.scope ?? "global";
			const rootDir = rootFor(scope);
			if (!typed.name) {
				const names = listSkillNames(rootDir);
				return textResult([
					"四种技能生成方法：",
					formatSkillGeneratorMethods(),
					`当前 ${scope} 技能：${names.length ? names.join(", ") : "(无)"}`,
					"使用 skill_trace_extract 获取轨迹证据；草案经用户确认后用 skill_generator_save 保存。",
				].join("\n\n"), { methods: ["guided", "trace", "evolution", "hybrid"], scope, skills: names });
			}
			try {
				const snapshot = inspectGeneratedSkill(rootDir, typed.name);
				if (!snapshot) return textResult(`未在 ${scope} 找到技能 ${typed.name}。`, { found: false, scope, name: typed.name });
				return textResult([
					`技能 ${snapshot.name} (${scope})`,
					`生成元数据：${snapshot.metadata ? JSON.stringify(snapshot.metadata, null, 2) : "(非生成器创建，无元数据；首次修订将记为 v1)"}`,
					"原 SKILL.md：",
					snapshot.content,
				].join("\n\n"), { found: true, scope, ...snapshot });
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), { found: false, scope, name: typed.name });
			}
		},
	});

	const traceTool = defineTool({
		name: "skill_trace_extract",
		label: "提取人机交互轨迹",
		description: "从当前会话或 L3 历史会话提取脱敏的用户意图、工具调用、结果和纠错，用于 Trace-to-Skill。不要用于回答普通历史问题。",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "历史轨迹检索关键词；不提供时分析当前会话。" })),
			sessionId: Type.Optional(Type.String({ description: "明确指定会话 ID（可省略 .jsonl），优先于 query。" })),
			includeCurrent: Type.Optional(Type.Boolean({ description: "历史检索时是否允许包含当前会话，默认 false。", default: false })),
			maxSessions: Type.Optional(Type.Number({ description: "最多分析会话数，1–5，默认 2。", default: 2 })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const typed = params as { query?: string; sessionId?: string; includeCurrent?: boolean; maxSessions?: number };
			const maxSessions = Math.max(1, Math.min(5, Math.floor(typed.maxSessions ?? 2)));
			const currentFile = ctx.sessionManager.getSessionFile?.();
			const currentId = currentFile ? basename(currentFile) : "";
			let candidateIds: string[] = [];

			if (typed.sessionId?.trim()) {
				candidateIds = [typed.sessionId.trim()];
			} else if (typed.query?.trim()) {
				if (!deps.isL3Enabled()) return textResult("历史轨迹检索依赖 L3，当前已在设置中关闭。可以分析当前会话，或请用户开启 L3。", { traces: [], disabled: true });
				const hits = await deps.l3Memory.searchLexical(typed.query.trim(), maxSessions * 4);
				candidateIds = [...new Set((hits ?? []).map((hit) => hit.sessionId))]
					.filter((id) => typed.includeCurrent || id !== currentId)
					.slice(0, maxSessions * 2);
			} else if (currentId) {
				candidateIds = [currentId];
			}

			if (candidateIds.length === 0) return textResult("没有可分析的会话轨迹。请先完成一次演示，或提供历史检索关键词/会话 ID。", { traces: [] });
			const traces: SkillTrace[] = [];
			for (const id of candidateIds) {
				const trace = await extractSessionTrace(deps.dataDir, deps.sessionDir, id);
				if (trace && trace.steps.length > 0) traces.push(trace);
			}
			traces.sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt));
			const selected = traces.slice(0, maxSessions);
			if (selected.length === 0) return textResult("未找到可读取的有效轨迹；会话可能不存在或没有可见消息。", { traces: [], candidates: candidateIds });
			return textResult(formatSkillTraces(selected), { traces: selected });
		},
	});

	const saveTool = defineTool({
		name: "skill_generator_save",
		label: "确认后保存生成技能",
		description: "把经用户确认的 SKILL.md 写入现有全局/工作区技能体系。修订会自动备份旧版本；禁止未经确认调用。",
		parameters: Type.Object({
			name: Type.String({ description: "技能目录名，也是 frontmatter name；小写字母/数字/连字符。" }),
			content: Type.String({ description: "完整 SKILL.md，含 name/description frontmatter 和可执行正文。" }),
			method: Type.Union([
				Type.Literal("guided"), Type.Literal("trace"), Type.Literal("evolution"), Type.Literal("hybrid"),
			], { description: "实际采用的生成方法。" }),
			operation: Type.Optional(Type.Union([Type.Literal("create"), Type.Literal("revise")], { description: "evolution 默认 revise，其余默认 create。" })),
			scope: Type.Optional(ScopeSchema),
			confirmed: Type.Boolean({ description: "只有用户在 ask_user_question 中明确选择保存后才为 true。" }),
			evidence: Type.Optional(Type.Array(Type.String(), { description: "证据引用，如 session.jsonl [S03] 或 guided questionnaire。", maxItems: 20 })),
			feedback: Type.Optional(Type.String({ description: "驱动本次生成/演化的用户反馈摘要。" })),
			changeSummary: Type.Optional(Type.String({ description: "本次创建或修订的简短说明。" })),
		}),
		async execute(_toolCallId, params) {
			const typed = params as {
				name: string;
				content: string;
				method: SkillGeneratorMethod;
				operation?: "create" | "revise";
				scope?: SkillScope;
				confirmed: boolean;
				evidence?: string[];
				feedback?: string;
				changeSummary?: string;
			};
			if (!isSkillGeneratorMethod(typed.method)) return textResult("未知生成方法。", { saved: false });
			if (!typed.confirmed) return textResult("未保存：必须先在 ask_user_question 中获得用户的明确保存确认。", { saved: false, confirmationRequired: true });
			const scope = typed.scope ?? "global";
			const operation = typed.operation ?? (typed.method === "evolution" ? "revise" : "create");
			try {
				const result = saveGeneratedSkill({
					rootDir: rootFor(scope), name: typed.name, content: typed.content, method: typed.method,
					operation, confirmed: true, evidence: typed.evidence, feedback: typed.feedback, changeSummary: typed.changeSummary,
				});
				try { deps.onSkillsChanged?.(); } catch { /* reload remains available from the skills panel */ }
				return textResult([
					`已保存技能 ${result.name}，版本 v${result.version}，作用域 ${scope}。`,
					`文件：${result.filePath}`,
					result.backupPath ? `旧版本备份：${result.backupPath}` : "这是首个版本，无需备份。",
					"建议用一个具体任务试跑；后续反馈可再次通过 evolution 迭代。",
				].join("\n"), { saved: true, scope, operation, ...result });
			} catch (err) {
				return textResult(`未保存：${err instanceof Error ? err.message : String(err)}`, { saved: false, scope, operation, name: typed.name });
			}
		},
	});

	return [inspectTool, traceTool, saveTool];
}
