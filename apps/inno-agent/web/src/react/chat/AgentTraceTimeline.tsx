import { Fragment, memo, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { AnimatePresence, motion } from "motion/react";
import {
	Brain,
	ChevronRight,
	CircleAlert,
	ClipboardList,
	Eye,
	FileText,
	Folder,
	Globe,
	LoaderCircle,
	Pencil,
	Puzzle,
	Search,
	Send,
	Settings2,
	TerminalSquare,
	Wrench,
	type LucideIcon,
} from "lucide-react";
import type { ChatTraceStep } from "../../types/chat.js";
import type { AnsweredQuestionnaireView } from "../../utils/questionnaire.js";
import { MarkdownArtifact } from "../MarkdownArtifact.js";
import { Tooltip, useUITransition } from "../ui/index.js";
import { AnsweredQuestionCard } from "./AnsweredQuestionCard.js";
import { WorkingLogo } from "./WorkingLogo.js";
import { TraceDetails } from "./TraceDetails.js";
import {
	liveDuration,
	pendingQuestionTraceStep,
	rowSummary,
	shimmerTitleFor,
	statusLabel,
	stepDuration,
	workStatusText,
} from "./trace-format.js";
import {
	QueuedSummaryRoll,
	StreamingSummaryLine,
	TraceCollapsible,
	resolveThinkingStreamingSummary,
	useBottomFollowingScroll,
	useContinuousGroupKeys,
} from "./trace-motion.js";
import {
	isOpenStatus,
	isTextKind,
	parseTraceTime,
	visibleTraceSteps,
	type ChatTraceTerminalState,
} from "../../utils/chat-trace.js";
import {
	foldTraceFlow,
	formatCompactDuration,
	summarizeTraceRun,
	traceIconKind,
	type IndexedTraceStep,
	type TraceIconKind,
} from "../../utils/trace-summary.js";

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
	/** Keep the streaming DOM shape (per-block wrappers, animation off) for
	 *  text bodies. Used by the turn that just finished so replacing the live
	 *  trace with the persisted bubble is geometry-neutral. */
	liveBodies?: boolean;
	/** Fallback for legacy messages whose trace has no text records. */
	fallbackText?: string;
	/** Completed question cards to anchor after their ask_user_question row. */
	answeredQuestionnaires?: AnsweredQuestionnaireView[];
	/** Live question card anchored after the trace row that represents the tool call. */
	pendingQuestion?: {
		questionId: string;
		card: ReactNode;
	};
	/** Extra card rendered at the end of the flow (e.g. a permission approval
	 *  card — the gate parks before the tool row exists, so there is nothing
	 *  to anchor to). */
	trailingCard?: ReactNode;
}

const TRACE_ICONS: Record<TraceIconKind, LucideIcon> = {
	read: Eye,
	modify: Pencil,
	command: TerminalSquare,
	search: Search,
	folder: Folder,
	web: Globe,
	plan: ClipboardList,
	collab: Send,
	skill: Puzzle,
	thinking: Brain,
	wrench: Wrench,
};

function TraceIcon({ kind }: { kind: TraceIconKind }) {
	const Icon = TRACE_ICONS[kind];
	return <Icon size={14} strokeWidth={1.7} aria-hidden="true" />;
}

function iconFor(step: ChatTraceStep) {
	if (step.kind === "system") return <Settings2 size={14} strokeWidth={1.7} aria-hidden="true" />;
	if (step.kind === "error") return <CircleAlert size={14} strokeWidth={1.7} aria-hidden="true" />;
	if (step.kind === "thinking" || step.kind === "tool" || step.kind === "skill") return <TraceIcon kind={traceIconKind(step)} />;
	return <FileText size={14} strokeWidth={1.7} aria-hidden="true" />;
}

/**
 * ZCode-aligned status icon policy:
 * - Thinking stays active across long streams, so omit a spinning loader to
 *   avoid continuous compositor churn and rely on static Brain + text shimmer.
 * - Live tools and failed steps keep explicit status marks.
 */
function statusIcon(step: ChatTraceStep) {
	if (step.status === "error" || step.isError) return <CircleAlert size={13} strokeWidth={2} aria-hidden="true" />;
	if (step.kind === "thinking") return null;
	if (step.status === "active" || step.status === "preparing" || step.status === "running" || step.status === "waiting") {
		return <LoaderCircle size={13} className="inno-trace-spinner" aria-hidden="true" />;
	}
	return null;
}

