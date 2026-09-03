import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
	Brain,
	Check,
	ChevronRight,
	CircleAlert,
	Clock3,
	FileText,
	LoaderCircle,
	Puzzle,
	Settings2,
	TerminalSquare,
	Wrench,
} from "lucide-react";
import type { ChatTraceStep, ChatTraceStepKind, ChatTraceStepStatus } from "../../types/chat.js";
import type { AnsweredQuestionnaireView } from "../../utils/questionnaire.js";
import { MarkdownArtifact } from "../MarkdownArtifact.js";
import { AnsweredQuestionCard } from "./AnsweredQuestionCard.js";
import {
	isOpenStatus,
	isTextKind,
	parseTraceTime,
	safeJson,
	visibleTraceSteps,
	type ChatTraceTerminalState,
} from "../../utils/chat-trace.js";

export interface AgentTraceTimelineProps {
	steps: ChatTraceStep[];
	isSending?: boolean;
	startedAt?: string | null;
	finishedAt?: string | null;
	error?: string;
	terminalState?: ChatTraceTerminalState;
	onOpenSkill?: (skillName: string) => void;
	/** Render text records in their original position among process records. */
	showText?: boolean;
	/** Fallback for legacy messages whose trace has no text records. */
	fallbackText?: string;
	/** Completed question cards to anchor after their ask_user_question row. */
	answeredQuestionnaires?: AnsweredQuestionnaireView[];
	/** Live question card anchored after the trace row that represents the tool call. */
	pendingQuestion?: {
		questionId: string;
		card: ReactNode;
	};
}

function formatDuration(durationMs: number | undefined, t: TFunction): string {
	if (durationMs === undefined) return "";
	const seconds = Math.max(0, Math.round(durationMs / 1000));
	return t("chat.trace.durationSeconds", "{{seconds}} 秒", { seconds });
}

function liveDuration(startedAt: number | undefined, endedAt: number | undefined, now: number): number | undefined {
	if (startedAt === undefined) return undefined;
	return Math.max(0, (endedAt ?? now) - startedAt);
}

function stepDuration(step: ChatTraceStep, now: number): number | undefined {
	if (step.durationMs !== undefined) return step.durationMs;
	return isOpenStatus(step.status) ? liveDuration(step.startedAt, step.endedAt, now) : undefined;
}

