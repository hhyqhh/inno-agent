import type {
	ChatStreamEvent,
	ChatToolRecord,
	ChatTraceEventRecord,
	ChatTraceStep,
	ChatTraceStepKind,
	ChatTraceStepStatus,
	WorkspaceFileChange,
} from "../types/chat.js";

type TraceTime = number | undefined;

export function parseTraceTime(value?: string | null): TraceTime {
	if (!value) return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function durationFor(startedAt: TraceTime, endedAt: TraceTime): number | undefined {
	if (startedAt === undefined || endedAt === undefined) return undefined;
	return Math.max(0, endedAt - startedAt);
}

export function safeJson(value: unknown): string {
	if (value === undefined) return "";
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

function parseJson(value: string | undefined): unknown {
	if (!value?.trim()) return undefined;
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}

export function isTextKind(kind: ChatTraceStepKind): boolean {
	return kind === "progress" || kind === "answer";
}

export function isOpenStatus(status: ChatTraceStepStatus): boolean {
	return status === "active" || status === "preparing" || status === "running" || status === "waiting";
}

const ACTIONABLE_SYSTEM_EVENTS = new Set(["auto_retry_start", "auto_retry_end"]);

/**
 * PI emits a useful event stream for recovery and debugging, but most of its
 * lifecycle bookkeeping is not a user-facing process step. Keep the raw
 * events in the sidecar and filter only at presentation time so history can
 * still be reconstructed without turning the chat into an event log.
 */
export function isTraceStepVisible(step: ChatTraceStep): boolean {
	if (step.kind !== "system") return true;
	if (step.workspaceChanges?.length) return true;
	if (step.status === "error") return true;
	const eventType = step.eventType?.toLowerCase();
	if (eventType && ACTIONABLE_SYSTEM_EVENTS.has(eventType)) return true;
	const searchable = [
		step.title,
		step.summary,
		step.text,
		step.eventType,
		step.eventDetail ? safeJson(step.eventDetail) : "",
	].filter(Boolean).join(" ");
	return /(abort|aborted|cancel|cancelled|canceled|fail|failed|error|错误|失败|中断|取消|停止)/i.test(searchable);
}

export function visibleTraceSteps(steps: ChatTraceStep[]): ChatTraceStep[] {
	return steps.filter(isTraceStepVisible);
}

export function hasVisibleTraceSteps(steps: ChatTraceStep[]): boolean {
	return steps.some((step) => step.kind !== "answer" && isTraceStepVisible(step));
}

function nextContentId(kind: "thinking" | "progress", steps: ChatTraceStep[]): string {
	const count = steps.filter((step) => step.kind === kind || (kind === "progress" && step.kind === "answer")).length;
	return `${kind}:auto:${count}`;
}

function findContentStepIndex(
	steps: ChatTraceStep[],
	kind: "thinking" | "progress",
	contentIndex?: number,
): number {
	for (let index = steps.length - 1; index >= 0; index -= 1) {
		const step = steps[index];
		if (!step || !isOpenStatus(step.status)) continue;
		if (kind === "thinking" && step.kind !== "thinking") continue;
		if (kind === "progress" && !isTextKind(step.kind)) continue;
		if (contentIndex !== undefined && step.contentIndex !== contentIndex) continue;
		return index;
	}
	return -1;
}

function reclassifyTextSteps(steps: ChatTraceStep[]): ChatTraceStep[] {
	let lastToolIndex = -1;
	for (let index = steps.length - 1; index >= 0; index -= 1) {
		if (steps[index]?.kind === "tool") {
			lastToolIndex = index;
			break;
		}
	}
	return steps.map((step, index) => {
		if (!isTextKind(step.kind)) return step;
		const kind: ChatTraceStepKind = lastToolIndex === -1 || index > lastToolIndex ? "answer" : "progress";
		return { ...step, kind };
	});
}

function createContentStep(
	steps: ChatTraceStep[],
	kind: "thinking" | "progress",
	contentIndex: number | undefined,
	at: TraceTime,
	phase: "start" | "update" = "start",
): ChatTraceStep {
	return {
		id: contentIndex === undefined ? nextContentId(kind, steps) : `${kind}:${contentIndex}`,
		kind,
		status: "active",
		title: kind === "thinking" ? "思考" : "正在组织回复",
		titleKey: kind === "thinking" ? "chat.trace.steps.thinking" : "chat.trace.steps.organizingReply",
		text: "",
		contentIndex,
		eventPhase: phase,
		...(at !== undefined ? { startedAt: at } : {}),
	};
}

function appendContent(
	steps: ChatTraceStep[],
	kind: "thinking" | "progress",
	delta: string,
	contentIndex?: number,
	at?: TraceTime,
): ChatTraceStep[] {
	if (!delta) return steps;
	const index = findContentStepIndex(steps, kind, contentIndex);
	const next = steps.slice();
		const current = index >= 0 ? next[index]! : createContentStep(next, kind, contentIndex, at, "update");
	const targetIndex = index >= 0 ? index : next.length;
	if (index < 0) next.push(current);
	next[targetIndex] = {
		...current,
		status: "active",
		text: `${current.text ?? ""}${delta}`,
		...(current.startedAt === undefined && at !== undefined ? { startedAt: at } : {}),
	};
	return reclassifyTextSteps(next);
}

function finishContent(
	steps: ChatTraceStep[],
	kind: "thinking" | "progress",
	contentIndex?: number,
	at?: TraceTime,
): ChatTraceStep[] {
	const index = findContentStepIndex(steps, kind, contentIndex);
	if (index < 0) return steps;
	const current = steps[index]!;
	const next = steps.slice();
	next[index] = {
		...current,
		status: "completed",
		eventPhase: "end",
		...(at !== undefined ? { endedAt: at } : {}),
		...(at !== undefined && current.startedAt !== undefined && current.eventPhase === "start"
			? { durationMs: durationFor(current.startedAt, at) }
			: {}),
	};
	return reclassifyTextSteps(next);
}

/**
 * Some providers omit thinking_end when they switch to the final answer.
 * Treat the next text/tool event as the boundary so a live thinking timer
 * cannot continue while the assistant is already producing the answer.
 */
function finishOpenThinking(steps: ChatTraceStep[], at?: TraceTime): ChatTraceStep[] {
	let changed = false;
	const next = steps.map((step) => {
		if (step.kind !== "thinking" || !isOpenStatus(step.status)) return step;
		changed = true;
		return {
			...step,
			status: "completed" as const,
			eventPhase: "end" as const,
			...(at !== undefined ? { endedAt: at } : {}),
			...(at !== undefined && step.startedAt !== undefined
				? { durationMs: durationFor(step.startedAt, at) }
				: {}),
		};
	});
	return changed ? next : steps;
}

function findToolIndex(steps: ChatTraceStep[], toolCallId: string): number {
	for (let index = steps.length - 1; index >= 0; index -= 1) {
		if (steps[index]?.kind === "tool" && steps[index]?.toolCallId === toolCallId) return index;
	}
	return -1;
}

function findOpenQuestionToolIndex(steps: ChatTraceStep[]): number {
	for (let index = steps.length - 1; index >= 0; index -= 1) {
		const step = steps[index];
		if (step?.kind === "tool" && step.toolName === "ask_user_question" && isOpenStatus(step.status)) return index;
	}
	return -1;
}

function ensureTool(
	steps: ChatTraceStep[],
	toolCallId: string,
	toolName: string,
	at?: TraceTime,
	args?: unknown,
	options: { forceNew?: boolean; createNewIfClosed?: boolean } = {},
): { steps: ChatTraceStep[]; index: number } {
	const existingIndex = findToolIndex(steps, toolCallId);
	const existing = existingIndex >= 0 ? steps[existingIndex] : undefined;
	const closed = existing ? existing.status === "completed" || existing.status === "error" : false;
	if (existingIndex >= 0 && !options.forceNew && !(options.createNewIfClosed && closed)) {
		const next = steps.slice();
		const current = next[existingIndex]!;
		next[existingIndex] = {
			...current,
			toolName: toolName || current.toolName,
			...(args !== undefined ? { args, argsText: safeJson(args) } : {}),
		};
		return { steps: next, index: existingIndex };
	}
	const previousAttempts = steps
		.filter((step) => step.kind === "tool" && step.toolCallId === toolCallId)
		.map((step) => step.attempt ?? 1);
	const attempt = previousAttempts.length > 0 ? Math.max(...previousAttempts) + 1 : undefined;
	const step: ChatTraceStep = {
		id: attempt === undefined ? `tool:${toolCallId}` : `tool:${toolCallId}:attempt:${attempt}`,
		kind: "tool",
		status: "preparing",
		title: toolName || "tool",
		toolCallId,
		toolName: toolName || "tool",
		...(args !== undefined ? { args, argsText: safeJson(args) } : {}),
		...(at !== undefined ? { preparationStartedAt: at } : {}),
		...(attempt !== undefined ? { attempt } : {}),
	};
	return { steps: [...steps, step], index: steps.length };
}

function updateToolArgs(
	steps: ChatTraceStep[],
	toolCallId: string,
	toolName: string,
	at?: TraceTime,
	args?: unknown,
	argsDelta?: string,
	options?: { forceNew?: boolean; createNewIfClosed?: boolean },
): ChatTraceStep[] {
	const ensured = ensureTool(steps, toolCallId, toolName, at, args, options);
	const next = ensured.steps.slice();
	const current = next[ensured.index]!;
	const argsText = args !== undefined
		? safeJson(args)
		: argsDelta
			? `${current.argsText ?? ""}${argsDelta}`
			: current.argsText;
	// Tool args are JSON objects, so a document can only be complete once the
	// accumulated text ends with a closing brace. Gating the parse attempt on
	// that cheap check avoids an O(n²) JSON.parse churn on every delta while
	// large tool arguments (e.g. file writes) stream in.
	const parsedArgs = args !== undefined
		? args
		: argsText?.trimEnd().endsWith("}")
			? parseJson(argsText)
			: undefined;
	next[ensured.index] = {
		...current,
		...(argsText !== undefined ? { argsText } : {}),
		...(parsedArgs !== undefined ? { args: parsedArgs } : {}),
	};
	return next;
}

function updateToolExecution(
	steps: ChatTraceStep[],
	event: Extract<ChatStreamEvent, { type: "tool_start" }>,
	at?: TraceTime,
): ChatTraceStep[] {
	const ensured = ensureTool(steps, event.toolCallId, event.toolName, at, event.args, { createNewIfClosed: true });
	const next = ensured.steps.slice();
	const current = next[ensured.index]!;
	next[ensured.index] = {
		...current,
		status: "running",
		toolName: event.toolName || current.toolName,
		...(event.args !== undefined ? { args: event.args, argsText: safeJson(event.args) } : {}),
		...(at !== undefined ? { startedAt: at } : {}),
	};
	return next;
}

function updateToolPartial(
	steps: ChatTraceStep[],
	event: Extract<ChatStreamEvent, { type: "tool_update" }>,
	at?: TraceTime,
): ChatTraceStep[] {
	const existingIndex = findToolIndex(steps, event.toolCallId);
	const existing = existingIndex >= 0 ? steps[existingIndex] : undefined;
	// A delayed update from a previous attempt must not reopen a completed row.
	if (existing && (existing.status === "completed" || existing.status === "error")) return steps;
	const ensured = ensureTool(steps, event.toolCallId, event.toolName, at, event.args);
	const next = ensured.steps.slice();
	const current = next[ensured.index]!;
	next[ensured.index] = {
		...current,
		status: "running",
		toolName: event.toolName || current.toolName,
		...(event.args !== undefined ? { args: event.args, argsText: safeJson(event.args) } : {}),
		...(event.partialResult !== undefined ? { partialResult: event.partialResult } : {}),
		...(current.startedAt === undefined && at !== undefined ? { startedAt: at } : {}),
	};
	return next;
}

function finishTool(
	steps: ChatTraceStep[],
	event: Extract<ChatStreamEvent, { type: "tool_end" }>,
	at?: TraceTime,
): ChatTraceStep[] {
	const ensured = ensureTool(steps, event.toolCallId, event.toolName, undefined, undefined, { createNewIfClosed: true });
	const next = ensured.steps.slice();
	const current = next[ensured.index]!;
	next[ensured.index] = {
		...current,
		status: event.isError ? "error" : "completed",
		result: event.result,
		isError: event.isError,
		...(at !== undefined ? { endedAt: at } : {}),
		...(at !== undefined && current.startedAt !== undefined
			? { durationMs: durationFor(current.startedAt, at) }
			: {}),
	};
	return next;
}

function addWorkspaceChanges(steps: ChatTraceStep[], changes: WorkspaceFileChange[], toolCallId?: string): ChatTraceStep[] {
	if (!changes.length) return steps;
	const index = toolCallId ? findToolIndex(steps, toolCallId) : -1;
	if (index < 0) {
		return [
			...steps,
			{
				id: `workspace:${steps.length}`,
					kind: "system",
					status: "completed",
					title: "工作区已更新",
					titleKey: "chat.trace.steps.workspaceUpdated",
					workspaceChanges: changes,
			},
		];
	}
	const next = steps.slice();
	const current = next[index]!;
	const previous = current.workspaceChanges ?? [];
	const seen = new Set(previous.map((change) => `${change.change}:${change.path}`));
	next[index] = {
		...current,
		workspaceChanges: [...previous, ...changes.filter((change) => !seen.has(`${change.change}:${change.path}`))],
	};
	return next;
}

function systemFamily(eventType: string): string {
	return eventType.replace(/_(start|end|update)$/i, "");
}

function systemTitle(eventType: string, summary?: string): string {
	if (summary?.trim()) return summary.trim();
	const labels: Record<string, string> = {
		before_agent_start: "准备 Agent",
		agent_start: "开始工作",
		agent_end: "结束工作",
		turn_start: "开始本轮任务",
		turn_end: "本轮任务结束",
		message_start: "开始生成消息",
		message_end: "消息生成完成",
		compaction_start: "正在整理上下文",
		compaction_end: "上下文整理完成",
		queue_start: "进入执行队列",
		queue_end: "离开执行队列",
		auto_retry_start: "正在自动重试",
		auto_retry_end: "自动重试结束",
		entry_appended: "已记录会话事件",
		bash_execution_update: "终端执行更新",
	};
	return labels[eventType] ?? eventType.replaceAll("_", " ");
}

const SYSTEM_TITLE_KEYS: Record<string, string> = {
	before_agent_start: "chat.trace.system.beforeAgentStart",
	agent_start: "chat.trace.system.agentStart",
	agent_end: "chat.trace.system.agentEnd",
	turn_start: "chat.trace.system.turnStart",
	turn_end: "chat.trace.system.turnEnd",
	message_start: "chat.trace.system.messageStart",
	message_end: "chat.trace.system.messageEnd",
	compaction_start: "chat.trace.system.compactionStart",
	compaction_end: "chat.trace.system.compactionEnd",
	queue_start: "chat.trace.system.queueStart",
	queue_end: "chat.trace.system.queueEnd",
	auto_retry_start: "chat.trace.system.autoRetryStart",
	auto_retry_end: "chat.trace.system.autoRetryEnd",
	entry_appended: "chat.trace.system.entryAppended",
	bash_execution_update: "chat.trace.system.bashExecutionUpdate",
};

function appendSystemEvent(
	steps: ChatTraceStep[],
	event: Extract<ChatStreamEvent, { type: "system_event" }>,
	at?: TraceTime,
): ChatTraceStep[] {
	const family = systemFamily(event.eventType);
	let existingIndex = -1;
	for (let index = steps.length - 1; index >= 0; index -= 1) {
		const current = steps[index];
		if (current?.kind !== "system" || !isOpenStatus(current.status)) continue;
		if (current.eventType && systemFamily(current.eventType) === family && current.attempt === event.attempt) {
			existingIndex = index;
			break;
		}
		if (index < steps.length - 4) break;
	}
	const ended = event.phase === "end";
	const status: ChatTraceStepStatus = event.success === false ? "error" : ended ? "completed" : "active";
	const next = steps.slice();
	const current = existingIndex >= 0 ? next[existingIndex]! : undefined;
	const step: ChatTraceStep = {
		...(current ?? {
			id: `system:${family}:${event.attempt ?? steps.length}`,
			kind: "system" as const,
			status: "active" as const,
			title: systemTitle(event.eventType, event.summary),
		}),
		status,
		title: systemTitle(event.eventType, event.summary) || current?.title || event.eventType,
		titleKey: current?.titleKey ?? SYSTEM_TITLE_KEYS[event.eventType],
		summary: event.summary ?? current?.summary,
		eventType: current?.eventType ?? event.eventType,
		eventPhase: event.phase,
		eventDetail: event.detail,
		...(event.attempt !== undefined ? { attempt: event.attempt } : {}),
		...(current?.startedAt === undefined && at !== undefined ? { startedAt: at } : {}),
		...(ended && at !== undefined ? { endedAt: at } : {}),
		...(ended && at !== undefined && current?.startedAt !== undefined && current.eventPhase === "start"
			? { durationMs: durationFor(current.startedAt, at) }
			: {}),
	};
	if (existingIndex >= 0) next[existingIndex] = step;
	else next.push(step);
	return next;
}

/** Apply one normalized PI/SSE event to the visible logical timeline. */
export function applyChatTraceEvent(
	steps: ChatTraceStep[],
	event: ChatStreamEvent,
	occurredAt?: string,
): ChatTraceStep[] {
	const at = parseTraceTime(occurredAt);
	switch (event.type) {
		case "stream_state":
			return steps;
		case "thinking_start": {
			return [...steps, createContentStep(steps, "thinking", event.contentIndex, at)];
		}
		case "thinking_delta":
			return appendContent(steps, "thinking", event.delta, event.contentIndex, at);
		case "thinking_end":
			return finishContent(steps, "thinking", event.contentIndex, at);
		case "text_start": {
			const closed = finishOpenThinking(steps, at);
			return reclassifyTextSteps([...closed, createContentStep(closed, "progress", event.contentIndex, at)]);
		}
		case "text_delta":
			return appendContent(finishOpenThinking(steps, at), "progress", event.delta, event.contentIndex, at);
		case "text_end":
			return finishContent(steps, "progress", event.contentIndex, at);
		case "tool_call_start":
			return updateToolArgs(finishOpenThinking(steps, at), event.toolCallId, event.toolName, at, event.args, undefined, { forceNew: true });
		case "tool_call_delta":
			return updateToolArgs(finishOpenThinking(steps, at), event.toolCallId, event.toolName, at, event.args, event.argsDelta);
		case "tool_call_end":
			return updateToolArgs(finishOpenThinking(steps, at), event.toolCallId, event.toolName, at, event.args);
		case "tool_start":
			return updateToolExecution(finishOpenThinking(steps, at), event, at);
		case "tool_update":
			return updateToolPartial(finishOpenThinking(steps, at), event, at);
		case "tool_end":
			return finishTool(steps, event, at);
		case "workspace_change":
			return addWorkspaceChanges(steps, event.changes, event.toolCallId);
		case "question": {
			// Older question events did not carry the PI tool id. Reuse the latest
			// open ask_user_question row so question_resolved/tool_end cannot leave
			// behind a second row that stays "running" while the next thinking starts.
			const existingIndex = event.toolCallId
				? findToolIndex(steps, event.toolCallId)
				: findOpenQuestionToolIndex(steps);
			const toolCallId = existingIndex >= 0
				? steps[existingIndex]!.toolCallId ?? event.questionId
				: event.toolCallId ?? event.questionId;
			const ensured = ensureTool(steps, toolCallId, "ask_user_question", at, event.params, { createNewIfClosed: true });
			const next = ensured.steps.slice();
			next[ensured.index] = {
				...next[ensured.index]!,
				status: "waiting",
				title: "等待你的回答",
				titleKey: "chat.trace.steps.waitingForAnswer",
				questionId: event.questionId,
				questionParams: event.params,
			};
			return next;
		}
		case "question_resolved": {
			const index = steps.findIndex((step) => step.questionId === event.questionId);
			if (index < 0) return steps;
			const next = steps.slice();
			next[index] = {
				...next[index]!,
				status: "running",
				title: event.cancelled ? "已取消回答" : "继续执行",
				titleKey: event.cancelled ? "chat.trace.steps.answerCancelled" : "chat.trace.steps.continueExecution",
				summary: event.error,
			};
			return next;
		}
		case "permission_request": {
			// The approval card carries the details; the trace row just marks the pause.
			return [
				...steps,
				{
					id: `permission:${event.requestId}`,
					kind: "tool" as const,
					status: "waiting" as const,
					title: "等待权限审批",
					titleKey: "chat.trace.steps.waitingForPermission",
					toolName: event.toolName ?? event.surface ?? undefined,
					summary: event.command ?? event.path ?? event.value ?? undefined,
				},
			];
		}
		case "permission_resolved": {
			const index = steps.findIndex((step) => step.id === `permission:${event.requestId}`);
			if (index < 0) return steps;
			const next = steps.slice();
			next[index] = {
				...next[index]!,
				status: event.allowed === false ? "error" : "running",
				title: event.allowed === false ? "权限被拒绝" : "已通过审批",
				titleKey: event.allowed === false ? "chat.trace.steps.permissionDenied" : "chat.trace.steps.permissionApproved",
			};
			return next;
		}
		case "skill_loaded":
			if (event.count <= 0 && !event.skills?.length) return steps;
			return [
				...steps,
				{
					id: "skill:loaded",
					kind: "skill",
					status: "completed",
					title: `已预载 ${event.count} 个技能`,
					titleKey: "chat.trace.steps.skillsPreloaded",
					titleParams: { count: event.count },
					skillState: "loaded",
					eventDetail: event.skills,
				},
			];
		case "skill_invoked":
			return [
				...steps,
				{
					id: `skill:${event.skillName}:${steps.length}`,
					kind: "skill",
					status: "completed",
					title: `已载入技能 · ${event.skillName}`,
					titleKey: "chat.trace.steps.skillLoaded",
					titleParams: { skillName: event.skillName },
					skillName: event.skillName,
					skillArgs: event.args,
					skillSource: event.source,
					skillPath: event.path,
					skillDescription: event.description,
					skillState: "expanded",
				},
			];
		case "system_event":
			return appendSystemEvent(steps, event, at);
		case "error":
			return [
				...steps,
				{
					id: `error:${steps.length}`,
					kind: "error",
					status: "error",
					title: "请求失败",
					titleKey: "chat.trace.steps.requestFailed",
					text: event.message,
					summary: event.code,
					...(at !== undefined ? { endedAt: at } : {}),
				},
			];
		case "done":
			return finalizeTraceSteps(steps);
		case "aborted":
			return finalizeTraceSteps([
				...steps,
				{
					id: `aborted:${steps.length}`,
					kind: "error",
					status: "error",
					title: "已停止",
					titleKey: "chat.trace.steps.stopped",
					text: event.message,
				},
			]);
	}
}

/** Close open rows and classify text after the last tool as final answer. */
export function finalizeTraceSteps(steps: ChatTraceStep[]): ChatTraceStep[] {
	const closed = steps.map((step) => {
		if (!isOpenStatus(step.status)) return step;
		return {
			...step,
			status: step.kind === "error" ? "error" : step.isError ? "error" : "completed",
		} satisfies ChatTraceStep;
	});
	return reclassifyTextSteps(closed);
}

/** Rebuild logical rows from a persisted sidecar or a replayed SSE history. */
export function traceStepsFromEvents(records: ChatTraceEventRecord[]): ChatTraceStep[] {
	return records.reduce<ChatTraceStep[]>(
		(steps, record) => applyChatTraceEvent(steps, record.event, record.occurredAt),
		[],
	);
}

export type ChatTraceTerminalStatus = "completed" | "aborted" | "error" | "unknown";

export interface ChatTraceTerminalState {
	status: ChatTraceTerminalStatus;
	reason?: string;
}

const SUCCESSFUL_STOP_REASONS = new Set(["stop", "end", "end_turn", "complete", "completed"]);
const ABORTED_STOP_REASONS = new Set(["abort", "aborted", "cancel", "cancelled", "canceled", "user_cancelled", "user_canceled"]);
const FAILED_STOP_REASONS = new Set(["error", "failed", "failure", "length", "max_tokens", "content_filter"]);

function normalizedStopReason(value?: string): string | undefined {
	return value?.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function detailStopReason(detail: unknown): string | undefined {
	if (!detail || typeof detail !== "object") return undefined;
	const value = (detail as Record<string, unknown>).stopReason;
	return typeof value === "string" ? value : undefined;
}

function systemEventText(event: Extract<ChatStreamEvent, { type: "system_event" }>): string {
	return [
		event.eventType,
		event.summary,
		typeof event.detail === "string" ? event.detail : event.detail ? safeJson(event.detail) : "",
	].filter(Boolean).join(" ");
}

function systemEventStopReason(event: Extract<ChatStreamEvent, { type: "system_event" }>): string | undefined {
	const direct = detailStopReason(event.detail);
	if (direct) return direct;
	const text = systemEventText(event);
	const match = text.match(/(?:["']?stopReason["']?|stop reason)\s*[:=]\s*["']?([a-z][a-z0-9_-]*)/i);
	return match?.[1];
}

function terminalStateFromStopReason(stopReason?: string, reason?: string): ChatTraceTerminalState | undefined {
	const normalized = normalizedStopReason(stopReason);
	if (!normalized) return undefined;
	if (SUCCESSFUL_STOP_REASONS.has(normalized)) return { status: "completed" };
	if (ABORTED_STOP_REASONS.has(normalized)) {
		return { status: "aborted", reason: reason ?? `stopReason: ${stopReason}` };
	}
	if (FAILED_STOP_REASONS.has(normalized)) {
		return { status: "error", reason: reason ?? `stopReason: ${stopReason}` };
	}
	return undefined;
}

/** Infer a terminal result from legacy PI lifecycle records. */
function legacySystemTerminalState(
	event: Extract<ChatStreamEvent, { type: "system_event" }>,
): ChatTraceTerminalState | undefined {
	const text = systemEventText(event);
	const stopReason = systemEventStopReason(event);
	const fromStopReason = terminalStateFromStopReason(stopReason, event.summary ?? text);
	if (fromStopReason) return fromStopReason;

	if (/(request was aborted|prompt aborted|stopped by user|cancel(?:led|ed)? by user|用户(?:主动)?(?:暂停|停止|取消)|主动(?:暂停|停止|取消))/i.test(text)) {
		return { status: "aborted", reason: event.summary ?? text };
	}
	const isTurnBoundary = event.eventType === "message_end" || event.eventType === "turn_end";
	if (
		(event.success === false && isTurnBoundary)
		|| /terminal event .*finishTurn|prompt failed|model request failed|llm api error/i.test(text)
	) {
		return { status: "error", reason: event.summary ?? text };
	}
	return undefined;
}

/** Return the terminal result for a live/new trace or a legacy persisted one.
 * Older sidecars predate terminal events, so the assistant message's PI
 * stopReason is accepted as a second source of truth during cold-start replay. */
export function traceTerminalState(
	records?: ChatTraceEventRecord[],
	fallbackStopReason?: string,
	fallbackReason?: string,
): ChatTraceTerminalState | undefined {
	if (records?.length) {
		for (let index = records.length - 1; index >= 0; index -= 1) {
			const event = records[index]?.event;
			if (!event) continue;
			if (event.type === "done") return { status: "completed" };
			if (event.type === "error") return { status: "error", reason: event.message };
			if (event.type === "aborted") return { status: "aborted", reason: event.message };
			if (event.type === "system_event") {
				const legacyState = legacySystemTerminalState(event);
				if (legacyState) return legacyState;
			}
		}
	}

	const fromFallback = terminalStateFromStopReason(fallbackStopReason, fallbackReason);
	if (fromFallback) return fromFallback;
	if (records?.length || fallbackStopReason) return { status: "unknown" };
	return undefined;
}

/** Best-effort presentation fallback for sessions created before the trace
 * sidecar existed. PI's JSONL parser still exposes aggregate thinking/tools;
 * keep those records visible while leaving the canonical message untouched. */
export function traceStepsFromLegacy(
	content: string,
	thinking?: string,
	tools?: ChatToolRecord[],
): ChatTraceStep[] {
	const steps: ChatTraceStep[] = [];
	if (thinking?.trim()) {
		steps.push({
			id: "legacy:thinking",
				kind: "thinking",
				status: "completed",
				title: "思考",
				titleKey: "chat.trace.steps.thinking",
				text: thinking,
		});
	}
	for (const tool of tools ?? []) {
		steps.push({
			id: `legacy:tool:${tool.toolCallId}`,
			kind: "tool",
			status: tool.isError ? "error" : "completed",
			title: tool.toolName,
			toolCallId: tool.toolCallId,
			toolName: tool.toolName,
				args: tool.args,
				partialResult: tool.partialResult,
				result: tool.result,
			isError: tool.isError,
		});
	}
	if (content.trim()) {
		steps.push({
			id: "legacy:answer",
			kind: "answer",
			status: "completed",
			title: "回复",
			titleKey: "chat.trace.steps.reply",
			text: content,
		});
	}
	return steps;
}
