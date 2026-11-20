import type { TFunction } from "i18next";
import type { ChatTraceStep } from "../types/chat.js";
import { isOpenStatus } from "./chat-trace.js";

/**
 * WorkBuddy-style process folding. Runs of two or more consecutive process
 * steps (thinking / tool / skill) collapse into ONE line such as
 * "运行校验、查看文件：2026-11.md". Everything here is a pure function of the
 * trace steps so live streaming and history replay produce the same lines.
 * The verb table is client-side by design: the model only supplies raw tool
 * names and arguments.
 */

export type TraceGroup =
	| "read"
	| "search"
	| "research"
	| "modify"
	| "command"
	| "diagnostics"
	| "plan"
	| "collab"
	| "external"
	| "other";

export type TraceIconKind =
	| "read"
	| "modify"
	| "command"
	| "search"
	| "folder"
	| "web"
	| "plan"
	| "collab"
	| "skill"
	| "thinking"
	| "wrench";

interface ToolDescriptor {
	group: TraceGroup;
	/** Suffix of `chat.trace.summary.action.*`. */
	action: string;
	icon: TraceIconKind;
	/** Argument keys that name the target, in priority order. Empty = never show one. */
	objectFields: readonly string[];
}

const PATH_FIELDS = ["path", "file_path", "filePath", "file", "filename", "fileName", "name"] as const;

const DESCRIPTORS: Record<string, ToolDescriptor> = {
	read: { group: "read", action: "read", icon: "read", objectFields: PATH_FIELDS },
	read_file: { group: "read", action: "read", icon: "read", objectFields: PATH_FIELDS },
	ls: { group: "read", action: "list", icon: "folder", objectFields: ["path", "directory", "dir"] },
	find: { group: "search", action: "searchFile", icon: "search", objectFields: ["pattern", "query", "path"] },
	grep: { group: "search", action: "searchContent", icon: "search", objectFields: ["pattern", "query"] },
	write: { group: "modify", action: "write", icon: "modify", objectFields: PATH_FIELDS },
	edit: { group: "modify", action: "edit", icon: "modify", objectFields: PATH_FIELDS },
	bash: { group: "command", action: "command", icon: "command", objectFields: [] },
	web_search: { group: "research", action: "webSearch", icon: "web", objectFields: ["query"] },
	web_research: { group: "research", action: "webSearch", icon: "web", objectFields: ["query"] },
	fetch_content: { group: "research", action: "webFetch", icon: "web", objectFields: ["url", "query"] },
	get_search_content: { group: "research", action: "webFetch", icon: "web", objectFields: ["url", "query"] },
	l3_recall: { group: "search", action: "recall", icon: "search", objectFields: ["query"] },
	l2_query: { group: "search", action: "wikiQuery", icon: "search", objectFields: ["query", "question"] },
	l2_archive: { group: "modify", action: "archive", icon: "modify", objectFields: ["title", "path", "source"] },
	l2_lint: { group: "diagnostics", action: "lints", icon: "search", objectFields: [] },
	parse_document: { group: "read", action: "read", icon: "read", objectFields: PATH_FIELDS },
	ocr_image: { group: "read", action: "read", icon: "read", objectFields: PATH_FIELDS },
	todo: { group: "plan", action: "todo", icon: "plan", objectFields: [] },
	subagent: { group: "collab", action: "subtask", icon: "collab", objectFields: ["description", "agent", "task"] },
	office_create_document: { group: "modify", action: "create", icon: "modify", objectFields: PATH_FIELDS },
	office_edit_document: { group: "modify", action: "edit", icon: "modify", objectFields: PATH_FIELDS },
	office_open_document: { group: "read", action: "open", icon: "read", objectFields: PATH_FIELDS },
	office_render_document: { group: "diagnostics", action: "render", icon: "read", objectFields: PATH_FIELDS },
	use_skill: { group: "other", action: "skill", icon: "skill", objectFields: ["name", "skill"] },
};