/** Scoped 1s clock so timer ticks never re-render the entire timeline or Markdown bodies. */
function useLiveTickNow(enabled: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!enabled) return;
		setNow(Date.now());
		const timer = window.setInterval(() => setNow(Date.now()), 1_000);
		return () => window.clearInterval(timer);
	}, [enabled]);
	return now;
}

function ShimmerText({ text, fullLine = false }: { text: string; fullLine?: boolean }) {
	return (
		<span className={`inno-trace-title-shimmer-target ${fullLine ? "is-full-line" : ""}`}>
			{text}
			<span className="inno-trace-title-shimmer" aria-hidden="true">{text}</span>
		</span>
	);
}

/** Shared summary content for both standalone TraceRow and live TraceRunRow preview header. */
function TraceRowSummaryContent({
	step,
	isCurrentLiveStep,
	expanded,
	inPreview = false,
	t,
}: {
	step: ChatTraceStep;
	isCurrentLiveStep: boolean;
	expanded: boolean;
	inPreview?: boolean;
	t: TFunction;
}) {
	const isLive = isOpenStatus(step.status);
	const isThinking = step.kind === "thinking";
	// Only tick live duration when expanded thinking actually displays it.
	const needsLiveDuration = isThinking && isLive && expanded && step.durationMs === undefined && step.startedAt !== undefined;
	const now = useLiveTickNow(needsLiveDuration);
	// Collapsed live thinking omits live duration ticks and shows the rolling
	// streaming line instead (matching ZCode's ReasoningTrigger).
	const durationMs = isThinking && isLive && !expanded ? undefined : stepDuration(step, now);
	const summary = rowSummary(step, durationMs, t);
	const streamingThinkingSummary = isThinking && isLive && !expanded
		? resolveThinkingStreamingSummary(step.text)
		: null;
	const shimmerTitle = isCurrentLiveStep || inPreview
		? (step.kind === "tool" ? summary : shimmerTitleFor(step, t) ?? (inPreview ? summary : undefined))
		: undefined;
	const shimmerStart = shimmerTitle ? summary.indexOf(shimmerTitle) : -1;
	const isShimmering = shimmerStart >= 0;
	const isFullLineShimmer = isShimmering && (step.kind === "tool" || (inPreview && !isThinking));
	const iconStatus = statusIcon(step);

	return (
		<>
			<span className="inno-trace-icon" data-trace-leading-icon="true">{iconFor(step)}</span>
			<span
				className={`inno-trace-row-title ${isShimmering ? "is-shimmering" : ""} ${streamingThinkingSummary ? "is-fixed-label" : ""}`}
			>
				{isFullLineShimmer ? (
					<ShimmerText text={summary} fullLine />
				) : isShimmering ? (
					<>
						{summary.slice(0, shimmerStart)}
						<ShimmerText text={shimmerTitle!} />
						{summary.slice(shimmerStart + shimmerTitle!.length)}
					</>
				) : summary}
			</span>
			{streamingThinkingSummary ? (
				<StreamingSummaryLine
					summaryKey={streamingThinkingSummary.key}
					summaryText={streamingThinkingSummary.text}
					enabled={!inPreview}
				/>
			) : null}
			{!inPreview && iconStatus ? (
				<Tooltip label={statusLabel(step.status, t)}>
					<span className={`inno-trace-status ${step.status}`}>{iconStatus}</span>
				</Tooltip>
			) : null}
		</>
	);
}

