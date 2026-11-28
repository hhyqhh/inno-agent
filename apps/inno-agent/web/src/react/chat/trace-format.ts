import type { TFunction } from "i18next";
import type { ChatTraceStep, ChatTraceStepStatus } from "../../types/chat.js";
import { isOpenStatus, type ChatTraceTerminalState } from "../../utils/chat-trace.js";

export function formatDuration(durationMs: number | undefined, t: TFunction): string {
	if (durationMs === undefined) return "";
	// Rounded sub-second durations used to read as “持续了 0 秒”.
	if (durationMs < 1_000) return t("chat.trace.durationLessThanSecond", "<1 秒");
	const seconds = Math.max(0, Math.round(durationMs / 1000));
	return t("chat.trace.durationSeconds", "{{seconds}} 秒", { seconds });
}

export function liveDuration(startedAt: number | undefined, endedAt: number | undefined, now: number): number | undefined {
	if (startedAt === undefined) return undefined;
	return Math.max(0, (endedAt ?? now) - startedAt);
}

export function stepDuration(step: ChatTraceStep, now: number): number | undefined {
	if (step.durationMs !== undefined) return step.durationMs;
	return isOpenStatus(step.status) ? liveDuration(step.startedAt, step.endedAt, now) : undefined;
}

export function compactText(value: string, max = 180): string {
	const compacted = value.replace(/[`*_#>|\[\]()]/g, "").replace(/\s+/g, " ").trim();
	return compacted.length > max ? `${compacted.slice(0, max - 1)}…` : compacted;
}

export function firstTarget(value: unknown, depth = 0): string | undefined {
	if (depth > 4 || value == null) return undefined;
	if (typeof value === "string") {
		const text = value.trim();
		if (!text || text.length > 260 || text.includes("\n")) return undefined;
		return text;
	}
	if (typeof value !== "object") return undefined;
	if (Array.isArray(value)) {
		for (const item of value) {
			const target = firstTarget(item, depth + 1);
			if (target) return target;
		}
		return undefined;
	}
	const record = value as Record<string, unknown>;
	for (const key of [
		"path", "filePath", "file_path", "filename", "fileName", "targetPath", "target_path",
		"query", "pattern", "command", "cmd", "url", "name", "title",
	]) {
		const target = record[key];
		if (typeof target === "string" && target.trim()) return target.trim();
	}
	for (const child of Object.values(record)) {
		const target = firstTarget(child, depth + 1);
		if (target) return target;
	}
	return undefined;
}

export function textFromToolPayload(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	if (Array.isArray(record.content)) {
		const text = record.content
			.map((item) => item && typeof item === "object" && typeof (item as Record<string, unknown>).text === "string"
				? (item as Record<string, string>).text
				: "")
			.filter(Boolean)
			.join("\n");
		if (text.trim()) return text;
	}
	if (typeof record.text === "string" && record.text.trim()) return record.text;
	return undefined;
}

export function liveToolText(value: unknown): string | undefined {
	const text = textFromToolPayload(value);
	if (!text) return undefined;
	const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	const lastLine = lines.at(-1);
	return lastLine ? compactText(lastLine, 96) : undefined;
}

function isDiagnosticSummary(value?: string): boolean {
	return Boolean(value?.trim() && /(abort|aborted|cancel|cancelled|canceled|fail|failed|error|timeout|错误|失败|中断|取消|停止)/i.test(value));
}

export function localizedStepTitle(step: ChatTraceStep, t: TFunction): string {
	if (step.kind === "system" && step.summary?.trim() && isDiagnosticSummary(step.summary)) return step.title;
	return step.titleKey ? t(step.titleKey, step.title, step.titleParams) : step.title;
}

export function toolSummary(step: ChatTraceStep, t: TFunction): string {
	const toolName = step.toolName?.trim() || localizedStepTitle(step, t);
	const officeActions: Record<string, string> = {
		office_create_document: t("chat.trace.tools.officeCreate", "创建文档"),
		office_open_document: t("chat.trace.tools.officeOpen", "打开文档"),
		office_edit_document: t("chat.trace.tools.officeEdit", "编辑文档"),
		office_render_document: t("chat.trace.tools.officeRender", "检查文档排版"),
		office_close_document: t("chat.trace.tools.officeClose", "关闭文档"),
		office_engine_status: t("chat.trace.tools.officeStatus", "检查文档引擎"),
	};
	const target = firstTarget(step.args) ?? firstTarget(step.argsText);
	const live = step.status === "running" ? liveToolText(step.partialResult) : undefined;
	return [
		officeActions[toolName] ?? toolName,
		target ? compactText(target, 120) : undefined,
		live && live !== target ? live : undefined,
	].filter(Boolean).join(" · ") || t("chat.trace.tool", "工具");
}

export function thinkingSummary(step: ChatTraceStep, durationMs: number | undefined, t: TFunction): string {
	if (step.status === "completed") {
		return durationMs !== undefined
			? `${t("chat.trace.thinking.completed", "思考完成")} · ${t("chat.trace.duration", "持续了 {{duration}}", { duration: formatDuration(durationMs, t) })}`
			: t("chat.trace.thinking.completed", "思考完成");
	}
	return [
		t("chat.trace.thinking.inProgress", "思考中"),
		durationMs !== undefined ? t("chat.trace.duration", "持续了 {{duration}}", { duration: formatDuration(durationMs, t) }) : undefined,
	].filter(Boolean).join(" · ");
}

export function statusLabel(status: ChatTraceStepStatus, t: TFunction): string {
	switch (status) {
		case "preparing": return t("chat.trace.status.preparing", "准备调用");
		case "running": return t("chat.trace.status.running", "执行中");
		case "waiting": return t("chat.trace.status.waiting", "等待你的回答");
		case "error": return t("chat.trace.status.error", "失败");
		case "completed": return t("chat.trace.status.completed", "已完成");
		default: return t("chat.trace.status.active", "进行中");
	}
}

function isUserPauseReason(value?: string): boolean {
	if (!value?.trim()) return false;
	return /(stopped by user|cancel(?:led|ed)? by user|user (?:stopped|cancel(?:led|ed)?)|用户(?:主动)?(?:暂停|停止|取消)|主动(?:暂停|停止|取消))/i.test(value);
}

function failureStepFor(steps: ChatTraceStep[]): ChatTraceStep | undefined {
	return [...steps].reverse().find((step) => {
		if (step.kind === "error") return true;
		if (step.kind !== "system") return false;
		if (step.status === "error") return true;
		const searchable = [step.title, step.summary, step.text, step.eventType]
			.filter(Boolean)
			.join(" ");
		return /(terminal event|stopreason\s*:\s*error|error|错误|失败|中断|取消|停止)/i.test(searchable);
	});
}

export function workStatusText(
	isSending: boolean,
	terminalState: ChatTraceTerminalState | undefined,
	steps: ChatTraceStep[],
	t: TFunction,
	error?: string,
): string {
	if (isSending) return t("chat.trace.working", "工作中");
	if (terminalState?.status === "completed") return t("chat.trace.completed", "已完成");
	if (terminalState?.status === "aborted") {
		return isUserPauseReason(terminalState.reason)
			? t("chat.trace.workStatus.userPaused", "用户主动暂停")
			: t("chat.trace.workStatus.interrupted", "因其他原因中断");
	}
	if (terminalState?.status === "error") return t("chat.trace.workStatus.interrupted", "因其他原因中断");

	const failureStep = failureStepFor(steps);
	const reason = [error, failureStep?.title, failureStep?.text, failureStep?.summary]
		.filter(Boolean)
		.join(" ");
	if (!reason) {
		return terminalState?.status === "unknown"
			? t("chat.trace.workStatus.incomplete", "未完成 · 原因未知")
			: t("chat.trace.completed", "已完成");
	}
	return isUserPauseReason(reason)
		? t("chat.trace.workStatus.userPaused", "用户主动暂停")
		: t("chat.trace.workStatus.interrupted", "因其他原因中断");
}

export function rowSummary(step: ChatTraceStep, durationMs: number | undefined, t: TFunction): string {
	const title = localizedStepTitle(step, t);
	if (step.kind === "thinking") return thinkingSummary(step, durationMs, t);
	if (step.kind === "progress") return compactText(step.text ?? title) || t("chat.trace.steps.progress", "进度");
	if (step.kind === "tool") {
		const summary = toolSummary(step, t);
		if (step.status === "error") return `${t("chat.trace.status.error", "失败")} · ${summary}`;
		if (step.status === "preparing" || step.status === "running") return `${t("chat.trace.status.running", "执行中")} · ${summary}`;
		if (step.status === "waiting") return t("chat.trace.status.waiting", "等待你的回答");
		return summary;
	}
	return title;
}

export function shimmerTitleFor(step: ChatTraceStep, t: TFunction): string | undefined {
	if (step.kind === "thinking" && step.status === "active") return t("chat.trace.thinking.inProgress", "思考中");
	if (step.kind === "tool" && (step.status === "active" || step.status === "preparing" || step.status === "running" || step.status === "waiting")) {
		return step.toolName?.trim() || localizedStepTitle(step, t);
	}
	return undefined;
}

export function workspaceChangeLabel(change: string, t: TFunction): string {
	const key = {
		created: "chat.trace.workspaceChanges.created",
		modified: "chat.trace.workspaceChanges.modified",
		deleted: "chat.trace.workspaceChanges.deleted",
	}[change];
	return key ? t(key, change) : change;
}

export function pendingQuestionTraceStep(questionId: string): ChatTraceStep {
	return {
		id: `tool:ask_user_question:${questionId}`,
		kind: "tool",
		status: "waiting",
		title: "等待你的回答",
		titleKey: "chat.trace.steps.waitingForAnswer",
		toolCallId: questionId,
		toolName: "ask_user_question",
		questionId,
	};
}