const UNKNOWN: ToolDescriptor = { group: "other", action: "run", icon: "wrench", objectFields: ["path", "file_path", "filePath", "query", "url", "name"] };

function descriptorFor(toolName: string | undefined): { descriptor: ToolDescriptor; known: boolean } {
	const name = toolName?.trim().toLowerCase() ?? "";
	const direct = DESCRIPTORS[name];
	if (direct) return { descriptor: direct, known: true };
	if (name.startsWith("mcp_") || name.startsWith("mcp__")) {
		return { descriptor: { group: "external", action: "mcpCall", icon: "wrench", objectFields: ["toolName", "tool", "uri", "query"] }, known: true };
	}
	return { descriptor: UNKNOWN, known: false };
}

/** Icon for a single step, shared by single rows and the merged line. */
export function traceIconKind(step: ChatTraceStep): TraceIconKind {
	if (step.kind === "thinking") return "thinking";
	if (step.kind === "skill") return "skill";
	if (step.kind === "tool") return descriptorFor(step.toolName).descriptor.icon;
	return "wrench";
}

// --- Argument → short target ------------------------------------------------

function parseArgs(step: ChatTraceStep): Record<string, unknown> | undefined {
	if (step.args && typeof step.args === "object" && !Array.isArray(step.args)) return step.args as Record<string, unknown>;
	if (step.argsText?.trim()) {
		try {
			const parsed = JSON.parse(step.argsText);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
		} catch {
			// Partially streamed JSON: no target yet.
		}
	}
	return undefined;
}

const CJK = /[　-鿿＀-￯]/;

/** URL → host, path → basename, CJK → 16 chars, otherwise 6 words. */
export function compressObject(raw: string): string | undefined {
	const value = raw.trim();
	if (!value || value.includes("\n")) return undefined;
	if (/^https?:\/\//i.test(value)) {
		try {
			return new URL(value).host || undefined;
		} catch {
			return value.slice(0, 40);
		}
	}
	if (/[\\/]/.test(value) && !/\s/.test(value)) {
		const parts = value.split(/[\\/]/).filter(Boolean);
		return parts.at(-1) ?? undefined;
	}
	if (CJK.test(value)) {
		const chars = Array.from(value);
		return chars.length > 16 ? `${chars.slice(0, 16).join("")}…` : value;
	}
	const words = value.split(/\s+/);
	return words.length > 6 ? `${words.slice(0, 6).join(" ")}…` : value;
}

function objectFor(step: ChatTraceStep, descriptor: ToolDescriptor): string | undefined {
	if (!descriptor.objectFields.length) return undefined;
	if (step.kind === "skill") return step.skillName ? compressObject(step.skillName) : undefined;
	const args = parseArgs(step);
	if (!args) return undefined;
	for (const key of descriptor.objectFields) {
		const value = args[key];
		const text = typeof value === "string" ? value : Array.isArray(value) && typeof value[0] === "string" ? value[0] : undefined;
		const compact = text ? compressObject(text) : undefined;
		if (compact) return compact;
	}
	return undefined;
}

// --- Atoms and summary text -------------------------------------------------

interface TraceAtom {
	group: TraceGroup;
	action: string;
	object?: string;
	icon: TraceIconKind;
	toolName: string;
	known: boolean;
}

function atomFor(step: ChatTraceStep): TraceAtom | undefined {
	if (step.kind === "skill") {
		const { descriptor } = descriptorFor("use_skill");
		return { group: descriptor.group, action: descriptor.action, object: objectFor(step, descriptor), icon: "skill", toolName: "use_skill", known: true };
	}
	if (step.kind !== "tool") return undefined;
	const { descriptor, known } = descriptorFor(step.toolName);
	return {
		group: descriptor.group,
		action: descriptor.action,
		object: objectFor(step, descriptor),
		icon: descriptor.icon,
		toolName: step.toolName?.trim().toLowerCase() ?? "",
		known,
	};
}

