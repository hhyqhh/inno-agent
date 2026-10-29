import { Component, lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useDragDropManager } from "react-dnd";
import type { DragDropManager } from "dnd-core";
import { Maximize2, Minimize2, Terminal as TerminalIcon } from "lucide-react";
import type { WorkspaceMode } from "../stores/app-store.js";
import { getEffectiveWorkspaceWidth, getMaximumWorkspaceWidth, getSidebarLayoutWidth, WORKSPACE_MAX_WIDTH, WORKSPACE_MIN_WIDTH, WORKSPACE_QUARTER_MIN_WIDTH } from "../stores/app-layout.js";
import { appStore } from "../stores/app-store.js";
import { terminalStore } from "../stores/terminal-store.js";
import { workspaceStore } from "../stores/workspace-store.js";
import type { WorkspaceTreeNode } from "../types/workspace.js";
import { ensureWindowForPanel } from "../stores/window-expansion.js";
import { useStoreSnapshot } from "./hooks.js";
import {
	Button,
	IconButton,
	Tooltip,
	TabPanel,
	getTabTriggerId,
} from "./ui/index.js";
import { STREAMING_PREVIEW_TAB, WORKSPACE_PREVIEW_TABS_ID } from "./WorkspacePreviewTabs.js";
import { isDynamicImportError, recoverFromDynamicImportError } from "../utils/dynamic-import-recovery.js";

interface WorkspacePanelProps {
	mode: WorkspaceMode;
	width: number;
	showFileTree?: boolean;
	merged?: boolean;
	showTerminalToggle?: boolean;
	onModeChange(mode: WorkspaceMode): void;
	onWidthChange(width: number): void;
	onPreviewFile(width: number): void | Promise<void>;
}

/** Total file (leaf) count in the workspace tree, for the panel header. */
function countTreeFiles(nodes: WorkspaceTreeNode[] | undefined): number {
	if (!nodes) return 0;
	let count = 0;
	for (const node of nodes) {
		if (node.type === "file") count += 1;
		else count += countTreeFiles(node.children);
	}
	return count;
}

interface WorkspaceResizeStart {
	pointerId: number;
	clientX: number;
	width: number;
}

const RESIZE_FULLSCREEN_THRESHOLD = 24;

function clampResizeWidth(width: number, mode: WorkspaceMode, maxWidth: number): number {
	const minWidth = mode === "quarter" ? WORKSPACE_QUARTER_MIN_WIDTH : WORKSPACE_MIN_WIDTH;
	return Math.max(minWidth, Math.min(Math.max(minWidth, maxWidth), Math.round(width)));
}

function waitForWindowLayoutToSettle(): Promise<void> {
	if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") return Promise.resolve();
	return new Promise((resolve) => {
		window.requestAnimationFrame(() => {
			window.requestAnimationFrame(() => resolve());
		});
	});
}

class WorkspaceContentErrorBoundary extends Component<
	{ resetKey: string; onRetry(): void; children: ReactNode },
	{ error: Error | null }
> {
	state: { error: Error | null } = { error: null };

	static getDerivedStateFromError(error: Error) {
		return { error };
	}

	componentDidCatch(error: Error, info: ErrorInfo) {
		if (recoverFromDynamicImportError(error)) return;
		console.error("[workspace-panel] failed to render lazy content", error, info);
	}

	componentDidUpdate(prevProps: { resetKey: string }) {
		if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
			this.setState({ error: null });
		}
	}

	render() {
		if (this.state.error) {
			return (
				<div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
					<div className="text-sm font-medium text-[var(--inno-text)]">Panel failed to load</div>
					<div className="max-w-sm text-xs text-[var(--inno-text-muted)]">
						Switch tabs or close and reopen the panel to try again.
					</div>
					{this.state.error.message ? (
						<div className="max-w-sm break-words text-[10px] text-[var(--inno-danger)]">
							{this.state.error.message}
						</div>
					) : null}
					<Button
						variant="primary"
						size="xs"
						onClick={() => {
							// A failed dynamic import is cached by the browser for the
							// current document. Re-mounting React.lazy with the same
							// specifier only returns the same rejected module promise;
							// reload the document so Vite can provide a fresh chunk graph.
							if (isDynamicImportError(this.state.error)) {
								window.location.reload();
								return;
							}
							this.setState({ error: null });
							this.props.onRetry();
						}}
					>
						Retry panel
					</Button>
					<Button
						variant="ghost"
						size="xs"
						className="underline underline-offset-2"
						onClick={() => window.location.reload()}
					>
						Refresh page
					</Button>
				</div>
			);
		}
		return this.props.children;
	}
}

