import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type RefObject,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Clock3, FileText, Image as ImageIcon, Wrench } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ChatMessage, ChatToolRecord } from "../types/chat.js";

export interface ConversationTurn {
	id: string;
	index: number;
	startMessageIndex: number;
	endMessageIndex: number;
	userMessage?: ChatMessage;
	assistantMessages: ChatMessage[];
}

interface ConversationMinimapProps {
	messages: ChatMessage[];
	scrollContainerRef: RefObject<HTMLDivElement | null>;
	onNavigateStart?: () => void;
}

interface TurnPosition {
	index: number;
	contentTop: number;
}

const MAX_VISIBLE_TURNS = 11;
const MARKER_GAP = 10;

const TOOL_PATH_KEYS = new Set([
	"path",
	"file",
	"file_path",
	"filepath",
	"filePath",
	"target",
	"output",
	"outputPath",
	"destination",
]);

export function buildConversationTurns(messages: ChatMessage[]): ConversationTurn[] {
	const turns: ConversationTurn[] = [];
	let current: ConversationTurn | null = null;

	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index];
		if (message.role === "user" || !current) {
			if (current) turns.push(current);
			current = {
				id: `${message.timestamp}-${index}`,
				index: turns.length,
				startMessageIndex: index,
				endMessageIndex: index,
				userMessage: message.role === "user" ? message : undefined,
				assistantMessages: message.role === "assistant" ? [message] : [],
			};
			continue;
		}

		current.endMessageIndex = index;
		current.assistantMessages.push(message);
	}

	if (current) turns.push(current);
	return turns;
}

function plainPreview(content: string, maxLength: number): string {
	const normalized = content
		.replace(/```[\s\S]*?```/g, " 代码片段 ")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, " 图片 ")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/<[^>]+>/g, " ")
		.replace(/[#>*_`~|]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function collectFileNames(tools: ChatToolRecord[]): string[] {
	const names = new Set<string>();
	const visit = (value: unknown, depth: number, key?: string) => {
		if (depth > 4 || value === null || value === undefined) return;
		if (typeof value === "string") {
			if (!key || !TOOL_PATH_KEYS.has(key)) return;
			const cleaned = value.trim().replace(/[?#].*$/, "");
			if (!cleaned || cleaned.length > 240) return;
			const leaf = cleaned.split(/[\\/]/).filter(Boolean).at(-1) ?? cleaned;
			if (leaf && leaf.length <= 80) names.add(leaf);
			return;
		}
		if (Array.isArray(value)) {
			for (const item of value) visit(item, depth + 1, key);
			return;
		}
		if (typeof value === "object") {
			for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
				visit(childValue, depth + 1, childKey);
			}
		}
	};

	for (const tool of tools) {
		visit(tool.args, 0);
		visit(tool.result, 0);
	}
	return Array.from(names);
}

function formatTurnTime(timestamp: number): string {
	if (!Number.isFinite(timestamp)) return "";
	return new Date(timestamp).toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
	});
}

function markerWidth(turn: ConversationTurn): number {
	const userLength = turn.userMessage?.content.length ?? 0;
	const assistantLength = turn.assistantMessages.reduce((sum, message) => sum + message.content.length, 0);
	return Math.min(28, 10 + Math.round(Math.log2(Math.max(2, userLength + assistantLength)) * 1.8));
}