const GROUP_FALLBACKS: Record<TraceGroup, { verb: string; topic: string; noTopic: string }> = {
	read: { verb: "查看文件", topic: "查看 {{topic}}", noTopic: "查看相关文件" },
	search: { verb: "定位代码", topic: "定位{{topic}}相关内容", noTopic: "搜索相关内容" },
	research: { verb: "收集资料", topic: "收集{{topic}}资料", noTopic: "收集资料" },
	modify: { verb: "修改", topic: "修改{{topic}}", noTopic: "修改文件" },
	command: { verb: "运行校验", topic: "运行 {{topic}}", noTopic: "运行命令" },
	diagnostics: { verb: "检查诊断", topic: "检查 {{topic}}", noTopic: "检查诊断" },
	plan: { verb: "整理计划", topic: "整理 {{topic}} 计划", noTopic: "整理计划" },
	collab: { verb: "协作分派", topic: "协作处理{{topic}}", noTopic: "协作分派" },
	external: { verb: "调用服务", topic: "获取 {{topic}}", noTopic: "调用外部服务" },
	other: { verb: "处理", topic: "处理{{topic}}", noTopic: "处理多个步骤" },
};

const ACTION_FALLBACKS: Record<string, string> = {
	read: "读取",
	list: "查看目录",
	open: "打开",
	searchFile: "查找文件",
	searchContent: "搜索代码",
	write: "写入",
	create: "创建",
	edit: "修改",
	archive: "归档",
	command: "运行命令",
	webSearch: "搜索资料",
	webFetch: "读取网页",
	recall: "回顾对话",
	wikiQuery: "检索知识库",
	lints: "检查",
	render: "检查排版",
	todo: "整理任务",
	subtask: "调用子任务",
	mcpCall: "调用 MCP",
	skill: "加载技能",
	run: "执行",
};

export interface TraceRunSummary {
	text: string;
	icon: TraceIconKind;
}

/** Most frequent tool wins; ties keep first-seen order. */
function dominantIcon(steps: ChatTraceStep[], atoms: TraceAtom[]): TraceIconKind {
	if (!atoms.length) return steps.some((step) => step.kind === "thinking") ? "thinking" : "wrench";
	const counts = new Map<string, { count: number; icon: TraceIconKind }>();
	for (const atom of atoms) {
		const entry = counts.get(atom.toolName) ?? { count: 0, icon: atom.icon };
		entry.count += 1;
		counts.set(atom.toolName, entry);
	}
	let best: { count: number; icon: TraceIconKind } | undefined;
	for (const entry of counts.values()) if (!best || entry.count > best.count) best = entry;
	return best?.icon ?? "wrench";
}

