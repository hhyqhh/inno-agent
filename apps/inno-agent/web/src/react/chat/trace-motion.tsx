import {
	memo,
	useCallback,
	useEffect,
	useRef,
	useState,
	type CSSProperties,
	type ReactNode,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useUITransition } from "../ui/index.js";

/* ─── Collapsible height + opacity transition ─── */

/**
 * Smooth height + opacity disclosure modeled on ZCode's Collapsible:
 * - Outer layer animates height (0 <-> auto) with overflow hidden.
 * - Inner layer animates opacity and owns all vertical spacing so collapsing
 *   to 0 never suffers a last-frame jump when margins/gaps disappear.
 * - Heavy children stay mounted until the collapse animation finishes.
 */
export const TraceCollapsible = memo(function TraceCollapsible({
	open,
	id,
	className,
	children,
}: {
	open: boolean;
	id?: string;
	className?: string;
	children: ReactNode;
}) {
	const transition = useUITransition("modal");
	return (
		<AnimatePresence initial={false}>
			{open ? (
				<motion.div
					key="collapsible"
					id={id}
					className={className ? `inno-trace-collapsible ${className}` : "inno-trace-collapsible"}
					data-state="open"
					initial={{ height: 0, opacity: 0 }}
					animate={{ height: "auto", opacity: 1 }}
					exit={{ height: 0, opacity: 0 }}
					transition={transition}
				>
					<div className="inno-trace-collapsible-inner">
						{children}
					</div>
				</motion.div>
			) : null}
		</AnimatePresence>
	);
});

/* ─── Vertical rolling summary queue (ZCode QueuedSummaryContent) ─── */

export const SUMMARY_ROLL_TRANSITION_MS = 220;
export const SUMMARY_ROLL_HOLD_MS = 480;
export const SUMMARY_ROLL_TOTAL_MS = SUMMARY_ROLL_TRANSITION_MS + SUMMARY_ROLL_HOLD_MS;
const SUMMARY_ROLL_TIMER_DRIFT_SKIP_MS = 250;
const SUMMARY_ROLL_MAX_PENDING = 2;

interface SummarySnapshot {
	key: string;
	content: ReactNode;
}

