import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useDragDropManager } from "react-dnd";
import type { DragDropManager } from "dnd-core";
import { Maximize2, Minimize2, Terminal as TerminalIcon } from "lucide-react";
import type { WorkspaceMode } from "../stores/app-store.js";
import { getMaximumWorkspaceWidth, WORKSPACE_MAX_WIDTH, WORKSPACE_MIN_WIDTH, WORKSPACE_QUARTER_MIN_WIDTH } from "../stores/app-layout.js";
import { appStore } from "../stores/app-store.js";
import { terminalStore } from "../stores/terminal-store.js";
import { workspaceStore } from "../stores/workspace-store.js";
import type { WorkspaceTreeNode } from "../types/workspace.js";
import { ensureWindowForPanel } from "../stores/window-expansion.js";
import { useStoreSnapshot } from "./hooks.js";
import { isDynamicImportError, recoverFromDynamicImportError } from "../utils/dynamic-import-recovery.js";

interface WorkspacePanelProps {
	mode: WorkspaceMode;
	width: number;
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
					<button
						type="button"
						className="inno-primary-button rounded-md px-3 py-1.5 text-xs text-white"
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
					</button>
					<button
						type="button"
						className="text-xs text-[var(--inno-text-muted)] underline underline-offset-2"
						onClick={() => window.location.reload()}
					>
						Refresh page
					</button>
				</div>
			);
		}
		return this.props.children;
	}
}