function WorkspaceBrowserContent({ retryKey, onPreviewFile, dndManager, showFileTree }: { retryKey: number; onPreviewFile: WorkspacePanelProps["onPreviewFile"]; dndManager: DragDropManager; showFileTree: boolean }) {
	const Browser = useMemo(
		() => lazy(() => import("./WorkspaceBrowser.js").then((mod) => ({ default: mod.WorkspaceBrowser }))),
		[retryKey],
	);
	return (
		<Suspense fallback={<WorkspaceContentFallback />}>
			<Browser variant={showFileTree ? "workspace" : "preview"} onPreviewFile={onPreviewFile} dndManager={dndManager} />
		</Suspense>
	);
}

function WorkspaceContentFallback() {
	return (
		<div className="flex h-full items-center justify-center bg-[var(--inno-workspace-bg)] text-xs text-[var(--inno-text-muted)]">
			Loading panel...
		</div>
	);
}

function WorkspacePanelContent({ mode, width, onModeChange, onWidthChange, onPreviewFile, showFileTree = true, merged = false, showTerminalToggle = true }: WorkspacePanelProps) {
	const { t } = useTranslation();
	const dndManager = useDragDropManager();
	const [isResizing, setIsResizing] = useState(false);
	const [resizeDragWidth, setResizeDragWidth] = useState(width);
	const panelRef = useRef<HTMLElement | null>(null);
	const resizeBoundsRef = useRef({ top: 0, right: 0, bottom: 0, widthOffset: 0 });
	const [resizeFullscreenReady, setResizeFullscreenReady] = useState(false);
	const resizeRequestedWidthRef = useRef<number | null>(null);
	const resizeStartRef = useRef<WorkspaceResizeStart | null>(null);
	const resizePreviewWidthRef = useRef<number | null>(null);
	const resizeMaxWidthRef = useRef(WORKSPACE_MAX_WIDTH);
	const resizeCommitGenerationRef = useRef(0);
	const [contentRetryKey, setContentRetryKey] = useState(0);
	const [hasOpenedWorkspace, setHasOpenedWorkspace] = useState(mode !== "collapsed");
	const retryContent = useCallback(() => setContentRetryKey((key) => key + 1), []);

	const terminalOpen = useStoreSnapshot(terminalStore, () => terminalStore.isOpen);
	const fileCount = useStoreSnapshot(workspaceStore, () => countTreeFiles(workspaceStore.tree?.children));
	const activePreview = useStoreSnapshot(workspaceStore, () => workspaceStore.streamingPreview ? STREAMING_PREVIEW_TAB : workspaceStore.activePreviewPath);
	const workspaceId = useStoreSnapshot(workspaceStore, () => workspaceStore.activeWorkspaceId);
	const activeSurface = useStoreSnapshot(workspaceStore, () => workspaceStore.activeSurface);
	const conversationActive = merged && mode === "full" && activeSurface === "conversation";

	const commitResize = useCallback(async (nextWidth: number) => {
		const generation = ++resizeCommitGenerationRef.current;
		// When the current chat column is already at its baseline width, the
		// renderer cannot fit a wider workspace without first making more room.
		// Electron can expand the host window; browser builds safely fall back to
		// the existing fitPanelLayout constraint inside onWidthChange.
		await ensureWindowForPanel("right", nextWidth, mode);
		// The host-window resize can emit a second renderer resize event after
		// ensureWindowForPanel resolves. Commit after those fit passes settle so
		// the requested workspace width is not overwritten by the old width.
		await waitForWindowLayoutToSettle();
		if (generation !== resizeCommitGenerationRef.current) return;
		onWidthChange(nextWidth);
	}, [mode, onWidthChange]);

	useEffect(() => {
		if (!isResizing) return;

		let frame = 0;
		let latestClientX = 0;
		const cancelPendingMove = () => {
			if (frame !== 0) {
				cancelAnimationFrame(frame);
				frame = 0;
			}
		};
		// Pointer events arrive at the input device's rate, faster than frames;
		// apply at most one layout update per frame so the drag cannot stack
		// whole-app renders on every event. The release lands on the pointer's
		// final position synchronously.
		const applyMove = (clientX: number) => {
			frame = 0;
			const start = resizeStartRef.current;
			if (!start) return;
			const maxWidth = resizeMaxWidthRef.current;
			// Clamping discards the overshoot; retain the pointer's requested width
			// so crossing the split-view limit only enters fullscreen on release.
			const requestedWidth = start.width + start.clientX - clientX;
			resizeRequestedWidthRef.current = requestedWidth;
			setResizeFullscreenReady(requestedWidth >= maxWidth + RESIZE_FULLSCREEN_THRESHOLD);
			const nextWidth = clampResizeWidth(
				requestedWidth,
				mode,
				resizeMaxWidthRef.current,
			);
			setResizeDragWidth(nextWidth);
			const directMaxWidth = Math.max(
				start.width,
				getMaximumWorkspaceWidth(window.innerWidth, appStore.sidebarCollapsed, mode, Boolean(window.innoDesktop), appStore.sidebarWidth),
			);
			if (nextWidth <= directMaxWidth) {
				// Keep the workspace attached to the pointer while the current
				// window has room for it. The preview edge is only a fallback for
				// widths that cannot be applied to the live layout yet.
				resizePreviewWidthRef.current = null;
				onWidthChange(nextWidth);
				return;
			}
			resizePreviewWidthRef.current = nextWidth;
		};
		const handlePointerMove = (event: PointerEvent) => {
			const start = resizeStartRef.current;
			if (!start || event.pointerId !== start.pointerId) return;
			event.preventDefault();
			latestClientX = event.clientX;
			if (frame === 0) frame = requestAnimationFrame(() => applyMove(latestClientX));
		};
		const finishResize = (commit: boolean) => {
			cancelPendingMove();
			const start = resizeStartRef.current;
			if (!start) return;
			const nextWidth = commit ? resizePreviewWidthRef.current : null;
			const fullscreen = commit && resizeRequestedWidthRef.current !== null
				&& resizeRequestedWidthRef.current >= resizeMaxWidthRef.current + RESIZE_FULLSCREEN_THRESHOLD;
			resizeStartRef.current = null;
			resizeRequestedWidthRef.current = null;
			resizePreviewWidthRef.current = null;
			resizeMaxWidthRef.current = WORKSPACE_MAX_WIDTH;
			setIsResizing(false);
			setResizeFullscreenReady(false);
			if (fullscreen) onModeChange("full");
			else if (nextWidth !== null) void commitResize(nextWidth);
			else if (!commit) onWidthChange(start.width);
		};
		const handlePointerUp = (event: PointerEvent) => {
			if (resizeStartRef.current?.pointerId !== event.pointerId) return;
			cancelPendingMove();
			applyMove(event.clientX);
			finishResize(true);
		};
		const handlePointerCancel = (event: PointerEvent) => {
			if (resizeStartRef.current?.pointerId !== event.pointerId) return;
			finishResize(false);
		};
		const handleWindowBlur = () => finishResize(false);
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") finishResize(false);
		};

		document.body.classList.add("workspace-resizing");
		window.addEventListener("pointermove", handlePointerMove);
		window.addEventListener("pointerup", handlePointerUp);
		window.addEventListener("pointercancel", handlePointerCancel);
		window.addEventListener("blur", handleWindowBlur);
		window.addEventListener("keydown", handleKeyDown);
		return () => {
			cancelPendingMove();
			document.body.classList.remove("workspace-resizing");
			window.removeEventListener("pointermove", handlePointerMove);
			window.removeEventListener("pointerup", handlePointerUp);
			window.removeEventListener("pointercancel", handlePointerCancel);
			window.removeEventListener("blur", handleWindowBlur);
			window.removeEventListener("keydown", handleKeyDown);
		};
	}, [commitResize, isResizing, mode, onModeChange, onWidthChange]);

	// Keep the workspace browser mounted after its first open. Collapsing the
	// panel should hide it, not restart its tree/preview lifecycle on reopen.
	useEffect(() => {
		if (mode !== "collapsed") setHasOpenedWorkspace(true);
		if (mode !== "collapsed" && !showFileTree && !workspaceStore.previewTabs.length && !workspaceStore.streamingPreview) workspaceStore.openStartPage();
	}, [mode, showFileTree, workspaceId]);

	const startResize = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
		if (event.button !== 0 || resizeStartRef.current) return;
		event.preventDefault();
		// Invalidate a previous asynchronous commit if the user starts another
		// resize before a host-window expansion has finished.
		resizeCommitGenerationRef.current += 1;
		const layoutMaxWidth = getMaximumWorkspaceWidth(window.innerWidth, appStore.sidebarCollapsed, mode, Boolean(window.innoDesktop), appStore.sidebarWidth);
		const startWidth = clampResizeWidth(width, mode, Math.max(width, layoutMaxWidth));
		resizeMaxWidthRef.current = Math.max(startWidth, layoutMaxWidth);
		const bounds = panelRef.current?.getBoundingClientRect();
		resizeBoundsRef.current = {
			top: bounds?.top ?? 0,
			right: bounds?.width ? window.innerWidth - bounds.right : 0,
			bottom: bounds?.height ? window.innerHeight - bounds.bottom : 0,
			widthOffset: bounds?.width ? startWidth - bounds.width : 0,
		};
		setResizeDragWidth(startWidth);
		resizeStartRef.current = {
			pointerId: event.pointerId,
			clientX: event.clientX,
			width: startWidth,
		};
		resizePreviewWidthRef.current = null;
		resizeRequestedWidthRef.current = null;
		setResizeFullscreenReady(false);
		setIsResizing(true);
		if (event.currentTarget.setPointerCapture) {
			event.currentTarget.setPointerCapture(event.pointerId);
		}

		// On desktop, include the amount of host-window space that can still be
		// expanded on either edge. The commit uses the right edge first and moves
		// the window left when the right edge is already at the display boundary.
		const getWindowWidthCapacity = window.innoDesktop?.getWindowWidthCapacity;
		if (getWindowWidthCapacity) {
			void Promise.all([
				getWindowWidthCapacity("right").catch(() => 0),
				getWindowWidthCapacity("left").catch(() => 0),
			]).then(([rightCapacity, leftCapacity]) => {
				const active = resizeStartRef.current;
				if (!active || active.pointerId !== event.pointerId) return;
				const expandedViewportWidth = window.innerWidth
					+ Math.max(0, Math.round(rightCapacity))
					+ Math.max(0, Math.round(leftCapacity));
				resizeMaxWidthRef.current = Math.min(
					WORKSPACE_MAX_WIDTH,
					Math.max(
						resizeMaxWidthRef.current,
						getMaximumWorkspaceWidth(expandedViewportWidth, appStore.sidebarCollapsed, mode, Boolean(window.innoDesktop), appStore.sidebarWidth),
					),
				);
				const maxWidth = resizeMaxWidthRef.current;
				setResizeFullscreenReady(resizeRequestedWidthRef.current !== null
					&& resizeRequestedWidthRef.current >= maxWidth + RESIZE_FULLSCREEN_THRESHOLD);
			});
		}
	}, [mode, width]);

	const collapsed = mode === "collapsed";
	// The document engine (WordEditor stays mounted through collapse) relayouts
	// for every width the open slide animates through — heavy per-frame jank and
	// degenerate-canvas artifacts (a black edge line). Pin the content to the
	// final panel width for the duration of the slide: the engine lays out once,
	// the panel clips the over-wide content while sliding (no white pane), and
	// releasing the pin at the settled width changes nothing. Render-phase state
	// so the pin lands in the same commit as the mode flip — the engine's first
	// laid-out frame must never be width 0.
	const [settledWidth, setSettledWidth] = useState<number | null>(null);
	const previousModeRef = useRef(mode);
	if (previousModeRef.current !== mode) {
		const wasCollapsed = previousModeRef.current === "collapsed";
		previousModeRef.current = mode;
		if (wasCollapsed && !collapsed) {
			const inset = merged && mode !== "full" ? 3 : 0;
			if (mode === "full") {
				setSettledWidth(typeof window === "undefined" ? null
					: Math.max(0, window.innerWidth - getSidebarLayoutWidth(appStore.sidebarCollapsed, merged, appStore.sidebarWidth) - inset));
			} else {
				setSettledWidth(Math.max(0, getEffectiveWorkspaceWidth(appStore.workspaceWidth, mode) - inset));
			}
		} else if (collapsed) {
			// display:none on close gave the still-mounted DOCX engine a zero
			// viewport; reopening invalidated its paint/zoom caches and produced
			// a black edge plus a burst of work. Keep its last positive viewport
			// while the owner clips/hides it, including rapid close/open reversals.
			const currentWidth = panelRef.current?.querySelector<HTMLElement>(".inno-ui-tab-panel")?.getBoundingClientRect().width;
			setSettledWidth(currentWidth && currentWidth > 0 ? currentWidth : settledWidth ?? Math.max(1, width - (merged ? 3 : 0)));
		}
	}
	useEffect(() => {
		if (settledWidth === null || collapsed) return;
		const panel = panelRef.current;
		const onEnd = (event: TransitionEvent) => {
			if (event.target === panel && event.propertyName === "width") {
				panel?.removeEventListener("transitionend", onEnd);
				window.clearTimeout(fallback);
				setSettledWidth(null);
			}
		};
		// Fallback for contexts without a running width transition (reduced
		// motion, an interrupted slide): never strand the pinned width.
		const fallback = window.setTimeout(() => {
			panel?.removeEventListener("transitionend", onEnd);
			setSettledWidth(null);
		}, 260);
		panel?.addEventListener("transitionend", onEnd);
		return () => {
			panel?.removeEventListener("transitionend", onEnd);
			window.clearTimeout(fallback);
		};
	}, [settledWidth, collapsed]);
	const shouldMountContent = hasOpenedWorkspace || !collapsed;
	const displayWidth = isResizing ? resizeDragWidth - resizeBoundsRef.current.widthOffset : width;
	const contentWidth = Math.max(1, window.innerWidth - getSidebarLayoutWidth(appStore.sidebarCollapsed, Boolean(window.innoDesktop), appStore.sidebarWidth));
	const resizeLabel = resizeFullscreenReady ? t("workspace.releaseToFullscreen")
		: `${t("workspace.resize")} (${Math.min(100, Math.round(displayWidth / contentWidth * 100))}%)`;
	// Align hover and drag hints to the content's top edge. The hover hit target
	// extends 3px beyond the drag anchor, so its right-side gap is 3px smaller.

	useLayoutEffect(() => {
		if (!isResizing) return;
		const layout = panelRef.current?.closest<HTMLElement>(".app-layout");
		layout?.toggleAttribute("data-workspace-resize-overlay", resizePreviewWidthRef.current !== null);
		// The panel can defer its width until the host window expands. Using its
		// old bounds here stranded the tabs while the drag edge kept moving;
		// toolbar and preview must always share the same measured drag geometry.
		layout?.style.setProperty("--inno-workspace-drag-width", `${resizeDragWidth}px`);
		const edgeX = window.innerWidth - resizeBoundsRef.current.right - displayWidth;
		layout?.style.setProperty("--inno-workspace-drag-left", `${edgeX - (layout?.getBoundingClientRect().left ?? 0)}px`);
		return () => {
			layout?.removeAttribute("data-workspace-resize-overlay");
			layout?.style.removeProperty("--inno-workspace-drag-width");
			layout?.style.removeProperty("--inno-workspace-drag-left");
		};
	}, [isResizing, resizeDragWidth, displayWidth, width]);

	const resizePreviewPortal = isResizing
		? createPortal(
			<div
				className="workspace-resize-preview"
				style={{ width: displayWidth, top: resizeBoundsRef.current.top, right: resizeBoundsRef.current.right, bottom: resizeBoundsRef.current.bottom }}
			>
				<Tooltip label={resizeLabel} open side="right" align="start" contentClassName="workspace-resize-tooltip">
					<span className="workspace-resize-tooltip-anchor" />
				</Tooltip>
			</div>, document.body,
		)
		: null;
	useEffect(() => () => {
		if (dndManager.getMonitor().isDragging()) {
			dndManager.getActions().endDrag();
		}
	}, [dndManager]);

	return (
		<aside ref={panelRef} id="workspace-preview" aria-hidden={collapsed || conversationActive || undefined} inert={collapsed || conversationActive || undefined} className={`workspace-panel inno-workspace-scope ${merged ? "workspace-panel--merged" : collapsed ? "" : "inno-desktop-panel-surface"} relative flex h-full min-h-0 min-w-0 flex-col ${isResizing ? "workspace-resize-preview-active" : ""} ${collapsed ? "overflow-visible border-l-0 bg-transparent" : "overflow-hidden border-l border-[var(--inno-border)] bg-[var(--inno-workspace-bg)]"}`}>
			{resizePreviewPortal}
			{mode === "half" || mode === "quarter" ? (
				<Tooltip label={resizeLabel} side="right" align="start" sideOffset={3} contentClassName="workspace-resize-tooltip" open={isResizing ? false : undefined}>
					<button
						className="workspace-resize-handle"
						role="separator"
						aria-orientation="vertical"
						aria-valuenow={width}
						aria-valuemin={mode === "quarter" ? WORKSPACE_QUARTER_MIN_WIDTH : WORKSPACE_MIN_WIDTH}
						aria-valuemax={getMaximumWorkspaceWidth(typeof window === "undefined" ? 1440 : window.innerWidth, appStore.sidebarCollapsed, mode, Boolean(window.innoDesktop), appStore.sidebarWidth)}
						aria-label={t("workspace.resize") ?? ""}
						onPointerDown={startResize}
						onKeyDown={(event) => {
							const step = event.shiftKey ? 32 : 8;
							if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
							event.preventDefault();
							onWidthChange(clampResizeWidth(width + (event.key === "ArrowLeft" ? step : -step), mode, getMaximumWorkspaceWidth(window.innerWidth, appStore.sidebarCollapsed, mode, Boolean(window.innoDesktop), appStore.sidebarWidth)));
						}}
					/>
				</Tooltip>
			) : null}

			{/* Panel header — mirrors the design mockup's artifact-panel head:
			    title + file count on the left, chrome actions on the right. */}
			{!merged ? <div hidden={collapsed} className="inno-workspace-header inno-workspace-panel-header flex h-12 shrink-0 items-center justify-between gap-2 border-b border-[var(--inno-border)] bg-[var(--inno-workspace-bg)] px-3.5">
				<div className="min-w-0 flex items-baseline gap-1.5">
					<span className="whitespace-nowrap text-[14.5px] font-semibold text-[var(--inno-text)]">{t("workspace.panelTitle")}</span>
					<span className="whitespace-nowrap text-[11.5px] text-[var(--inno-text-subtle)]">{t("workspace.fileCount", { count: fileCount })}</span>
				</div>
				<div className="inno-workspace-header-actions">
					{showTerminalToggle ? (
						<IconButton
							size="sm"
							className={`inno-workspace-header-button ${terminalOpen ? "is-active" : ""}`}
							title={(terminalOpen ? t("terminal.collapse") : t("terminal.expand")) ?? ""}
							aria-label={(terminalOpen ? t("terminal.collapse") : t("terminal.expand")) ?? ""}
							aria-pressed={terminalOpen}
							onClick={() => terminalStore.setOpen(!terminalOpen)}
						>
							<TerminalIcon size={15} strokeWidth={1.8} />
						</IconButton>
					) : null}
					<IconButton
						size="sm"
						className={`inno-workspace-header-button inno-workspace-header-expand-button ${mode === "full" ? "is-active" : ""}`}
						title={mode === "full" ? (t("workspace.half") ?? "") : (t("workspace.full") ?? "")}
						aria-label={mode === "full" ? (t("workspace.half") ?? "") : (t("workspace.full") ?? "")}
						aria-pressed={mode === "full"}
						onClick={() => onModeChange(mode === "full" ? "half" : "full")}
					>
						{mode === "full" ? <Minimize2 size={15} strokeWidth={1.8} /> : <Maximize2 size={15} strokeWidth={1.8} />}
					</IconButton>
				</div>
			</div> : null}

			<TabPanel
				id={`${WORKSPACE_PREVIEW_TABS_ID}-panel`}
				labelledBy={merged && activePreview ? getTabTriggerId(WORKSPACE_PREVIEW_TABS_ID, activePreview) : undefined}
				aria-label={activePreview ? undefined : t("files.previewTabs")}
				className={`flex-1 min-h-0 overflow-hidden bg-[var(--inno-workspace-bg)] ${collapsed ? "invisible" : ""}`}
				style={settledWidth !== null ? { width: settledWidth } : undefined}
			>
				{shouldMountContent ? (
					<WorkspaceContentErrorBoundary resetKey={`preview:${contentRetryKey}`} onRetry={retryContent}>
						<Suspense fallback={<WorkspaceContentFallback />}>
							<WorkspaceBrowserContent retryKey={contentRetryKey} onPreviewFile={onPreviewFile} dndManager={dndManager} showFileTree={showFileTree} />
						</Suspense>
					</WorkspaceContentErrorBoundary>
				) : null}
			</TabPanel>
		</aside>
	);
}

/**
 * The application owns one HTML5 drag-drop provider around the whole layout.
 * Keeping the manager above both the workspace panel and workbench prevents a
 * page transition from briefly registering two HTML5 backends on document.
 */
export function WorkspacePanel(props: WorkspacePanelProps) {
	return <WorkspacePanelContent {...props} />;
}