export function ConversationMinimap({
	messages,
	scrollContainerRef,
	onNavigateStart,
}: ConversationMinimapProps) {
	const { t } = useTranslation();
	const reduceMotion = useReducedMotion();
	const trackRef = useRef<HTMLDivElement | null>(null);
	const positionsRef = useRef<TurnPosition[]>([]);
	const frameRef = useRef<number | null>(null);
	const hideTimerRef = useRef<number | null>(null);
	const [trackHeight, setTrackHeight] = useState(0);
	const [hasOverflow, setHasOverflow] = useState(false);
	const [activeIndex, setActiveIndex] = useState(0);
	const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
	const turns = useMemo(() => buildConversationTurns(messages), [messages]);
	const visibleTurns = useMemo(() => {
		if (turns.length <= MAX_VISIBLE_TURNS) return turns;
		const focusIndex = hoveredIndex ?? activeIndex;
		const halfWindow = Math.floor(MAX_VISIBLE_TURNS / 2);
		const start = Math.max(0, Math.min(turns.length - MAX_VISIBLE_TURNS, focusIndex - halfWindow));
		return turns.slice(start, start + MAX_VISIBLE_TURNS);
	}, [activeIndex, hoveredIndex, turns]);
	const markerYByTurnIndex = useMemo(() => {
		const stackSpan = Math.max(0, (visibleTurns.length - 1) * MARKER_GAP);
		const firstY = trackHeight / 2 - stackSpan / 2;
		return new Map(visibleTurns.map((turn, index) => [turn.index, firstY + index * MARKER_GAP]));
	}, [trackHeight, visibleTurns]);

	const updateActiveTurn = useCallback(() => {
		const scrollElement = scrollContainerRef.current;
		const turnPositions = positionsRef.current;
		if (!scrollElement || turnPositions.length === 0) return;

		if (scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight < 24) {
			setActiveIndex(turnPositions.at(-1)?.index ?? 0);
			return;
		}

		const focusLine = scrollElement.scrollTop + scrollElement.clientHeight * 0.3;
		let next = turnPositions[0].index;
		for (const position of turnPositions) {
			if (position.contentTop > focusLine) break;
			next = position.index;
		}
		setActiveIndex(next);
	}, [scrollContainerRef]);

	const measure = useCallback(() => {
		const scrollElement = scrollContainerRef.current;
		const trackElement = trackRef.current;
		if (!scrollElement || !trackElement || turns.length === 0) {
			positionsRef.current = [];
			setHasOverflow(false);
			return;
		}

		const scrollRect = scrollElement.getBoundingClientRect();
		const height = trackElement.clientHeight;
		const contentHeight = Math.max(1, scrollElement.scrollHeight);
		const next = turns.map((turn) => {
			const anchor = scrollElement.querySelector<HTMLElement>(`[data-conversation-turn="${turn.index}"]`);
			const contentTop = anchor
				? anchor.getBoundingClientRect().top - scrollRect.top + scrollElement.scrollTop
				: (turn.index / Math.max(1, turns.length - 1)) * contentHeight;
			return {
				index: turn.index,
				contentTop,
			};
		});

		positionsRef.current = next;
		setTrackHeight(height);
		setHasOverflow(scrollElement.scrollHeight - scrollElement.clientHeight > 64);
		updateActiveTurn();
	}, [scrollContainerRef, turns, updateActiveTurn]);

	const scheduleMeasure = useCallback(() => {
		if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
		frameRef.current = requestAnimationFrame(() => {
			frameRef.current = null;
			measure();
		});
	}, [measure]);

	useEffect(() => {
		const scrollElement = scrollContainerRef.current;
		const trackElement = trackRef.current;
		if (!scrollElement || !trackElement) return;

		const handleScroll = () => updateActiveTurn();
		const resizeObserver = new ResizeObserver(scheduleMeasure);
		resizeObserver.observe(scrollElement);
		resizeObserver.observe(trackElement);
		const contentElement = scrollElement.querySelector<HTMLElement>("[data-conversation-content]");
		if (contentElement) resizeObserver.observe(contentElement);
		for (const anchor of scrollElement.querySelectorAll<HTMLElement>("[data-conversation-turn]")) {
			resizeObserver.observe(anchor);
		}
		scrollElement.addEventListener("scroll", handleScroll, { passive: true });
		scheduleMeasure();

		return () => {
			scrollElement.removeEventListener("scroll", handleScroll);
			resizeObserver.disconnect();
			if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
		};
	}, [scrollContainerRef, scheduleMeasure, turns.length, updateActiveTurn]);

	useEffect(() => () => {
		if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
	}, []);

	const keepPreviewOpen = useCallback(() => {
		if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
		hideTimerRef.current = null;
	}, []);

	const showPreview = useCallback((index: number) => {
		keepPreviewOpen();
		setHoveredIndex(index);
	}, [keepPreviewOpen]);

	const schedulePreviewClose = useCallback(() => {
		keepPreviewOpen();
		hideTimerRef.current = window.setTimeout(() => setHoveredIndex(null), 90);
	}, [keepPreviewOpen]);

	const jumpToTurn = useCallback((turn: ConversationTurn) => {
		const scrollElement = scrollContainerRef.current;
		if (!scrollElement) return;
		const anchor = scrollElement.querySelector<HTMLElement>(`[data-conversation-turn="${turn.index}"]`);
		if (!anchor) return;
		onNavigateStart?.();
		const scrollRect = scrollElement.getBoundingClientRect();
		const targetTop = anchor.getBoundingClientRect().top - scrollRect.top + scrollElement.scrollTop - 20;
		scrollElement.scrollTo({
			top: Math.max(0, targetTop),
			behavior: reduceMotion ? "auto" : "smooth",
		});
		setActiveIndex(turn.index);
	}, [onNavigateStart, reduceMotion, scrollContainerRef]);

	if (turns.length < 2) return null;

	const hoveredTurn = hoveredIndex === null ? null : turns[hoveredIndex] ?? null;
	const previewTools = hoveredTurn?.assistantMessages.flatMap((message) => message.tools ?? []) ?? [];
	const toolNames = Array.from(new Set(previewTools.map((tool) => tool.toolName)));
	const fileNames = collectFileNames(previewTools);
	const imageCount = hoveredTurn
		? [hoveredTurn.userMessage, ...hoveredTurn.assistantMessages]
			.filter((message): message is ChatMessage => Boolean(message))
			.reduce((sum, message) => sum + (message.images?.length ?? 0), 0)
		: 0;
	const hoveredMarkerY = hoveredIndex === null ? null : markerYByTurnIndex.get(hoveredIndex) ?? null;
	const tooltipY = hoveredMarkerY === null
		? trackHeight / 2
		: trackHeight < 236
			? trackHeight / 2
			: Math.max(118, Math.min(trackHeight - 118, hoveredMarkerY));
	const title = hoveredTurn
		? plainPreview(
			hoveredTurn.userMessage?.content
				?? hoveredTurn.assistantMessages[0]?.content
				?? t("chat.minimap.emptyTurn"),
			150,
		)
		: "";
	const answerPreview = hoveredTurn
		? plainPreview(hoveredTurn.assistantMessages.map((message) => message.content).filter(Boolean).join(" "), 260)
		: "";

	return (
		<nav
			className={`conversation-minimap pointer-events-none absolute inset-y-4 left-0 z-20 w-10 ${hasOverflow ? "" : "invisible"}`}
			aria-label={t("chat.minimap.navigation")}
			aria-hidden={hasOverflow ? undefined : true}
		>
			<div ref={trackRef} className="pointer-events-auto relative h-full w-full">
				<AnimatePresence initial={false}>
				{visibleTurns.map((turn) => {
					const markerY = markerYByTurnIndex.get(turn.index) ?? trackHeight / 2;
					const current = turn.index === activeIndex;
					const hovered = turn.index === hoveredIndex;
					const highlighted = hoveredIndex === null ? current : hovered;
					return (
						<motion.button
							key={turn.id}
							type="button"
							className="group absolute left-1.5 flex h-2.5 w-9 -translate-y-1/2 items-center rounded-sm outline-none"
							initial={reduceMotion ? false : { opacity: 0, x: -6 }}
							animate={{ top: markerY, opacity: 1, x: 0 }}
							exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: -4 }}
							transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 520, damping: 38, mass: 0.45 }}
							aria-label={t("chat.minimap.jumpToTurn", { count: turn.index + 1, title: plainPreview(turn.userMessage?.content ?? "", 60) })}
							aria-current={current ? "location" : undefined}
							onMouseEnter={() => showPreview(turn.index)}
							onMouseLeave={schedulePreviewClose}
							onFocus={() => showPreview(turn.index)}
							onBlur={schedulePreviewClose}
							onClick={() => jumpToTurn(turn)}
						>
							<motion.span
								className="block h-[3px] origin-left rounded-full shadow-[0_0_0_1px_color-mix(in_srgb,var(--inno-chat-bg)_40%,transparent)]"
								animate={{
									width: highlighted ? 34 : markerWidth(turn),
									backgroundColor: highlighted ? "var(--inno-accent)" : "var(--inno-border-strong)",
									opacity: highlighted ? 1 : 0.62,
								}}
								transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 520, damping: 34, mass: 0.45 }}
							/>
						</motion.button>
					);
				})}
				</AnimatePresence>

				<AnimatePresence>
					{hoveredTurn ? (
						<motion.div
							key={hoveredTurn.id}
							className="pointer-events-auto absolute left-10 z-30"
							style={{
								top: tooltipY,
								width: "min(360px, calc(100cqw - 56px))",
							}}
							initial={reduceMotion ? { opacity: 0 } : { opacity: 0, x: -10, scale: 0.97 }}
							animate={{ opacity: 1, x: 0, scale: 1 }}
							exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: -6, scale: 0.985 }}
							transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 420, damping: 32, mass: 0.55 }}
							onMouseEnter={keepPreviewOpen}
							onMouseLeave={schedulePreviewClose}
						>
							<div className="max-h-[216px] -translate-y-1/2 overflow-hidden rounded-xl border border-[var(--inno-border)] bg-[color-mix(in_srgb,var(--inno-surface)_94%,transparent)] p-3.5 text-left shadow-[0_16px_48px_rgba(0,0,0,0.18)] backdrop-blur-xl">
							<div className="mb-2 flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--inno-text-subtle)]">
								<span>{t("chat.minimap.turn", { count: hoveredTurn.index + 1 })}</span>
								<span className="h-0.5 w-0.5 rounded-full bg-[var(--inno-border-strong)]" />
								<span className="inline-flex items-center gap-1 normal-case tracking-normal">
									<Clock3 size={11} />
									{formatTurnTime(hoveredTurn.userMessage?.timestamp ?? hoveredTurn.assistantMessages[0]?.timestamp ?? 0)}
								</span>
							</div>
							<div className="line-clamp-2 text-[13px] font-semibold leading-5 text-[var(--inno-text)]">{title}</div>
							{answerPreview ? (
								<div className="mt-2 line-clamp-3 text-xs leading-5 text-[var(--inno-text-muted)]">{answerPreview}</div>
							) : null}
							{fileNames.length > 0 || toolNames.length > 0 || imageCount > 0 ? (
								<div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-[var(--inno-border)] pt-2.5 text-[10px] text-[var(--inno-text-muted)]">
									{fileNames.slice(0, 2).map((fileName) => (
										<span key={fileName} className="inline-flex max-w-[150px] items-center gap-1 rounded-md bg-[var(--inno-surface-muted)] px-1.5 py-1">
											<FileText size={12} className="shrink-0" />
											<span className="truncate">{fileName}</span>
										</span>
									))}
									{fileNames.length > 2 ? <span>+{fileNames.length - 2}</span> : null}
									{fileNames.length === 0 && toolNames.slice(0, 2).map((toolName) => (
										<span key={toolName} className="inline-flex max-w-[150px] items-center gap-1 rounded-md bg-[var(--inno-surface-muted)] px-1.5 py-1">
											<Wrench size={12} className="shrink-0" />
											<span className="truncate">{toolName}</span>
										</span>
									))}
									{imageCount > 0 ? (
										<span className="inline-flex items-center gap-1 rounded-md bg-[var(--inno-surface-muted)] px-1.5 py-1">
											<ImageIcon size={12} /> {imageCount}
										</span>
									) : null}
								</div>
							) : null}
							</div>
						</motion.div>
					) : null}
				</AnimatePresence>
			</div>
		</nav>
	);
}
