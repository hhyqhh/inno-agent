import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, CornerUpLeft, Loader2, MessageCircleQuestion, Minimize2, Plus, RotateCcw, SendHorizontal, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { btwStore } from "../stores/btw-store.js";
import { chatStore } from "../stores/chat-store.js";
import { sessionsStore } from "../stores/sessions-store.js";
import { useStoreSnapshot } from "./hooks.js";
import { MarkdownArtifact } from "./MarkdownArtifact.js";
import { getSession } from "../api/sessions.js";
import {
	constrainBtwGeometry,
	defaultBtwGeometry,
	moveBtwGeometry,
	resizeBtwGeometry,
	type BtwResizeEdge,
	type BtwViewportSize,
} from "../utils/btw-window.js";
import type { BtwExchange, BtwTabState, BtwWindowGeometry } from "../types/btw.js";

const BTW_DRAG_MOVE_THRESHOLD = 5;

interface GeometryInteractionState {
	pointerId: number;
	startX: number;
	startY: number;
	geometry: BtwWindowGeometry;
	latestGeometry: BtwWindowGeometry;
}

interface DragState extends GeometryInteractionState {
	active: boolean;
}

interface ResizeState extends GeometryInteractionState {
	edge: BtwResizeEdge;
}

const RESIZE_HANDLES: Array<{ edge: BtwResizeEdge; className: string }> = [
	{ edge: "n", className: "inno-btw-resize-handle-n" },
	{ edge: "ne", className: "inno-btw-resize-handle-ne" },
	{ edge: "e", className: "inno-btw-resize-handle-e" },
	{ edge: "se", className: "inno-btw-resize-handle-se" },
	{ edge: "s", className: "inno-btw-resize-handle-s" },
	{ edge: "sw", className: "inno-btw-resize-handle-sw" },
	{ edge: "w", className: "inno-btw-resize-handle-w" },
	{ edge: "nw", className: "inno-btw-resize-handle-nw" },
];

/**
 * A floating side-question window. Its contents are deliberately rendered
 * outside the main composer flow so opening, focusing, dragging, and resizing
 * never move the primary conversation input.
 */