export function summarizeTraceRun(steps: ChatTraceStep[], t: TFunction): TraceRunSummary {
	const atoms = steps.flatMap((step) => {
		const atom = atomFor(step);
		return atom ? [atom] : [];
	});
	const icon = dominantIcon(steps, atoms);
	// Unknown tools without a target say nothing useful.
	const useful = atoms.filter((atom) => atom.known || atom.object);
	const verbOf = (group: TraceGroup) => t(`chat.trace.summary.verb.${group}`, GROUP_FALLBACKS[group].verb);
	const noTopicOf = (group: TraceGroup) => t(`chat.trace.summary.groupNoTopic.${group}`, GROUP_FALLBACKS[group].noTopic);
	const topicOf = (group: TraceGroup, topic: string) => t(`chat.trace.summary.group.${group}`, GROUP_FALLBACKS[group].topic, { topic });

	if (!useful.length) {
		const text = atoms.length || !steps.some((step) => step.kind === "thinking")
			? t("chat.trace.summary.fallback", "继续处理任务过程")
			: t("chat.trace.summary.thinkingOnly", "思考过程");
		return { text, icon };
	}

	if (useful.length === 1) {
		const [atom] = useful;
		if (atom.object) {
			const action = t(`chat.trace.summary.action.${atom.action}`, ACTION_FALLBACKS[atom.action] ?? ACTION_FALLBACKS.run);
			return { text: t("chat.trace.summary.single", "{{action}} {{object}}", { action, object: atom.object }), icon };
		}
		return { text: noTopicOf(atom.group), icon };
	}

	const sizes = new Map<TraceGroup, number>();
	for (const atom of useful) sizes.set(atom.group, (sizes.get(atom.group) ?? 0) + 1);
	// First object in original order; commands never contribute one.
	const topic = useful.find((atom) => atom.object)?.object;

	if (sizes.size === 1) {
		const [group] = [...sizes.keys()];
		return { text: topic ? topicOf(group, topic) : noTopicOf(group), icon };
	}

	// Array.prototype.sort is stable, so ties keep first-seen group order.
	const ranked = [...sizes.entries()].sort((a, b) => b[1] - a[1]).map(([group]) => group);
	if (topic) {
		return {
			text: t("chat.trace.summary.multiStage", "{{verb1}}、{{verb2}}：{{topic}}", { verb1: verbOf(ranked[0]), verb2: verbOf(ranked[1]), topic }),
			icon,
		};
	}
	if (sizes.size > 3) return { text: t("chat.trace.summary.categories", "{{count}} 类操作", { count: sizes.size }), icon };
	return { text: noTopicOf(ranked[0]), icon };
}

// --- Folding ----------------------------------------------------------------

export interface IndexedTraceStep {
	step: ChatTraceStep;
	index: number;
}

export type TraceFlowItem =
	| { type: "step"; step: ChatTraceStep; index: number }
	| { type: "run"; members: IndexedTraceStep[] };

/**
 * Only quiet, settled work is foldable. Open steps keep their live row (the
 * shimmer and partial output are the point), and question steps own cards
 * that are anchored to their row.
 */
export function isFoldableTraceStep(step: ChatTraceStep): boolean {
	if (step.kind !== "thinking" && step.kind !== "tool" && step.kind !== "skill") return false;
	if (isOpenStatus(step.status)) return false;
	if (step.questionId || step.toolName === "ask_user_question") return false;
	return true;
}

/**
 * Group consecutive foldable steps. A run of >= 2 folds when the turn is
 * finished or prose follows it, so the trailing run of a streaming turn stays
 * as individual rows. `isTextStep` marks the prose records that split runs.
 */
export function foldTraceFlow(
	flow: IndexedTraceStep[],
	finished: boolean,
	isTextStep: (step: ChatTraceStep) => boolean,
): TraceFlowItem[] {
	const items: TraceFlowItem[] = [];
	let lastTextPosition = -1;
	flow.forEach((entry, position) => {
		if (isTextStep(entry.step)) lastTextPosition = position;
	});
	let run: IndexedTraceStep[] = [];
	let runEnd = -1;
	const flush = () => {
		if (!run.length) return;
		if (run.length >= 2 && (finished || lastTextPosition > runEnd)) items.push({ type: "run", members: run });
		else for (const member of run) items.push({ type: "step", ...member });
		run = [];
	};
	flow.forEach((entry, position) => {
		if (isFoldableTraceStep(entry.step)) {
			run.push(entry);
			runEnd = position;
			return;
		}
		flush();
		items.push({ type: "step", ...entry });
	});
	flush();
	return items;
}

/** `5m44s`, `<1s`, `42s`, `1h5m`. Same in every locale, like WorkBuddy. */
export function formatCompactDuration(durationMs: number): string {
	if (durationMs < 1_000) return "<1s";
	const totalSeconds = Math.round(durationMs / 1_000);
	const hours = Math.floor(totalSeconds / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return minutes ? `${hours}h${minutes}m` : `${hours}h`;
	if (minutes > 0) return seconds ? `${minutes}m${seconds}s` : `${minutes}m`;
	return `${seconds}s`;
}