const TraceRow = memo(function TraceRow({
	rowId,
	step,
	isCurrentLiveStep,
	expanded,
	onToggleId,
	t,
	onOpenSkill,
}: {
	rowId: string;
	step: ChatTraceStep;
	isCurrentLiveStep: boolean;
	expanded: boolean;
	onToggleId: (id: string) => void;
	t: TFunction;
	onOpenSkill?: (skillName: string) => void;
}) {
	const durationMs = step.kind === "thinking" && isOpenStatus(step.status) && !expanded
		? undefined
		: step.durationMs;
	const summary = rowSummary(step, durationMs, t);
	const isSystem = step.kind === "system";
	const isLive = isOpenStatus(step.status);
	// Failed tools retain kind="tool"; checking kind alone painted their
	// error icon with the success color even though the row said “失败”.
	const isError = step.kind === "error" || step.status === "error" || step.isError;
	const detailsId = useId();
	return (
		<div
			className={`inno-trace-row ${isSystem ? "is-system" : ""} ${isError ? "is-error" : ""} ${isLive ? "is-live" : ""}`}
			data-trace-kind={step.kind}
		>
			<button
				type="button"
				className="inno-trace-row-toggle"
				aria-expanded={expanded}
				aria-controls={detailsId}
				aria-label={expanded
					? t("chat.trace.row.collapse", "收起{{summary}}", { summary })
					: t("chat.trace.row.expand", "展开{{summary}}", { summary })}
				onClick={() => onToggleId(rowId)}
			>
				<TraceRowSummaryContent
					step={step}
					isCurrentLiveStep={isCurrentLiveStep}
					expanded={expanded}
					t={t}
				/>
				<ChevronRight size={12} className={`inno-trace-chevron ${expanded ? "is-open" : ""}`} aria-hidden="true" />
			</button>
			<TraceCollapsible open={expanded} id={detailsId}>
				<div className="inno-trace-row-details">
					<TraceDetails step={step} expanded={expanded} onOpenSkill={onOpenSkill} t={t} />
				</div>
			</TraceCollapsible>
		</div>
	);
});

const TraceBody = memo(function TraceBody({ content }: { content: string }) {
	const trimmed = content.trim();
	if (!trimmed) return null;
	return (
		<div className="inno-trace-body">
			<MarkdownArtifact content={trimmed} />
		</div>
	);
});

/** Streamdown repairs incomplete Markdown and memoizes settled blocks while
 * streaming. What it does not guard is the row height: mid-stream swaps (the
 * Mermaid lazy fallback, the 64KB animation flip, async renderer fallbacks)
 * can momentarily render shorter and bounce the timeline. Pin the container
 * to its tallest observed height so transient reparses cannot shrink it. */
const LiveTraceBody = memo(function LiveTraceBody({ content, animate = true }: { content: string; animate?: boolean }) {
	const trimmed = content.trim();

	const heightWatermarkRef = useRef(0);
	const bodyObserverRef = useRef<ResizeObserver | null>(null);
	const bodyElRef = useRef<HTMLDivElement | null>(null);
	const bodyRef = useCallback((el: HTMLDivElement | null) => {
		bodyObserverRef.current?.disconnect();
		bodyObserverRef.current = null;
		bodyElRef.current = el;
		if (!el) return;
		heightWatermarkRef.current = 0;
		el.style.minHeight = "";
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => {
			const height = el.offsetHeight;
			if (height > heightWatermarkRef.current) heightWatermarkRef.current = height;
			const minHeight = `${heightWatermarkRef.current}px`;
			if (el.style.minHeight !== minHeight) el.style.minHeight = minHeight;
		});
		observer.observe(el);
		bodyObserverRef.current = observer;
	}, []);

	// Once streaming settles, release the height watermark so subsequent window
	// resizes can reflow the settled message naturally without trailing whitespace.
	useEffect(() => {
		if (animate) return;
		bodyObserverRef.current?.disconnect();
		bodyObserverRef.current = null;
		if (bodyElRef.current) bodyElRef.current.style.minHeight = "";
	}, [animate]);

	if (!trimmed) return null;
	return (
		<div ref={bodyRef} className="inno-trace-body">
			<MarkdownArtifact content={trimmed} streaming animate={animate} />
		</div>
	);
});

/**
 * Consecutive process group (ZCode ConsecutiveSummaryGroup model):
 * - When `isLiveTail && !expanded`, rolls the latest/active step in place on
 *   one line via QueuedSummaryRoll so live turns stay compact.
 * - Once closed (prose follows or turn settles) or when expanded, shows the
 *   merged summary text and expands with a single shared guide rail and
 *   bottom-following scroll mask.
 */