function nowMs(): number {
	return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export function resolveQueuedSummaryPlaybackQueue<T>(
	queued: readonly T[],
	timerDriftMs: number,
): T[] {
	// Skip stale intermediate items after main-thread jank instead of replaying old states.
	if (timerDriftMs > SUMMARY_ROLL_TIMER_DRIFT_SKIP_MS && queued.length > 1) {
		return queued.slice(-1);
	}
	return [...queued];
}

export const QueuedSummaryRoll = memo(function QueuedSummaryRoll({
	contentKey,
	refreshVersion,
	enabled = true,
	className,
	children,
}: {
	contentKey: string;
	refreshVersion?: unknown;
	enabled?: boolean;
	className?: string;
	children: ReactNode;
}) {
	const reduced = useReducedMotion();
	if (!enabled || reduced) {
		return (
			<span className={className ? `inno-trace-roll-static ${className}` : "inno-trace-roll-static"}>
				{children}
			</span>
		);
	}
	return (
		<AnimatedSummaryRoll
			className={className}
			contentKey={contentKey}
			refreshVersion={refreshVersion}
			content={children}
		/>
	);
});

function AnimatedSummaryRoll({
	contentKey,
	refreshVersion,
	content,
	className,
}: {
	contentKey: string;
	refreshVersion?: unknown;
	content: ReactNode;
	className?: string;
}) {
	const transition = useUITransition("layout");
	const [displayedKey, setDisplayedKey] = useState(contentKey);
	const displayedRef = useRef<SummarySnapshot>({ key: contentKey, content });
	const latestRef = useRef<SummarySnapshot>({ key: contentKey, content });
	const queueRef = useRef<SummarySnapshot[]>([]);
	const timerRef = useRef<number | null>(null);
	const animatingRef = useRef(false);

	latestRef.current = { key: contentKey, content };

	// Keep same-key live token updates zero-overhead: only refresh the stored
	// snapshot in ref without re-running queue scheduling effects on every chunk.
	useEffect(() => {
		if (displayedRef.current.key === contentKey) {
			displayedRef.current = { key: contentKey, content };
		} else {
			const queue = queueRef.current;
			const existingIndex = queue.findIndex((item) => item.key === contentKey);
			if (existingIndex >= 0) {
				const copy = [...queue];
				copy[existingIndex] = { key: contentKey, content };
				queueRef.current = copy;
			}
		}
	}, [contentKey, refreshVersion, content]);

	useEffect(() => {
		if (displayedRef.current.key === contentKey) return;

		const clearTimer = () => {
			if (timerRef.current !== null) {
				window.clearTimeout(timerRef.current);
				timerRef.current = null;
			}
		};
		const enqueue = (next: SummarySnapshot) => {
			const queue = queueRef.current;
			const existingIndex = queue.findIndex((item) => item.key === next.key);
			if (existingIndex >= 0) {
				const copy = [...queue];
				copy[existingIndex] = next;
				queueRef.current = copy;
				return;
			}
			if (queue.length === 0) {
				queueRef.current = [next];
				return;
			}
			// Keep at most two pending entries: the next committed slot and the latest preemptible slot.
			queueRef.current = [queue[0]!, next].slice(0, SUMMARY_ROLL_MAX_PENDING);
		};
		const promote = (next: SummarySnapshot) => {
			displayedRef.current = next;
			setDisplayedKey(next.key);
			animatingRef.current = true;
			clearTimer();
			const expectedAt = nowMs() + SUMMARY_ROLL_TOTAL_MS;
			timerRef.current = window.setTimeout(() => {
				animatingRef.current = false;
				timerRef.current = null;
				const drift = nowMs() - expectedAt;
				const nextQueue = resolveQueuedSummaryPlaybackQueue(queueRef.current, drift);
				const [head, ...rest] = nextQueue;
				if (!head) {
					queueRef.current = [];
					return;
				}
				queueRef.current = rest;
				promote(head);
			}, SUMMARY_ROLL_TOTAL_MS);
		};

		const nextSnapshot = latestRef.current;
		if (animatingRef.current || queueRef.current.length > 0) {
			enqueue(nextSnapshot);
			return;
		}
		promote(nextSnapshot);
	}, [contentKey]);

	useEffect(() => () => {
		if (timerRef.current !== null) window.clearTimeout(timerRef.current);
	}, []);

	const renderedContent = contentKey === displayedKey ? content : displayedRef.current.content;

	return (
		<span className={className ? `inno-trace-roll ${className}` : "inno-trace-roll"}>
			<AnimatePresence initial={false} mode="popLayout">
				<motion.span
					key={displayedKey}
					className="inno-trace-roll-item"
					initial={{ y: "0.8em", opacity: 0 }}
					animate={{ y: 0, opacity: 1 }}
					exit={{ y: "-0.8em", opacity: 0 }}
					transition={transition}
				>
					{renderedContent}
				</motion.span>
			</AnimatePresence>
		</span>
	);
}

/* ─── Streaming single-line summary: horizontal tail follow + edge mask ─── */

const HORIZONTAL_SUMMARY_MASK =
	"linear-gradient(to right, transparent 0, black 16px, black calc(100% - 16px), transparent 100%)";

export function resolveThinkingStreamingSummary(
	text: string | undefined,
): { key: string; text: string } | null {
	if (!text) return null;
	const lines = text.replace(/\r\n?/gu, "\n").split("\n");
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const cleaned = (lines[index] ?? "")
			.replace(/[`*_#>|[\]()]/g, "")
			.replace(/\s+/g, " ")
			.trim();
		if (cleaned.length > 0) {
			return { key: String(index), text: cleaned };
		}
	}
	return null;
}

export function getHorizontalMaskStyle(overflowing: boolean): CSSProperties | undefined {
	if (!overflowing) return undefined;
	return {
		WebkitMaskImage: HORIZONTAL_SUMMARY_MASK,
		maskImage: HORIZONTAL_SUMMARY_MASK,
		WebkitMaskRepeat: "no-repeat",
		maskRepeat: "no-repeat",
		WebkitMaskSize: "100% 100%",
		maskSize: "100% 100%",
	};
}

export const StreamingSummaryLine = memo(function StreamingSummaryLine({
	summaryKey,
	summaryText,
	enabled = true,
}: {
	summaryKey: string;
	summaryText: string;
	enabled?: boolean;
}) {
	const viewportRef = useRef<HTMLSpanElement | null>(null);
	const textRef = useRef<HTMLSpanElement | null>(null);
	const rafRef = useRef<number | null>(null);
	const dirtyRef = useRef(false);
	const mountedRef = useRef(false);
	const [overflowing, setOverflowing] = useState(false);

	const measureNow = useCallback(() => {
		const viewport = viewportRef.current;
		if (!viewport) return;
		const next = viewport.scrollWidth > viewport.clientWidth + 1;
		setOverflowing((prev) => (prev === next ? prev : next));
		viewport.scrollLeft = viewport.scrollWidth;
	}, []);

	// Coalesce rapid per-token layout reads/writes to at most once per animation
	// frame while still measuring synchronously on initial mount so the first
	// frame never flashes un-scrolled text.
	const scheduleMeasure = useCallback(() => {
		if (!mountedRef.current) {
			mountedRef.current = true;
			measureNow();
			return;
		}
		if (rafRef.current !== null) {
			dirtyRef.current = true;
			return;
		}
		if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
			measureNow();
			return;
		}
		rafRef.current = window.requestAnimationFrame(() => {
			rafRef.current = null;
			measureNow();
			if (dirtyRef.current) {
				dirtyRef.current = false;
				scheduleMeasure();
			}
		});
	}, [measureNow]);

	// Attach ResizeObserver once on mount instead of tearing it down on every token.
	useEffect(() => {
		const viewport = viewportRef.current;
		if (!viewport || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(scheduleMeasure);
		observer.observe(viewport);
		if (textRef.current) observer.observe(textRef.current);
		return () => {
			observer.disconnect();
			if (rafRef.current !== null) {
				window.cancelAnimationFrame(rafRef.current);
				rafRef.current = null;
			}
		};
	}, [scheduleMeasure]);

	useEffect(() => {
		if (!summaryText) return;
		scheduleMeasure();
	}, [summaryKey, summaryText, scheduleMeasure]);

	return (
		<span
			ref={viewportRef}
			className="inno-trace-streaming-line"
			data-streaming-mask={overflowing ? "both" : "none"}
			style={getHorizontalMaskStyle(overflowing)}
		>
			<QueuedSummaryRoll
				contentKey={`thinking-line:${summaryKey}`}
				refreshVersion={summaryText}
				enabled={enabled}
			>
				<span ref={textRef} className="inno-trace-streaming-text">
					{summaryText}
				</span>
			</QueuedSummaryRoll>
		</span>
	);
});

/* ─── Bottom-following scroll container + top/bottom edge mask (ZCode scrollMask) ─── */

const SCROLL_MASK_EDGE_PX = 24;
const SCROLL_MASK_THRESHOLD_PX = 1;

interface ScrollMaskState {
	showTop: boolean;
	showBottom: boolean;
}

const EMPTY_SCROLL_MASK: ScrollMaskState = { showTop: false, showBottom: false };

function computeVerticalMaskStyle({ showTop, showBottom }: ScrollMaskState): CSSProperties | undefined {
	if (!showTop && !showBottom) return undefined;
	const topStop = showTop
		? `transparent 0px, black ${SCROLL_MASK_EDGE_PX}px`
		: `black 0px, black ${SCROLL_MASK_EDGE_PX}px`;
	const bottomStop = showBottom
		? `black calc(100% - ${SCROLL_MASK_EDGE_PX}px), transparent 100%`
		: `black calc(100% - ${SCROLL_MASK_EDGE_PX}px), black 100%`;
	const maskImage = `linear-gradient(to bottom, ${topStop}, ${bottomStop})`;
	return {
		WebkitMaskImage: maskImage,
		maskImage,
		WebkitMaskRepeat: "no-repeat",
		maskRepeat: "no-repeat",
		WebkitMaskSize: "100% 100%",
		maskSize: "100% 100%",
	};
}

export function useBottomFollowingScroll(
	active: boolean,
	contentVersion: unknown,
	autoFollow = true,
) {
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const contentRef = useRef<HTMLDivElement | null>(null);
	const followingRef = useRef(autoFollow);
	const rafRef = useRef<number | null>(null);
	const [mask, setMask] = useState<ScrollMaskState>(EMPTY_SCROLL_MASK);

	const updateMask = useCallback(() => {
		const el = scrollRef.current;
		if (!el) {
			setMask(EMPTY_SCROLL_MASK);
			return;
		}
		const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
		const next: ScrollMaskState = maxScrollTop <= SCROLL_MASK_THRESHOLD_PX
			? EMPTY_SCROLL_MASK
			: {
				showTop: el.scrollTop > SCROLL_MASK_THRESHOLD_PX,
				showBottom: el.scrollTop < maxScrollTop - SCROLL_MASK_THRESHOLD_PX,
			};
		setMask((prev) =>
			prev.showTop === next.showTop && prev.showBottom === next.showBottom ? prev : next,
		);
	}, []);

	const syncNow = useCallback(() => {
		const el = scrollRef.current;
		// Only auto-scroll to the bottom when streaming live; settled details
		// open at the top so the user can read from the beginning.
		if (el && autoFollow && followingRef.current) el.scrollTop = el.scrollHeight;
		updateMask();
	}, [autoFollow, updateMask]);

	const scheduleSync = useCallback(() => {
		if (rafRef.current !== null) return;
		if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
			syncNow();
			return;
		}
		rafRef.current = window.requestAnimationFrame(() => {
			rafRef.current = null;
			syncNow();
		});
	}, [syncNow]);

	const onScroll = useCallback(() => {
		const el = scrollRef.current;
		if (!el) return;
		followingRef.current = autoFollow && Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop) <= 2;
		updateMask();
	}, [autoFollow, updateMask]);

	useEffect(() => {
		if (!active) {
			followingRef.current = autoFollow;
			setMask(EMPTY_SCROLL_MASK);
			if (rafRef.current !== null) {
				window.cancelAnimationFrame(rafRef.current);
				rafRef.current = null;
			}
			return;
		}
		followingRef.current = autoFollow;
		syncNow();
		const el = scrollRef.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(scheduleSync);
		observer.observe(el);
		if (contentRef.current) observer.observe(contentRef.current);
		return () => {
			observer.disconnect();
			if (rafRef.current !== null) {
				window.cancelAnimationFrame(rafRef.current);
				rafRef.current = null;
			}
		};
	}, [active, autoFollow, syncNow, scheduleSync]);

	useEffect(() => {
		if (active) scheduleSync();
	}, [active, contentVersion, scheduleSync]);

	const maskData = mask.showTop
		? (mask.showBottom ? "both" : "top")
		: (mask.showBottom ? "bottom" : "none");

	return {
		scrollRef,
		contentRef,
		onScroll,
		maskData,
		maskStyle: computeVerticalMaskStyle(mask),
	};
}

/* ─── Stable group identity across streaming appends (ZCode useContinuousGroupKeys) ─── */

interface GroupIdentity<T> {
	items: readonly T[];
	keys: string[];
	nextId: number;
}

export function useContinuousGroupKeys<T>(
	items: readonly T[],
	describe: (item: T) => { kind: string; memberKeys: readonly string[]; fixedKey?: string },
): string[] {
	const reconcile = (previous?: GroupIdentity<T>): GroupIdentity<T> => {
		const previousMembers = new Map<string, { kind: string; key: string }>();
		previous?.items.forEach((item, index) => {
			const desc = describe(item);
			if (desc.fixedKey !== undefined) return;
			const identity = { kind: desc.kind, key: previous.keys[index]! };
			for (const memberKey of desc.memberKeys) previousMembers.set(memberKey, identity);
		});
		const usedKeys = new Set<string>();
		let nextId = previous?.nextId ?? 0;
		const keys = items.map((item) => {
			const desc = describe(item);
			if (desc.fixedKey !== undefined) return desc.fixedKey;
			const inherited = desc.memberKeys
				.map((memberKey) => previousMembers.get(memberKey))
				.find((identity) => identity?.kind === desc.kind && !usedKeys.has(identity.key));
			const key = inherited?.key ?? `${desc.kind}:${desc.memberKeys[0] ?? nextId}:${nextId++}`;
			usedKeys.add(key);
			return key;
		});
		return { items, keys, nextId };
	};
	const [previous, setIdentity] = useState(() => reconcile());
	const identity = previous.items === items ? previous : reconcile(previous);
	if (identity !== previous) setIdentity(identity);
	return identity.keys;
}