export function BtwPanel() {
	const { t } = useTranslation();
	const sessionId = useStoreSnapshot(sessionsStore, () => sessionsStore.currentSessionId);
	const btw = useStoreSnapshot(btwStore, () => {
		const session = btwStore.sessionFor(sessionsStore.currentSessionId);
		const activeTab = btwStore.activeTabFor(sessionsStore.currentSessionId);
		const boundToCurrent = btwStore.activeSessionId === sessionsStore.currentSessionId;
		return {
			visible: btwStore.isVisible && boundToCurrent,
			// Initial state load failed: show a recovery card instead of tabs so a
			// fabricated empty state can never overwrite the persisted history.
			loadError: boundToCurrent && btwStore.panelOpen && !btwStore.minimized
				? btwStore.hydrationErrorFor(sessionsStore.currentSessionId)
				: null,
			tabs: session.tabs,
			activeTab,
			geometry: btwStore.windowGeometry,
			windowInitialized: btwStore.windowInitialized,
		};
	});
	const [bringingBackId, setBringingBackId] = useState<string | null>(null);
	const [confirmingTabId, setConfirmingTabId] = useState<string | null>(null);
	const windowRef = useRef<HTMLDivElement | null>(null);
	const inputRef = useRef<HTMLTextAreaElement | null>(null);
	const listRef = useRef<HTMLDivElement | null>(null);
	const tabStripRef = useRef<HTMLDivElement | null>(null);
	const confirmCancelRef = useRef<HTMLButtonElement | null>(null);
	const confirmDeleteRef = useRef<HTMLButtonElement | null>(null);
	const focusBeforeConfirmRef = useRef<HTMLElement | null>(null);
	const dragRef = useRef<DragState | null>(null);
	const resizeRef = useRef<ResizeState | null>(null);
	const visualGeometryRef = useRef<BtwWindowGeometry | null>(null);
	const geometryFrameRef = useRef<number | null>(null);
	const nearBottomRef = useRef(true);

	useEffect(() => () => {
		dragRef.current = null;
		resizeRef.current = null;
		if (geometryFrameRef.current !== null && typeof window !== "undefined") {
			window.cancelAnimationFrame(geometryFrameRef.current);
		}
		geometryFrameRef.current = null;
	}, []);

	useEffect(() => {
		if (sessionId) void btwStore.setMainSession(sessionId);
	}, [sessionId]);

	const getViewport = (): BtwViewportSize | null => {
		const layer = windowRef.current?.parentElement;
		if (!layer) return null;
		return {
			width: layer.clientWidth,
			height: layer.clientHeight,
			composerClearance: 88,
		};
	};

	const getInteractionGeometry = (): BtwWindowGeometry | null => {
		const source = visualGeometryRef.current ?? btwStore.windowGeometry;
		const viewport = getViewport();
		return viewport ? constrainBtwGeometry(source, viewport) : null;
	};

	// Pointer events can arrive much faster than React can reconcile a panel
	// containing markdown. Keep drag/resize frames local to the DOM and commit
	// one geometry update when the pointer is released.
	const applyVisualGeometry = (geometry: BtwWindowGeometry) => {
		const element = windowRef.current;
		if (!element) return;
		element.style.left = `${geometry.x}px`;
		element.style.top = `${geometry.y}px`;
		element.style.width = `${geometry.width}px`;
		element.style.height = `${geometry.height}px`;
	};

	const cancelGeometryFrame = () => {
		if (geometryFrameRef.current === null) return;
		if (typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
			window.cancelAnimationFrame(geometryFrameRef.current);
		}
		geometryFrameRef.current = null;
	};

	const scheduleVisualGeometry = (geometry: BtwWindowGeometry) => {
		visualGeometryRef.current = { ...geometry };
		if (geometryFrameRef.current !== null) return;
		if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
			applyVisualGeometry(geometry);
			return;
		}
		geometryFrameRef.current = window.requestAnimationFrame(() => {
			geometryFrameRef.current = null;
			if (visualGeometryRef.current) applyVisualGeometry(visualGeometryRef.current);
		});
	};

	const commitVisualGeometry = (geometry: BtwWindowGeometry) => {
		cancelGeometryFrame();
		visualGeometryRef.current = { ...geometry };
		applyVisualGeometry(geometry);
		btwStore.setWindowGeometry(geometry);
		visualGeometryRef.current = null;
	};

	useLayoutEffect(() => {
		if (!btw.visible) return;
		const layer = windowRef.current?.parentElement;
		if (!layer) return;
		const updateGeometry = () => {
			const viewport = getViewport();
			if (!viewport) return;
			const next = btw.windowInitialized
				? constrainBtwGeometry(btw.geometry, viewport)
				: defaultBtwGeometry(viewport);
			const current = btwStore.windowGeometry;
			if (
				current.x !== next.x || current.y !== next.y ||
				current.width !== next.width || current.height !== next.height
			) {
				btwStore.setWindowGeometry(next);
			}
		};
		updateGeometry();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(updateGeometry);
		observer.observe(layer);
		return () => observer.disconnect();
	}, [btw.visible, btw.geometry, btw.windowInitialized]);

	useLayoutEffect(() => {
		if (!btw.visible || !btw.activeTab) return;
		inputRef.current?.focus({ preventScroll: true });
		const list = listRef.current;
		if (list) {
			list.scrollTop = btw.activeTab.scrollTop;
			nearBottomRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
		}
	}, [btw.visible, btw.activeTab?.id]);

	useEffect(() => {
		const list = listRef.current;
		if (!list || !btw.activeTab || !nearBottomRef.current) return;
		list.scrollTop = list.scrollHeight;
		btwStore.setScrollTop(sessionId ?? "", btw.activeTab.id, list.scrollTop);
	}, [btw.activeTab?.id, btw.activeTab?.exchanges.length, btw.activeTab?.exchanges.at(-1)?.answer]);

	// Keep the active tab fully visible in the strip: creating or switching to
	// a tab beyond the scroll edge must not clip its label and close button.
	useLayoutEffect(() => {
		if (!btw.activeTab) return;
		tabStripRef.current
			?.querySelector('[aria-selected="true"]')
			?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}, [btw.activeTab?.id, btw.tabs.length]);

	// Delete confirmation focus management: focus "Cancel" on open, keep Tab
	// cycling inside the dialog, Esc cancels, and focus returns to the trigger
	// on close.
	const confirmingTab = confirmingTabId ? btw.tabs.find((tab) => tab.id === confirmingTabId) : null;
	useEffect(() => {
		if (!confirmingTabId) return;
		focusBeforeConfirmRef.current = document.activeElement as HTMLElement | null;
		confirmCancelRef.current?.focus();
		return () => {
			focusBeforeConfirmRef.current?.focus?.();
			focusBeforeConfirmRef.current = null;
		};
	}, [confirmingTabId]);

	if (!sessionId || (!btw.visible && !btw.loadError)) return null;

	const activeTab = btw.activeTab;
	const pending = activeTab ? activeTab.exchanges.some((exchange) => exchange.status === "pending") : false;

	const send = () => {
		if (!activeTab) return;
		const question = activeTab.draft.trim();
		if (!question || pending) return;
		void btwStore.ask(sessionId, activeTab.id, question);
	};

	const bringBack = (exchange: BtwExchange) => {
		if (bringingBackId || !activeTab) return;
		setBringingBackId(exchange.id);
		void btwStore
			.bringBack(sessionId, activeTab.id, exchange.id)
			.then(async () => {
				if (chatStore.isSending) return;
				const session = await getSession(sessionId);
				chatStore.loadHistory(session.messages, sessionId);
			})
			.catch(() => {
				// Leave the exchange available for another attempt.
			})
			.finally(() => setBringingBackId(null));
	};

	const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault();
			send();
		}
	};

	const beginDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
		const geometry = getInteractionGeometry();
		if (event.button !== 0 || !geometry) return;
		if ((event.target as HTMLElement).closest("button, input, textarea, a")) return;
		dragRef.current = {
			pointerId: event.pointerId,
			startX: event.clientX,
			startY: event.clientY,
			geometry,
			latestGeometry: { ...geometry },
			active: false,
		};
		event.currentTarget.setPointerCapture(event.pointerId);
		event.preventDefault();
	};

	const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
		const drag = dragRef.current;
		if (!drag || drag.pointerId !== event.pointerId) return;
		if (!drag.active) {
			const movedX = event.clientX - drag.startX;
			const movedY = event.clientY - drag.startY;
			if (Math.hypot(movedX, movedY) <= BTW_DRAG_MOVE_THRESHOLD) return;
			drag.active = true;
		}
		const viewport = getViewport();
		if (!viewport) return;
		const nextGeometry = moveBtwGeometry(
			drag.geometry,
			event.clientX - drag.startX,
			event.clientY - drag.startY,
			viewport,
		);
		drag.latestGeometry = nextGeometry;
		scheduleVisualGeometry(nextGeometry);
	};

	const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
		const drag = dragRef.current;
		if (drag?.pointerId !== event.pointerId) return;
		dragRef.current = null;
		if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
		if (!drag.active) return;
		const geometry = drag.latestGeometry;
		commitVisualGeometry(geometry);
		btwStore.flushPersistence(sessionId);
	};

	const beginResize = (event: ReactPointerEvent<HTMLDivElement>, edge: BtwResizeEdge) => {
		const geometry = getInteractionGeometry();
		if (event.button !== 0 || !geometry) return;
		resizeRef.current = {
			pointerId: event.pointerId,
			startX: event.clientX,
			startY: event.clientY,
			geometry,
			latestGeometry: { ...geometry },
			edge,
		};
		event.currentTarget.setPointerCapture(event.pointerId);
		event.stopPropagation();
		event.preventDefault();
	};

	const moveResize = (event: ReactPointerEvent<HTMLDivElement>) => {
		const resize = resizeRef.current;
		if (!resize || resize.pointerId !== event.pointerId) return;
		const viewport = getViewport();
		if (!viewport) return;
		const nextGeometry = resizeBtwGeometry(
			resize.geometry,
			resize.edge,
			event.clientX - resize.startX,
			event.clientY - resize.startY,
			viewport,
		);
		resize.latestGeometry = nextGeometry;
		scheduleVisualGeometry(nextGeometry);
	};

	const endResize = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (resizeRef.current?.pointerId !== event.pointerId) return;
		const geometry = resizeRef.current.latestGeometry;
		resizeRef.current = null;
		if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
		commitVisualGeometry(geometry);
		btwStore.flushPersistence(sessionId);
	};

	const closeTab = (tab: BtwTabState) => {
		if (!tab.draft.trim() && tab.exchanges.length === 0) {
			btwStore.closeTab(sessionId, tab.id);
			setConfirmingTabId(null);
			return;
		}
		setConfirmingTabId(tab.id);
	};
	const confirmClose = () => {
		if (!confirmingTabId) return;
		btwStore.closeTab(sessionId, confirmingTabId);
		setConfirmingTabId(null);
	};
	const renderGeometry = visualGeometryRef.current ?? btw.geometry;

	return (
		<AnimatePresence>
			<motion.div
				ref={windowRef}
				key="btw-window"
				role="dialog"
				aria-label={t("btw.title")}
				className="inno-btw-window absolute z-30 flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-[var(--inno-border)] bg-[var(--inno-surface)] shadow-xl"
				style={{
					left: renderGeometry.x,
					top: renderGeometry.y,
					width: renderGeometry.width,
					height: renderGeometry.height,
				}}
				initial={{ opacity: 0, scale: 0.98 }}
				animate={{ opacity: 1, scale: 1 }}
				exit={{ opacity: 0, scale: 0.98 }}
					transition={{ duration: 0.16, ease: "easeOut" }}
					onKeyDown={(event) => {
						if (event.key === "Escape") {
							dragRef.current = null;
						resizeRef.current = null;
					}
				}}
			>
				<div
					className="inno-btw-titlebar flex h-9 shrink-0 items-center gap-2 border-b border-[var(--inno-border)] px-3"
					onPointerDown={beginDrag}
					onPointerMove={moveDrag}
					onPointerUp={endDrag}
					onPointerCancel={endDrag}
				>
					<MessageCircleQuestion size={15} className="text-[var(--inno-accent)]" aria-hidden="true" />
					<span className="truncate text-xs font-medium text-[var(--inno-text)]">{t("btw.title")}</span>
					<span className="min-w-0 flex-1 truncate text-[11px] text-[var(--inno-text-subtle)]">{t("btw.subtitle")}</span>
					<button
						type="button"
						className="inno-btw-window-button flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--inno-text-muted)] transition-colors hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]"
						title={t("btw.minimize")}
						aria-label={t("btw.minimize")}
						onPointerDown={(event) => event.stopPropagation()}
						onClick={() => btwStore.minimizePanel()}
					>
						<Minimize2 size={14} />
					</button>
				</div>

				{btw.loadError ? (
					<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 py-8 text-center">
						<p className="text-sm font-medium text-[var(--inno-text)]">{t("btw.loadErrorTitle")}</p>
						<p className="text-xs leading-5 text-[var(--inno-text-muted)]">{t("btw.loadErrorDetail")}</p>
						<div className="mt-1 flex items-center gap-2">
							<button
								type="button"
								className="flex items-center gap-1.5 rounded-md border border-[var(--inno-border)] px-3 py-1.5 text-xs text-[var(--inno-text)] transition-colors hover:bg-[var(--inno-surface-muted)]"
								onClick={() => void btwStore.openOrRestore(sessionId)}
							>
								<RotateCcw size={12} aria-hidden="true" />
								{t("btw.retry")}
							</button>
							<button
								type="button"
								className="rounded-md px-3 py-1.5 text-xs text-[var(--inno-text-muted)] transition-colors hover:bg-[var(--inno-surface-muted)]"
								onClick={() => btwStore.togglePanel(false)}
							>
								{t("btw.cancel")}
							</button>
						</div>
					</div>
				) : activeTab ? (
				<>
				<div className="inno-btw-tab-strip flex shrink-0 items-center gap-1 border-b border-[var(--inno-border)] px-2">
					{/* The "+" button stays pinned outside the scroll area so the create
						entry never scrolls away as tabs accumulate. */}
					<div ref={tabStripRef} className="min-w-0 flex-1 overflow-x-auto" role="tablist" aria-label={t("btw.tabs")}>
						<div className="flex min-w-max items-center gap-1 py-1">
							{btw.tabs.map((tab) => {
								const active = tab.id === activeTab.id;
								return (
									<div
										key={tab.id}
										role="tab"
										aria-selected={active}
										className={`inno-btw-tab flex h-7 items-center rounded-md text-xs ${active ? "inno-btw-tab-active" : "text-[var(--inno-text-muted)]"}`}
									>
										<button
											type="button"
											className="h-full max-w-36 truncate px-2 text-left"
											onClick={() => btwStore.selectTab(sessionId, tab.id)}
										>
											{t("btw.tabLabel", { number: tab.number })}
										</button>
										<button
											type="button"
											className="mr-1 flex h-5 w-5 items-center justify-center rounded text-[var(--inno-text-subtle)] transition-colors hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]"
											title={t("btw.closeTab", { number: tab.number })}
											aria-label={t("btw.closeTab", { number: tab.number })}
											onClick={() => closeTab(tab)}
										>
											<X size={12} />
										</button>
									</div>
								);
							})}
						</div>
					</div>
					<button
						type="button"
						className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--inno-text-muted)] transition-colors hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]"
						title={t("btw.newTab")}
						aria-label={t("btw.newTab")}
						onClick={() => btwStore.createTab(sessionId)}
					>
						<Plus size={14} />
					</button>
				</div>

				<div
					ref={listRef}
					className="inno-btw-thread-list flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3"
					onScroll={(event) => {
						const list = event.currentTarget;
						nearBottomRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
						btwStore.setScrollTop(sessionId, activeTab.id, list.scrollTop);
					}}
					role="tabpanel"
					aria-label={t("btw.tabLabel", { number: activeTab.number })}
				>
					{activeTab.exchanges.length === 0 ? (
						<p className="m-auto max-w-56 py-6 text-center text-xs text-[var(--inno-text-subtle)]">{t("btw.emptyHint")}</p>
					) : null}
					{activeTab.exchanges.map((exchange) => (
						<div key={exchange.id} className="flex flex-col gap-1.5">
							<div className="self-end rounded-lg bg-[var(--inno-accent-soft)] px-3 py-1.5 text-sm text-[var(--inno-text)]">
								{exchange.question}
							</div>
							<div className="self-stretch rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] px-3 py-2 text-sm">
								{exchange.status === "pending" ? (
									<span className="flex items-center gap-2 text-[var(--inno-text-muted)]">
										<Loader2 size={14} className="animate-spin" aria-hidden="true" />
										{t("btw.thinking")}
									</span>
								) : exchange.status === "error" ? (
									<span className="flex items-center gap-2 text-[var(--inno-danger)]">
										<span className="min-w-0 flex-1 text-xs">{t("btw.error", { message: exchange.error ?? "" })}</span>
										<button
											type="button"
											className="flex shrink-0 items-center gap-1 rounded-md border border-[var(--inno-border)] px-2 py-1 text-xs text-[var(--inno-text)] transition-colors hover:bg-[var(--inno-surface)]"
											onClick={() => void btwStore.retry(sessionId, activeTab.id, exchange.id)}
										>
											<RotateCcw size={12} aria-hidden="true" />
											{t("btw.retry")}
										</button>
									</span>
								) : (
									<>
										<MarkdownArtifact content={exchange.answer} compact />
										<div className="mt-2 flex justify-end">
											{exchange.broughtBack ? (
												<span className="flex items-center gap-1 text-xs text-[var(--inno-text-subtle)]">
													<Check size={12} aria-hidden="true" />
													{t("btw.broughtBack")}
												</span>
											) : (
												<button
													type="button"
													className="flex items-center gap-1 rounded-md border border-[var(--inno-border)] px-2 py-1 text-xs text-[var(--inno-text-muted)] transition-colors hover:bg-[var(--inno-surface)] hover:text-[var(--inno-text)] disabled:opacity-50"
													disabled={bringingBackId !== null}
													title={t("btw.bringBackHint")}
													onClick={() => bringBack(exchange)}
												>
													{bringingBackId === exchange.id ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <CornerUpLeft size={12} aria-hidden="true" />}
													{t("btw.bringBack")}
												</button>
											)}
										</div>
									</>
								)}
							</div>
						</div>
					))}
				</div>

				<div className="flex shrink-0 items-end gap-2 border-t border-[var(--inno-border)] px-3 py-2.5">
					<textarea
						ref={inputRef}
						className="max-h-28 min-h-[2.25rem] flex-1 resize-none rounded-lg border border-[var(--inno-border)] bg-[var(--inno-chat-bg)] px-3 py-2 text-sm text-[var(--inno-text)] outline-none placeholder:text-[var(--inno-text-subtle)] focus:border-[var(--inno-accent)]"
						placeholder={t("btw.placeholder")}
						rows={1}
						value={activeTab.draft}
						onChange={(event) => btwStore.setDraft(sessionId, activeTab.id, event.target.value)}
						onKeyDown={handleKeyDown}
					/>
					<button
						type="button"
						className="inno-composer-send flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-50"
						title={t("btw.send")}
						aria-label={t("btw.send")}
						disabled={!activeTab.draft.trim() || pending}
						onClick={send}
					>
						{pending ? <Loader2 size={15} className="animate-spin" /> : <SendHorizontal size={15} />}
					</button>
				</div>
				</>
				) : null}

				{RESIZE_HANDLES.map(({ edge, className }) => (
					<div
						key={edge}
						className={`inno-btw-resize-handle ${className}`}
						role="presentation"
						aria-hidden="true"
						onPointerDown={(event) => beginResize(event, edge)}
						onPointerMove={moveResize}
						onPointerUp={endResize}
						onPointerCancel={endResize}
					/>
				))}

				{confirmingTab ? (
					<div
						className="absolute inset-0 z-20 flex items-center justify-center bg-[color-mix(in_srgb,var(--inno-surface)_78%,transparent)] p-4 backdrop-blur-[2px]"
						onKeyDown={(event) => {
							if (event.key === "Escape") {
								event.stopPropagation();
								setConfirmingTabId(null);
								return;
							}
							if (event.key === "Tab") {
								// Keep focus cycling between the two dialog buttons.
								event.preventDefault();
								const next = document.activeElement === confirmDeleteRef.current ? confirmCancelRef.current : confirmDeleteRef.current;
								next?.focus();
							}
						}}
					>
						<div className="w-full max-w-xs rounded-xl border border-[var(--inno-border)] bg-[var(--inno-surface)] p-4 shadow-xl" role="alertdialog" aria-modal="true" aria-labelledby="btw-close-title">
							<h2 id="btw-close-title" className="text-sm font-semibold text-[var(--inno-text)]">{t("btw.closeConfirm", { number: confirmingTab.number })}</h2>
							<p className="mt-2 text-xs leading-5 text-[var(--inno-text-muted)]">{t("btw.closeConfirmDetail")}</p>
							<div className="mt-4 flex justify-end gap-2">
								<button
									ref={confirmCancelRef}
									type="button"
									className="rounded-md px-3 py-1.5 text-xs text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)]"
									onClick={() => setConfirmingTabId(null)}
								>
									{t("btw.cancel")}
								</button>
								<button
									ref={confirmDeleteRef}
									type="button"
									className="rounded-md bg-[var(--inno-danger)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
									onClick={confirmClose}
								>
									{t("btw.closeAndDelete")}
								</button>
							</div>
						</div>
					</div>
				) : null}
			</motion.div>
		</AnimatePresence>
	);
}