const TraceRunRow = memo(function TraceRunRow({
	runId,
	members,
	isLiveTail,
	currentLiveStep,
	expanded,
	onToggleId,
	t,
	children,
}: {
	runId: string;
	members: IndexedTraceStep[];
	isLiveTail: boolean;
	currentLiveStep?: ChatTraceStep;
	expanded: boolean;
	onToggleId: (id: string) => void;
	t: TFunction;
	children: ReactNode;
}) {
	const { text, icon } = useMemo(
		() => summarizeTraceRun(members.map((member) => member.step), t),
		[members, t],
	);
	const contentId = useId();
	const activeMember = useMemo(
		() => [...members].reverse().find((member) => isOpenStatus(member.step.status)) ?? members.at(-1)!,
		[members],
	);
	const hasActiveMember = isOpenStatus(activeMember.step.status);
	const showLivePreview = isLiveTail && !expanded;
	// Only auto-scroll to the bottom for an active trailing group; settled runs open at the top.
	const scroll = useBottomFollowingScroll(
		expanded,
		`${members.length}:${activeMember.step.id}:${activeMember.step.text?.length ?? 0}`,
		isLiveTail,
	);

	return (
		<div className="inno-trace-run" data-run-live={isLiveTail ? "true" : "false"}>
			<button
				type="button"
				className="inno-trace-row-toggle"
				aria-expanded={expanded}
				aria-controls={contentId}
				aria-label={expanded
					? t("chat.trace.row.collapse", "收起{{summary}}", { summary: text })
					: t("chat.trace.row.expand", "展开{{summary}}", { summary: text })}
				onClick={() => onToggleId(runId)}
			>
				{showLivePreview ? (
					<QueuedSummaryRoll
						contentKey={`run-preview:${activeMember.index}:${activeMember.step.id}`}
						refreshVersion={activeMember.step}
						enabled={isLiveTail}
						className="inno-trace-run-preview"
					>
						<span className="inno-trace-run-preview-line">
							<TraceRowSummaryContent
								step={activeMember.step}
								isCurrentLiveStep={activeMember.step === currentLiveStep || isLiveTail}
								expanded={false}
								inPreview
								t={t}
							/>
						</span>
					</QueuedSummaryRoll>
				) : (
					<>
						<span className="inno-trace-icon"><TraceIcon kind={icon} /></span>
						<span className={`inno-trace-row-title ${isLiveTail && !hasActiveMember ? "is-shimmering" : ""}`}>
							{isLiveTail && !hasActiveMember ? <ShimmerText text={text} fullLine /> : text}
						</span>
					</>
				)}
				<ChevronRight size={12} className={`inno-trace-chevron ${expanded ? "is-open" : ""}`} aria-hidden="true" />
			</button>
			<TraceCollapsible open={expanded} id={contentId}>
				<div
					ref={scroll.scrollRef}
					className="inno-trace-run-scroll"
					data-scroll-mask={scroll.maskData}
					onScroll={scroll.onScroll}
					style={scroll.maskStyle}
				>
					<div ref={scroll.contentRef} className="inno-trace-run-members">
						{children}
					</div>
				</div>
			</TraceCollapsible>
		</div>
	);
});

/** Bottom running indicator (ZCode ChatLoading slot) with isolated 1s timer. */
const TraceLiveFooter = memo(function TraceLiveFooter({
	label,
	startedAtMs,
}: {
	label: string;
	startedAtMs?: number;
}) {
	const transition = useUITransition("modal");
	const now = useLiveTickNow(startedAtMs !== undefined);
	const durationMs = liveDuration(startedAtMs, undefined, now);
	return (
		<motion.div
			className="inno-trace-live-footer"
			role="status"
			initial={{ opacity: 0 }}
			animate={{ opacity: 1 }}
			transition={transition}
		>
			<WorkingLogo />
			<span className="inno-trace-live-label is-shimmering">
				<ShimmerText text={label} />
			</span>
			{durationMs !== undefined ? (
				<span className="inno-trace-work-duration">{formatCompactDuration(durationMs)}</span>
			) : null}
		</motion.div>
	);
});

const NOOP_TOGGLE = () => undefined;