function WorkspaceBrowserContent({ retryKey, onPreviewFile, dndManager }: { retryKey: number; onPreviewFile: WorkspacePanelProps["onPreviewFile"]; dndManager: DragDropManager }) {
	const Browser = useMemo(
		() => lazy(() => import("./WorkspaceBrowser.js").then((mod) => ({ default: mod.WorkspaceBrowser }))),
		[retryKey],
	);
	return (
		<Suspense fallback={<WorkspaceContentFallback />}>
			<Browser onPreviewFile={onPreviewFile} dndManager={dndManager} />
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

function WorkspacePanelContent({ mode, width, onModeChange, onWidthChange, onPreviewFile }: WorkspacePanelProps) {
	const { t } = useTranslation();
	const dndManager = useDragDropManager();
	const [isResizing, setIsResizing] = useState(false);
	const [resizeLimitReached, setResizeLimitReached] = useState(false);
	const [resizePreviewWidth, setResizePreviewWidth] = useState<number | null>(null);
	const resizeStartRef = useRef<WorkspaceResizeStart | null>(null);
	const resizePreviewWidthRef = useRef<number | null>(null);
	const resizeMaxWidthRef = useRef(WORKSPACE_MAX_WIDTH);
	const resizeCommitGenerationRef = useRef(0);
	const [contentRetryKey, setContentRetryKey] = useState(0);
	const [hasOpenedWorkspace, setHasOpenedWorkspace] = useState(mode !== "collapsed");
	const retryContent = useCallback(() => setContentRetryKey((key) => key + 1), []);

	const terminalOpen = useStoreSnapshot(terminalStore, () => terminalStore.isOpen);
	const fileCount = useStoreSnapshot(workspaceStore, () => countTreeFiles(workspaceStore.tree?.children));

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

		const handlePointerMove = (event: PointerEvent) => {
			const start = resizeStartRef.current;
			if (!start || event.pointerId !== start.pointerId) return;
			event.preventDefault();
			const maxWidth = resizeMaxWidthRef.current;
			const nextWidth = clampResizeWidth(
				start.width + start.clientX - event.clientX,
				mode,
				resizeMaxWidthRef.current,
			);
			const directMaxWidth = Math.max(
				start.width,
				getMaximumWorkspaceWidth(window.innerWidth, appStore.sidebarCollapsed, mode),
			);
			if (nextWidth <= directMaxWidth) {
				// Keep the workspace attached to the pointer while the current
				// window has room for it. The preview edge is only a fallback for
				// widths that cannot be applied to the live layout yet.
				resizePreviewWidthRef.current = null;
				setResizeLimitReached(false);
				setResizePreviewWidth(null);
				onWidthChange(nextWidth);
				return;
			}
			resizePreviewWidthRef.current = nextWidth;
			setResizeLimitReached(nextWidth >= maxWidth);
			setResizePreviewWidth(nextWidth);
		};
		const finishResize = (commit: boolean) => {
			const start = resizeStartRef.current;
			if (!start) return;
			const nextWidth = commit ? resizePreviewWidthRef.current : null;
			resizeStartRef.current = null;
			resizePreviewWidthRef.current = null;
			resizeMaxWidthRef.current = WORKSPACE_MAX_WIDTH;
			setResizeLimitReached(false);
			setResizePreviewWidth(null);
			setIsResizing(false);
			if (nextWidth !== null) void commitResize(nextWidth);
			else if (!commit) onWidthChange(start.width);
		};
		const handlePointerUp = (event: PointerEvent) => {
			if (resizeStartRef.current?.pointerId !== event.pointerId) return;
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
			document.body.classList.remove("workspace-resizing");
			window.removeEventListener("pointermove", handlePointerMove);
			window.removeEventListener("pointerup", handlePointerUp);
			window.removeEventListener("pointercancel", handlePointerCancel);
			window.removeEventListener("blur", handleWindowBlur);
			window.removeEventListener("keydown", handleKeyDown);
		};
	}, [commitResize, isResizing, mode]);

	// Keep the workspace browser mounted after its first open. Collapsing the
	// panel should hide it, not restart its tree/preview lifecycle on reopen.
	useEffect(() => {
		if (mode !== "collapsed") setHasOpenedWorkspace(true);
	}, [mode]);

	const startResize = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
		event.preventDefault();
		// Invalidate a previous asynchronous commit if the user starts another
		// resize before a host-window expansion has finished.
		resizeCommitGenerationRef.current += 1;
		const layoutMaxWidth = getMaximumWorkspaceWidth(window.innerWidth, appStore.sidebarCollapsed, mode);
		const startWidth = clampResizeWidth(width, mode, Math.max(width, layoutMaxWidth));
		resizeMaxWidthRef.current = Math.max(startWidth, layoutMaxWidth);
		resizeStartRef.current = {
			pointerId: event.pointerId,
			clientX: event.clientX,
			width: startWidth,
		};
		resizePreviewWidthRef.current = null;
		setResizeLimitReached(false);
		setResizePreviewWidth(null);
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
						getMaximumWorkspaceWidth(expandedViewportWidth, appStore.sidebarCollapsed, mode),
					),
				);
				const maxWidth = resizeMaxWidthRef.current;
				setResizeLimitReached(
					resizePreviewWidthRef.current !== null && resizePreviewWidthRef.current >= maxWidth,
				);
			});
		}
	}, [mode, width]);

	const collapsed = mode === "collapsed";
	const shouldMountContent = hasOpenedWorkspace || !collapsed;
	const resizePreviewPortal = isResizing && resizePreviewWidth !== null && typeof document !== "undefined"
		? createPortal(
			<div
				className={`workspace-resize-preview ${resizeLimitReached ? "workspace-resize-preview--limit" : ""}`}
				aria-hidden="true"
				style={{ "--inno-workspace-preview-width": `${resizePreviewWidth}px` } as React.CSSProperties}
			/>,
			document.body,
		)
		: null;
	useEffect(() => () => {
		if (dndManager.getMonitor().isDragging()) {
			dndManager.getActions().endDrag();
		}
	}, [dndManager]);

	return (
		<aside className={`workspace-panel inno-workspace-scope relative flex h-full min-h-0 min-w-0 flex-col ${resizePreviewWidth !== null ? "workspace-resize-preview-active" : ""} ${collapsed ? "overflow-visible border-l-0 bg-transparent" : "overflow-hidden border-l border-[var(--inno-border)] bg-[var(--inno-workspace-bg)]"}`}>
			{resizePreviewPortal}
			{mode === "half" || mode === "quarter" ? (
				<button
					className="workspace-resize-handle"
					aria-label={t("workspace.resize") ?? ""}
					title={`${t("workspace.resize")} (${width}px)`}
					onPointerDown={startResize}
				/>
			) : null}

			{/* Panel header — mirrors the design mockup's artifact-panel head:
			    title + file count on the left, chrome actions on the right. */}
			<div className={`inno-workspace-header inno-workspace-panel-header flex h-12 shrink-0 items-center justify-between gap-2 border-b border-[var(--inno-border)] bg-[var(--inno-workspace-bg)] px-3.5 ${collapsed ? "hidden" : ""}`}>
				<div className="min-w-0 flex items-baseline gap-1.5">
					<span className="whitespace-nowrap text-[14.5px] font-semibold text-[var(--inno-text)]">{t("workspace.panelTitle")}</span>
					<span className="whitespace-nowrap text-[11.5px] text-[var(--inno-text-subtle)]">{t("workspace.fileCount", { count: fileCount })}</span>
				</div>
				<div className="inno-workspace-header-actions">
					<button
						type="button"
						className={`inno-workspace-header-button ${terminalOpen ? "is-active" : ""}`}
						title={(terminalOpen ? t("terminal.collapse") : t("terminal.expand")) ?? ""}
						aria-label={(terminalOpen ? t("terminal.collapse") : t("terminal.expand")) ?? ""}
						onClick={() => terminalStore.setOpen(!terminalOpen)}
					>
						<TerminalIcon size={15} strokeWidth={1.8} />
					</button>
					<button
						type="button"
						className={`inno-workspace-header-button ${mode === "full" ? "is-active" : ""} max-[960px]:hidden`}
						title={mode === "full" ? (t("workspace.half") ?? "") : (t("workspace.full") ?? "")}
						aria-label={mode === "full" ? (t("workspace.half") ?? "") : (t("workspace.full") ?? "")}
						aria-pressed={mode === "full"}
						onClick={() => onModeChange(mode === "full" ? "half" : "full")}
					>
						{mode === "full" ? <Minimize2 size={15} strokeWidth={1.8} /> : <Maximize2 size={15} strokeWidth={1.8} />}
					</button>
					<span className="inno-workspace-header-toggle-slot" aria-hidden="true" />
				</div>
			</div>

			<div
				className={`flex-1 min-h-0 overflow-hidden bg-[var(--inno-workspace-bg)] ${collapsed ? "hidden" : ""}`}
			>
				{shouldMountContent ? (
					<WorkspaceContentErrorBoundary resetKey={`preview:${contentRetryKey}`} onRetry={retryContent}>
						<Suspense fallback={<WorkspaceContentFallback />}>
							<WorkspaceBrowserContent retryKey={contentRetryKey} onPreviewFile={onPreviewFile} dndManager={dndManager} />
						</Suspense>
					</WorkspaceContentErrorBoundary>
				) : null}
			</div>
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