function compactText(value: string, max = 180): string {
	const compacted = value.replace(/[`*_#>|\[\]()]/g, "").replace(/\s+/g, " ").trim();
	return compacted.length > max ? `${compacted.slice(0, max - 1)}…` : compacted;
}

/** Keep the live thinking indicator on one line while following its newest text. */
function tailText(value: string, max = 96): string {
	const compacted = value.replace(/[`*_#>|\[\]()]/g, "").replace(/\s+/g, " ").trim();
	return compacted.length > max ? `…${compacted.slice(-max)}` : compacted;
}

function firstTarget(value: unknown, depth = 0): string | undefined {
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

function textFromToolPayload(value: unknown): string | undefined {
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

function liveToolText(value: unknown): string | undefined {
	const text = textFromToolPayload(value);
	if (!text) return undefined;
	const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	const lastLine = lines.at(-1);
	return lastLine ? compactText(lastLine, 96) : undefined;
}

function isDiagnosticSummary(value?: string): boolean {
	return Boolean(value?.trim() && /(abort|aborted|cancel|cancelled|canceled|fail|failed|error|timeout|错误|失败|中断|取消|停止)/i.test(value));
}

function localizedStepTitle(step: ChatTraceStep, t: TFunction): string {
	if (step.kind === "system" && step.summary?.trim() && isDiagnosticSummary(step.summary)) return step.title;
	return step.titleKey ? t(step.titleKey, step.title, step.titleParams) : step.title;
}

function toolSummary(step: ChatTraceStep, t: TFunction): string {
	const toolName = step.toolName?.trim() || localizedStepTitle(step, t);
	const target = firstTarget(step.args) ?? firstTarget(step.argsText);
	const live = step.status === "running" ? liveToolText(step.partialResult) : undefined;
	return [
		toolName,
		target ? compactText(target, 120) : undefined,
		live && live !== target ? live : undefined,
	].filter(Boolean).join(" · ") || t("chat.trace.tool", "工具");
}

function thinkingSummary(step: ChatTraceStep, durationMs: number | undefined, t: TFunction): string {
	if (step.status === "completed") {
		return durationMs !== undefined
			? `${t("chat.trace.thinking.completed", "思考完成")} · ${t("chat.trace.duration", "持续了 {{duration}}", { duration: formatDuration(durationMs, t) })}`
			: t("chat.trace.thinking.completed", "思考完成");
	}
	const latestLine = step.text
		?.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.at(-1);
	return [
		t("chat.trace.thinking.inProgress", "思考中"),
		durationMs !== undefined ? t("chat.trace.duration", "持续了 {{duration}}", { duration: formatDuration(durationMs, t) }) : undefined,
		latestLine ? tailText(latestLine, 96) : undefined,
	].filter(Boolean).join(" · ");
}

function statusLabel(status: ChatTraceStepStatus, t: TFunction): string {
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

function workStatusText(
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

function iconFor(kind: ChatTraceStepKind, status: ChatTraceStepStatus) {
	if (kind === "thinking") return <Brain size={15} strokeWidth={1.7} aria-hidden="true" />;
	if (kind === "tool") return status === "running" || status === "preparing" ? <Wrench size={15} strokeWidth={1.7} aria-hidden="true" /> : <TerminalSquare size={15} strokeWidth={1.7} aria-hidden="true" />;
	if (kind === "skill") return <Puzzle size={15} strokeWidth={1.7} aria-hidden="true" />;
	if (kind === "system") return <Settings2 size={15} strokeWidth={1.7} aria-hidden="true" />;
	if (kind === "error") return <CircleAlert size={15} strokeWidth={1.7} aria-hidden="true" />;
	return <FileText size={15} strokeWidth={1.7} aria-hidden="true" />;
}

function statusIcon(status: ChatTraceStepStatus) {
	if (status === "completed") return <Check size={13} strokeWidth={2} aria-hidden="true" />;
	if (status === "error") return <CircleAlert size={13} strokeWidth={2} aria-hidden="true" />;
	if (status === "active" || status === "preparing" || status === "running" || status === "waiting") {
		return <LoaderCircle size={13} className="inno-trace-spinner" aria-hidden="true" />;
	}
	return null;
}

function DetailPayload({ label, value }: { label: string; value: unknown }) {
	const content = safeJson(value);
	if (!content) return null;
	return (
		<div className="inno-trace-detail-block">
			<div className="inno-trace-detail-label">{label}</div>
			<pre className="inno-trace-payload">{content}</pre>
		</div>
	);
}

function workspaceChangeLabel(change: string, t: TFunction): string {
	const key = {
		created: "chat.trace.workspaceChanges.created",
		modified: "chat.trace.workspaceChanges.modified",
		deleted: "chat.trace.workspaceChanges.deleted",
	}[change];
	return key ? t(key, change) : change;
}

function TraceDetails({ step, onOpenSkill, t }: { step: ChatTraceStep; onOpenSkill?: (skillName: string) => void; t: TFunction }) {
	if (step.kind === "thinking") {
		return step.text
			? <pre className="inno-trace-thinking">{step.text}</pre>
			: <span className="inno-trace-empty">{t("chat.trace.details.noThinkingText", "暂无思考文本")}</span>;
	}
	if (step.kind === "progress") {
		return step.text
			? <MarkdownArtifact content={step.text} />
			: <span className="inno-trace-empty">{t("chat.trace.details.noProgressText", "暂无进度文本")}</span>;
	}
	if (step.kind === "tool") {
		return (
			<div className="inno-trace-tool-details">
				<DetailPayload label={t("chat.trace.details.arguments", "参数")} value={step.args ?? step.argsText} />
				<DetailPayload label={t("chat.trace.details.partialResult", "实时结果")} value={step.partialResult} />
				<DetailPayload label={step.isError ? t("chat.trace.details.error", "错误") : t("chat.trace.details.result", "结果")} value={step.result} />
				{step.questionParams ? <DetailPayload label={t("chat.trace.details.question", "提问")} value={step.questionParams} /> : null}
				{step.workspaceChanges?.length ? (
					<div className="inno-trace-detail-block">
						<div className="inno-trace-detail-label">{t("chat.trace.details.workspaceChanges", "工作区变化")}</div>
						<ul className="inno-trace-change-list">
							{step.workspaceChanges.map((change) => <li key={`${change.change}:${change.path}`}>{workspaceChangeLabel(change.change, t)} · {change.path}</li>)}
						</ul>
					</div>
				) : null}
			</div>
		);
	}
	if (step.kind === "skill") {
		return (
			<div className="inno-trace-skill-details">
				{step.skillName ? <div><span className="inno-trace-detail-label">{t("chat.trace.details.skill", "技能")}</span>{step.skillName}</div> : null}
				{step.skillSource ? <div><span className="inno-trace-detail-label">{t("chat.trace.details.source", "来源")}</span>{step.skillSource}</div> : null}
				{step.skillPath ? <div className="break-all"><span className="inno-trace-detail-label">{t("chat.trace.details.path", "路径")}</span>{step.skillPath}</div> : null}
				{step.skillDescription ? <div><span className="inno-trace-detail-label">{t("chat.trace.details.description", "说明")}</span>{step.skillDescription}</div> : null}
				{step.skillArgs ? <DetailPayload label={t("chat.trace.details.arguments", "参数")} value={step.skillArgs} /> : null}
				{step.skillName && onOpenSkill ? (
					<button type="button" className="inno-trace-open-skill" onClick={() => onOpenSkill(step.skillName!)}>
						{t("chat.trace.details.openSkillsPanel", "打开 Skills 面板")}
					</button>
				) : null}
				{step.skillState === "loaded" && step.eventDetail ? <DetailPayload label={t("chat.trace.details.preloadedSkills", "已预载技能")} value={step.eventDetail} /> : null}
			</div>
		);
	}
	if (step.kind === "system") {
		return (
			<div className="inno-trace-system-details">
				{step.eventType ? <div><span className="inno-trace-detail-label">{t("chat.trace.details.piEvent", "PI 事件")}</span>{step.eventType}</div> : null}
				{step.attempt !== undefined ? <div><span className="inno-trace-detail-label">{t("chat.trace.details.attempt", "尝试")}</span>{step.attempt}</div> : null}
				<DetailPayload label={t("chat.trace.details.details", "详情")} value={step.eventDetail} />
			</div>
		);
	}
	return step.text ? <pre className="inno-trace-error-details">{step.text}</pre> : null;
}

function rowSummary(step: ChatTraceStep, durationMs: number | undefined, t: TFunction): string {
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

function shimmerTitleFor(step: ChatTraceStep, t: TFunction): string | undefined {
	if (step.kind === "thinking" && step.status === "active") return t("chat.trace.thinking.inProgress", "思考中");
	if (step.kind === "tool" && (step.status === "active" || step.status === "preparing" || step.status === "running")) {
		return step.toolName?.trim() || localizedStepTitle(step, t);
	}
	return undefined;
}

function TraceRow({ step, now, isCurrentLiveStep, expanded, onToggle, t, onOpenSkill }: {
	step: ChatTraceStep;
	now: number;
	isCurrentLiveStep: boolean;
	expanded: boolean;
	onToggle: () => void;
	t: TFunction;
	onOpenSkill?: (skillName: string) => void;
}) {
	const durationMs = stepDuration(step, now);
	const summary = rowSummary(step, durationMs, t);
	const shimmerTitle = isCurrentLiveStep
		? step.kind === "tool" ? summary : shimmerTitleFor(step, t)
		: undefined;
	const shimmerStart = shimmerTitle ? summary.indexOf(shimmerTitle) : -1;
	const isShimmering = shimmerStart >= 0;
	const isFullLineShimmer = isShimmering && step.kind === "tool";
	const isSystem = step.kind === "system";
	const isLive = isOpenStatus(step.status);
	return (
		<div className={`inno-trace-row ${isSystem ? "is-system" : ""} ${step.kind === "error" ? "is-error" : ""} ${isLive ? "is-live" : ""}`}>
			<button
				type="button"
				className="inno-trace-row-toggle"
				aria-expanded={expanded}
				aria-label={expanded
					? t("chat.trace.row.collapse", "收起{{summary}}", { summary })
					: t("chat.trace.row.expand", "展开{{summary}}", { summary })}
				onClick={onToggle}
			>
				<span className="inno-trace-icon">{iconFor(step.kind, step.status)}</span>
				<span
					className={`inno-trace-row-title ${isShimmering ? "is-shimmering" : ""}`}
				>
					{isFullLineShimmer ? (
						<span className="inno-trace-title-shimmer-target is-full-line">
							{summary}
							<span className="inno-trace-title-shimmer" aria-hidden="true">{summary}</span>
						</span>
					) : isShimmering ? (
						<>
							{summary.slice(0, shimmerStart)}
							<span className="inno-trace-title-shimmer-target">
								{shimmerTitle}
								<span className="inno-trace-title-shimmer" aria-hidden="true">{shimmerTitle}</span>
							</span>
							{summary.slice(shimmerStart + shimmerTitle!.length)}
						</>
					) : summary}
				</span>
				<span className={`inno-trace-status ${step.status}`} title={statusLabel(step.status, t)}>{statusIcon(step.status)}</span>
				<ChevronRight size={14} className={`inno-trace-chevron ${expanded ? "is-open" : ""}`} aria-hidden="true" />
			</button>
			{expanded ? <div className="inno-trace-row-details"><TraceDetails step={step} onOpenSkill={onOpenSkill} t={t} /></div> : null}
		</div>
	);
}

function TraceBody({ content }: { content: string }) {
	const trimmed = content.trim();
	if (!trimmed) return null;
	return (
		<div className="inno-trace-body">
			<MarkdownArtifact content={trimmed} />
		</div>
	);
}

/** Streamdown repairs incomplete Markdown and animates incoming content while
 * the existing trace container keeps the reply in chronological position. */
function LiveTraceBody({ content }: { content: string }) {
	const trimmed = content.trim();
	if (!trimmed) return null;
	return (
		<div className="inno-trace-body">
			<MarkdownArtifact content={trimmed} streaming />
		</div>
	);
}

function pendingQuestionTraceStep(questionId: string): ChatTraceStep {
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

export function AgentTraceTimeline({
	steps,
	isSending = false,
	startedAt,
	finishedAt,
	error,
	terminalState,
	onOpenSkill,
	showText = false,
	fallbackText,
	answeredQuestionnaires = [],
	pendingQuestion,
}: AgentTraceTimelineProps) {
	const { t } = useTranslation();
	const [, setClock] = useState(0);
	const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

	useEffect(() => {
		if (!isSending) return;
		const timer = window.setInterval(() => setClock((value) => value + 1), 1_000);
		return () => window.clearInterval(timer);
	}, [isSending]);

	const now = Date.now();
	const visibleSteps = useMemo(() => {
		const nextSteps = visibleTraceSteps(steps);
		const normalizedError = error?.trim().toLowerCase();
		const hasMatchingError = normalizedError
			? nextSteps.some((step) => [step.text, step.title, step.summary, step.eventType]
				.filter(Boolean)
				.some((value) => value!.trim().toLowerCase().includes(normalizedError)))
			: false;
		if (error && !hasMatchingError) {
			return [...nextSteps, {
				id: "stream-error",
				kind: "error",
				status: "error",
				title: "请求失败",
				titleKey: "chat.trace.steps.requestFailed",
				text: error,
			} satisfies ChatTraceStep];
		}
		return nextSteps;
	}, [error, steps]);
	const processSteps = useMemo(
		() => visibleSteps.filter((step) => !isTextKind(step.kind)),
		[visibleSteps],
	);
	const flowSteps = showText ? visibleSteps : processSteps;
	const hasTextPayload = flowSteps.some((step) => isTextKind(step.kind) && Boolean(step.text?.trim()));
	const showFallbackText = showText && !hasTextPayload && Boolean(fallbackText?.trim());
	const pendingQuestionIndex = pendingQuestion
		? flowSteps.findIndex((step) => !isTextKind(step.kind) && step.questionId === pendingQuestion.questionId)
		: -1;
	const questionnaireByToolCallId = useMemo(
		() => new Map(answeredQuestionnaires.map((view) => [view.tool.toolCallId, view])),
		[answeredQuestionnaires],
	);
	const matchedQuestionnaireIds = useMemo(
		() => new Set(flowSteps.flatMap((step) => step.kind === "tool" && step.toolCallId ? [step.toolCallId] : [])),
		[flowSteps],
	);

	const started = parseTraceTime(startedAt);
	const finished = parseTraceTime(finishedAt);
	const durationMs = isSending
		? liveDuration(started, undefined, now)
		: liveDuration(started, finished, now);
	const showHeader = isSending || Boolean(error) || processSteps.length > 0;
	const hasUnmatchedQuestionnaires = answeredQuestionnaires.some((view) => !matchedQuestionnaireIds.has(view.tool.toolCallId));
	if (!showHeader && !flowSteps.length && !showFallbackText && !hasUnmatchedQuestionnaires && !pendingQuestion) return null;
	// The step status is the source of truth for the live indicator. During a
	// question pause or a reconnect, `isSending` can briefly be false while the
	// trace still correctly reports a running/waiting step.
	const currentLiveStep = [...processSteps].reverse().find((step) => isOpenStatus(step.status));

	const toggle = (id: string) => {
		setExpanded((current) => {
			const next = new Set(current);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	return (
		<div className="inno-trace-timeline" aria-label={t("chat.trace.timeline", "工作过程")}>
			{showHeader ? (
				<div className="inno-trace-work-status">
					<Clock3 size={14} aria-hidden="true" />
					<span>{workStatusText(isSending, terminalState, visibleSteps, t, error)}</span>
					{durationMs !== undefined ? <span>· {formatDuration(durationMs, t)}</span> : null}
				</div>
			) : null}
			<div className={showText ? "inno-trace-flow" : "inno-trace-list"} role="list">
				{flowSteps.map((step, index) => {
					if (isTextKind(step.kind)) {
						const Body = isSending ? LiveTraceBody : TraceBody;
						return <Body key={`trace-body:${index}:${step.id}`} content={step.text ?? ""} />;
					}
					const rowId = `trace-row:${index}:${step.id}`;
					const questionnaire = showText && step.kind === "tool" && step.toolCallId
						? questionnaireByToolCallId.get(step.toolCallId)
						: undefined;
					return (
						<Fragment key={rowId}>
							<TraceRow
								step={step}
								now={now}
								isCurrentLiveStep={step === currentLiveStep}
								expanded={expanded.has(rowId)}
								onToggle={() => toggle(rowId)}
								t={t}
								onOpenSkill={onOpenSkill}
							/>
							{pendingQuestionIndex === index ? (
								<div className="inno-trace-questionnaire">
									{pendingQuestion!.card}
								</div>
							) : null}
							{questionnaire ? (
								<div className="inno-trace-questionnaire">
									<AnsweredQuestionCard questionnaire={questionnaire.questionnaire} />
								</div>
							) : null}
						</Fragment>
					);
				})}
				{pendingQuestion && pendingQuestionIndex < 0 ? (
					<>
						<TraceRow
							step={pendingQuestionTraceStep(pendingQuestion.questionId)}
							now={now}
							isCurrentLiveStep
							expanded={false}
							onToggle={() => undefined}
							t={t}
							onOpenSkill={onOpenSkill}
						/>
						<div className="inno-trace-questionnaire">
							{pendingQuestion.card}
						</div>
					</>
				) : null}
				{showFallbackText ? (
					<div className="inno-trace-fallback-body">
						<TraceBody content={fallbackText ?? ""} />
					</div>
				) : null}
				{showText ? answeredQuestionnaires.filter((view) => !matchedQuestionnaireIds.has(view.tool.toolCallId)).map((view) => (
					<div className="inno-trace-questionnaire" key={`questionnaire:${view.tool.toolCallId}`}>
						<AnsweredQuestionCard questionnaire={view.questionnaire} />
					</div>
				)) : null}
			</div>
		</div>
	);
}