export function AgentTraceTimeline({
	steps,
	isSending = false,
	startedAt,
	finishedAt,
	error,
	terminalState,
	onOpenSkill,
	showText = false,
	liveBodies = false,
	fallbackText,
	answeredQuestionnaires = [],
	pendingQuestion,
	trailingCard,
}: AgentTraceTimelineProps) {
	const transition = useUITransition("modal");
	const { t } = useTranslation();
	const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
	const [processExpansionOverride, setProcessExpansionOverride] = useState<boolean | null>(null);
	const processListId = useId();

	const toggle = useCallback((id: string) => {
		setExpanded((current) => {
			const next = new Set(current);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}, []);

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
	const settledDurationMs = !isSending ? liveDuration(started, finished, finished ?? Date.now()) : undefined;

	// The step status is the source of truth for the live indicator. During a
	// question pause or a reconnect, `isSending` can briefly be false while the
	// trace still correctly reports a running/waiting step.
	const currentLiveStep = useMemo(
		() => [...processSteps].reverse().find((step) => isOpenStatus(step.status)),
		[processSteps],
	);
	const settled = !isSending && !currentLiveStep;
	const hasBlockingInteraction = Boolean(pendingQuestion || trailingCard);
	// ZCode model:
	// - While running, hide the top header and render the live indicator at the
	//   bottom of the flow (suppressed when an interactive question/permission
	//   card owns progress feedback).
	// - Once settled, show the top status header; >=2 process steps fold under
	//   it with a smooth collapse animation.
	const showLiveFooter = isSending && !hasBlockingInteraction;
	const showSettledHeader = !isSending && (Boolean(error) || processSteps.length > 0);
	const hasUnmatchedQuestionnaires = answeredQuestionnaires.some((view) => !matchedQuestionnaireIds.has(view.tool.toolCallId));

	const foldedFlow = useMemo(
		() => foldTraceFlow(
			flowSteps.map((step, index) => ({ step, index })),
			settled,
			(step) => isTextKind(step.kind),
		),
		[flowSteps, settled],
	);
	// Key prose blocks by their ordinal position among text steps rather than
	// step.id/raw index so streaming-to-canonical handoff keeps the exact same
	// LiveTraceBody / Streamdown instance mounted even if step IDs normalize.
	const textOrdinalByIndex = useMemo(() => {
		const map = new Map<number, number>();
		let ordinal = 0;
		for (let i = 0; i < flowSteps.length; i += 1) {
			if (isTextKind(flowSteps[i]!.kind)) {
				map.set(i, ordinal);
				ordinal += 1;
			}
		}
		return map;
	}, [flowSteps]);
	const flowItemKeys = useContinuousGroupKeys(foldedFlow, (item) =>
		item.type === "step"
			? {
				kind: item.step.kind,
				memberKeys: [`${item.index}:${item.step.id}`],
				fixedKey: isTextKind(item.step.kind)
					? `trace-body:${textOrdinalByIndex.get(item.index) ?? item.index}`
					: `trace-row:${item.index}:${item.step.id}`,
			}
			: {
				kind: "run",
				memberKeys: item.members.map((member) => `${member.index}:${member.step.id}`),
			},
	);

	if (!showSettledHeader && !showLiveFooter && !flowSteps.length && !showFallbackText && !hasUnmatchedQuestionnaires && !pendingQuestion && !trailingCard) {
		return null;
	}

	// Keep process rows wrapped in TraceCollapsible once there are >=2 process
	// steps (even while live) so settling transitions the same collapsible from
	// open=true to open=false and plays the smooth collapse animation instead of
	// abruptly unmounting the rows above the prose.
	const canCollapseProcess = processSteps.length >= 2;
	const hasCollapsibleProcess = settled && canCollapseProcess;
	const processExpanded = !hasCollapsibleProcess || (processExpansionOverride ?? false);
	const workStatus = workStatusText(isSending, terminalState, visibleSteps, t, error);
	const workStatusContent = (
		<>
			<span>{workStatus}</span>
			{settledDurationMs !== undefined ? <span className="inno-trace-work-duration">{formatCompactDuration(settledDurationMs)}</span> : null}
		</>
	);

	const renderStepRow = (step: ChatTraceStep, index: number, insideRun = false): ReactNode => {
		if (isTextKind(step.kind)) {
			const bodyKey = `trace-body:${textOrdinalByIndex.get(index) ?? index}`;
			if (isSending) return <LiveTraceBody key={bodyKey} content={step.text ?? ""} />;
			if (liveBodies) return <LiveTraceBody key={bodyKey} content={step.text ?? ""} animate={false} />;
			return <TraceBody key={bodyKey} content={step.text ?? ""} />;
		}
		const rowId = `trace-row:${index}:${step.id}`;
		const questionnaire = showText && step.kind === "tool" && step.toolCallId
			? questionnaireByToolCallId.get(step.toolCallId)
			: undefined;
		const rowNode = (
			<TraceRow
				rowId={rowId}
				step={step}
				isCurrentLiveStep={step === currentLiveStep}
				expanded={expanded.has(rowId)}
				onToggleId={toggle}
				t={t}
				onOpenSkill={onOpenSkill}
			/>
		);
		return (
			<Fragment key={rowId}>
				{insideRun || !canCollapseProcess ? (
					rowNode
				) : (
					<TraceCollapsible open={processExpanded}>
						{rowNode}
					</TraceCollapsible>
				)}
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
	};

	const renderedFlow: ReactNode[] = foldedFlow.map((item, itemIndex) => {
		const itemKey = flowItemKeys[itemIndex]!;
		if (item.type === "step") return renderStepRow(item.step, item.index);
		const runNode = (
			<TraceRunRow
				runId={itemKey}
				members={item.members}
				isLiveTail={item.isLiveTail}
				currentLiveStep={currentLiveStep}
				expanded={expanded.has(itemKey)}
				onToggleId={toggle}
				t={t}
			>
				{item.members.map(({ step, index }) => renderStepRow(step, index, true))}
			</TraceRunRow>
		);
		if (!canCollapseProcess) {
			return <Fragment key={itemKey}>{runNode}</Fragment>;
		}
		return (
			<TraceCollapsible key={itemKey} open={processExpanded}>
				{runNode}
			</TraceCollapsible>
		);
	});

	return (
		<div className="inno-trace-timeline" aria-label={t("chat.trace.timeline", "工作过程")}>
			<AnimatePresence initial={false}>
				{showSettledHeader ? (
					<motion.div
						key="settled-header"
						className="inno-trace-collapsible"
						initial={{ height: 0, opacity: 0 }}
						animate={{ height: "auto", opacity: 1 }}
						exit={{ height: 0, opacity: 0 }}
						transition={transition}
					>
						{hasCollapsibleProcess ? (
							<div className="inno-trace-settled-header">
								<button
									type="button"
									className="inno-trace-work-status inno-trace-process-toggle"
									aria-expanded={processExpanded}
									aria-controls={processListId}
									aria-label={processExpanded
										? t("chat.trace.process.collapse", "收起工作过程（{{count}} 个步骤）", { count: processSteps.length })
										: t("chat.trace.process.expand", "展开工作过程（{{count}} 个步骤）", { count: processSteps.length })}
									onClick={() => setProcessExpansionOverride(!processExpanded)}
								>
									{workStatusContent}
									<ChevronRight size={12} className={`inno-trace-chevron ${processExpanded ? "is-open" : ""}`} aria-hidden="true" />
								</button>
							</div>
						) : (
							<div className="inno-trace-work-status">{workStatusContent}</div>
						)}
					</motion.div>
				) : null}
			</AnimatePresence>
			<div id={processListId} className={showText ? "inno-trace-flow" : "inno-trace-list"} role="list">
				{renderedFlow}
				{pendingQuestion && pendingQuestionIndex < 0 ? (
					<>
						<TraceRow
							rowId={`pending-question:${pendingQuestion.questionId}`}
							step={pendingQuestionTraceStep(pendingQuestion.questionId)}
							isCurrentLiveStep
							expanded={false}
							onToggleId={NOOP_TOGGLE}
							t={t}
							onOpenSkill={onOpenSkill}
						/>
						<div className="inno-trace-questionnaire">
							{pendingQuestion.card}
						</div>
					</>
				) : null}
				{showFallbackText ? (
					isSending || liveBodies ? (
						<LiveTraceBody key="trace-body:0" content={fallbackText ?? ""} animate={isSending} />
					) : (
						<div className="inno-trace-fallback-body">
							<TraceBody content={fallbackText ?? ""} />
						</div>
					)
				) : null}
				{showText ? answeredQuestionnaires.filter((view) => !matchedQuestionnaireIds.has(view.tool.toolCallId)).map((view) => (
					<div className="inno-trace-questionnaire" key={`questionnaire:${view.tool.toolCallId}`}>
						<AnsweredQuestionCard questionnaire={view.questionnaire} />
					</div>
				)) : null}
				{trailingCard ? (
					<div className="inno-trace-questionnaire">
						{trailingCard}
					</div>
				) : null}
			</div>
			<AnimatePresence initial={false}>
				{showLiveFooter ? (
					<motion.div
						key="live-footer"
						className="inno-trace-collapsible"
						initial={{ height: 0, opacity: 0 }}
						animate={{ height: "auto", opacity: 1 }}
						exit={{ height: 0, opacity: 0 }}
						transition={transition}
					>
						<TraceLiveFooter
							label={t("chat.trace.processed", "已处理")}
							startedAtMs={started}
						/>
					</motion.div>
				) : null}
			</AnimatePresence>
		</div>
	);
}
