import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { motion, AnimatePresence } from "motion/react";
import { DndProvider, useDragDropManager } from "react-dnd";
import { HTML5Backend } from "react-dnd-html5-backend";
import type { DragDropManager } from "dnd-core";
import { PanelRightOpen, PanelRightClose, Columns2, Maximize2, BookOpen, BriefcaseBusiness, FolderKanban, Settings, Sparkles, Terminal as TerminalIcon, UserRound } from "lucide-react";
import type { RightPanelTab, WorkspaceMode } from "../stores/app-store.js";
import { getMaximumWorkspaceWidth, WORKSPACE_MAX_WIDTH, WORKSPACE_MIN_WIDTH, WORKSPACE_QUARTER_MIN_WIDTH } from "../stores/app-layout.js";
import { appStore } from "../stores/app-store.js";
import { settingsStore } from "../stores/settings-store.js";
import { terminalStore } from "../stores/terminal-store.js";
import { ensureWindowForPanel } from "../stores/window-expansion.js";
import { useStoreSnapshot } from "./hooks.js";
import { isDynamicImportError, recoverFromDynamicImportError } from "../utils/dynamic-import-recovery.js";

const Notebook = lazy(() => import("./Notebook.js").then((mod) => ({ default: mod.Notebook })));
const JobsPanel = lazy(() => import("./JobsPanel.js").then((mod) => ({ default: mod.JobsPanel })));
const LearnerProfilePanel = lazy(() => import("./LearnerProfilePanel.js").then((mod) => ({ default: mod.LearnerProfilePanel })));
const SkillsPanel = lazy(() => import("./SkillsPanel.js").then((mod) => ({ default: mod.SkillsPanel })));

interface WorkspacePanelProps {
	activeTab: RightPanelTab;
	mode: WorkspaceMode;
	width: number;
	onTabChange(tab: RightPanelTab): void;
	onModeChange(mode: WorkspaceMode): void;
	onWidthChange(width: number): void;
	onPreviewFile(width: number): void | Promise<void>;
}

const TAB_ORDER: RightPanelTab[] = ["preview", "notebook", "profile", "jobs", "skills"];

const TAB_ICONS: Record<RightPanelTab, ReactNode> = {
	notebook: <BookOpen size={14} />,
	preview: <FolderKanban size={14} />,
	profile: <UserRound size={14} />,
	jobs: <BriefcaseBusiness size={14} />,
	skills: <Sparkles size={14} />,
};

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

function WorkspaceContent({ activeTab, retryKey, onPreviewFile, dndManager }: { activeTab: RightPanelTab; retryKey: number; onPreviewFile: WorkspacePanelProps["onPreviewFile"]; dndManager: DragDropManager }) {
	switch (activeTab) {
		case "notebook":
			return <Notebook />;
		case "preview":
			return <WorkspaceBrowserContent retryKey={retryKey} onPreviewFile={onPreviewFile} dndManager={dndManager} />;
		case "profile":
			return <LearnerProfilePanel />;
		case "skills":
			return <SkillsPanel dndManager={dndManager} />;
		case "jobs":
			return <JobsPanel />;
	}
}

function WorkspacePanelContent({ activeTab, mode, width, onTabChange, onModeChange, onWidthChange, onPreviewFile }: WorkspacePanelProps) {
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

	// In Simple Mode, hide the advanced tabs: notebook (L2 wiki), profile (L1),
	// jobs (scheduled tasks) and skills — leaving just preview.
	const simpleMode = useStoreSnapshot(settingsStore, () => settingsStore.settings?.simpleMode?.enabled === true);
	const terminalOpen = useStoreSnapshot(terminalStore, () => terminalStore.isOpen);
	const HIDDEN_IN_SIMPLE: RightPanelTab[] = ["notebook", "profile", "jobs", "skills"];
	const tabs = simpleMode ? TAB_ORDER.filter((tab) => !HIDDEN_IN_SIMPLE.includes(tab)) : TAB_ORDER;

	// If Simple Mode turns on while a now-hidden tab is active, fall back to preview
	// so the panel never shows a hidden/blank view.
	useEffect(() => {
		if (simpleMode && HIDDEN_IN_SIMPLE.includes(activeTab)) {
			onTabChange("preview");
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
		}, [simpleMode, activeTab, onTabChange]);

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

	const compact = mode !== "full" && width < 500;
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
	const handleTabChange = useCallback((tab: RightPanelTab) => {
		if (tab !== activeTab && dndManager.getMonitor().isDragging()) {
			// A file drag can outlive the source tree for a tick after drop. End
			// it before the tab transition removes that tree from the document.
			dndManager.getActions().endDrag();
		}
		onTabChange(tab);
	}, [activeTab, dndManager, onTabChange]);

	useEffect(() => () => {
		if (dndManager.getMonitor().isDragging()) {
			dndManager.getActions().endDrag();
		}
	}, [dndManager]);

	return (
		<aside className={`workspace-panel inno-workspace-scope relative flex h-full min-h-0 min-w-0 flex-col ${resizePreviewWidth !== null ? "workspace-resize-preview-active" : ""} ${collapsed ? "overflow-visible border-l-0 bg-transparent" : "overflow-hidden border-l border-[var(--inno-border)] bg-[var(--inno-workspace-bg)]"}`}>
			{resizePreviewPortal}
			{collapsed ? (
				<button
					className="absolute right-2 top-2 z-20 flex h-8 w-8 items-center justify-center rounded-lg text-[var(--inno-text-subtle)] transition-colors hover:bg-white/90 hover:text-[var(--inno-text)] hover:shadow-sm"
					title={t("workspace.openWorkspace") ?? ""}
					onClick={() => onModeChange("half")}
				>
					<PanelRightOpen size={16} />
				</button>
			) : null}
			{mode === "half" || mode === "quarter" ? (
				<button
					className="workspace-resize-handle"
					aria-label={t("workspace.resize") ?? ""}
					title={`${t("workspace.resize")} (${width}px)`}
					onPointerDown={startResize}
				/>
			) : null}

			<div className={`flex h-10 items-center gap-1 border-b border-[var(--inno-border)] bg-[var(--inno-workspace-chrome)] px-2 ${collapsed ? "hidden" : ""}`}>
				<div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden">
					{tabs.map((tab) => {
						const label = t(`workspace.tabs.${tab}`);
						const isActive = activeTab === tab;
						return (
							<button
								key={tab}
								className={`inno-workspace-tab flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-md transition-colors ${compact ? "w-7 justify-center px-0" : "px-2"} ${isActive ? "bg-[var(--inno-surface)] font-medium text-[var(--inno-accent)] shadow-sm" : "text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface)] hover:text-[var(--inno-text)]"}`}
								title={compact ? label : undefined}
								aria-label={compact ? label : undefined}
								onClick={() => handleTabChange(tab)}
							>
								{TAB_ICONS[tab]}
								{compact ? null : label}
							</button>
						);
					})}
				</div>
				<div className="ml-1 flex shrink-0 items-center gap-1 border-l border-[var(--inno-border)] pl-1">
					<button
						className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--inno-text-subtle)] transition-colors hover:bg-[var(--inno-surface)] hover:text-[var(--inno-text-muted)]"
						title={t("settings.title") ?? ""}
						onClick={() => appStore.openSettings()}
					>
						<Settings size={14} />
					</button>
					<button
						className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--inno-text-subtle)] transition-colors hover:bg-[var(--inno-surface)] hover:text-[var(--inno-text-muted)]"
						title={(terminalOpen ? t("terminal.collapse") : t("terminal.expand")) ?? ""}
						aria-label={(terminalOpen ? t("terminal.collapse") : t("terminal.expand")) ?? ""}
						onClick={() => terminalStore.setOpen(!terminalOpen)}
					>
						<TerminalIcon size={14} />
					</button>
					<button
						className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--inno-text-subtle)] transition-colors hover:bg-[var(--inno-surface)] hover:text-[var(--inno-text-muted)]"
						title={mode === "full" ? (t("workspace.half") ?? "") : (t("workspace.full") ?? "")}
						onClick={() => onModeChange(mode === "full" ? "half" : "full")}
					>
						{mode === "full" ? <Columns2 size={14} /> : <Maximize2 size={14} />}
					</button>
					<button
						className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--inno-text-subtle)] transition-colors hover:bg-[var(--inno-surface)] hover:text-[var(--inno-text-muted)]"
						title={t("workspace.collapse") ?? ""}
						onClick={() => onModeChange("collapsed")}
					>
						<PanelRightClose size={14} />
					</button>
				</div>
			</div>

			<div
				className={`flex-1 min-h-0 overflow-hidden bg-[var(--inno-workspace-bg)] ${collapsed ? "hidden" : ""}`}
				style={{
					background:
						"linear-gradient(90deg, rgba(37, 99, 235, 0.035) 1px, transparent 1px), linear-gradient(rgba(37, 99, 235, 0.035) 1px, transparent 1px), var(--inno-workspace-bg)",
					backgroundSize: "36px 36px",
				}}
			>
				{shouldMountContent ? (
					<AnimatePresence mode="wait">
						<motion.div
							key={`${activeTab}:${contentRetryKey}`}
							className="h-full"
							initial={{ opacity: 0, y: 6 }}
							animate={{ opacity: 1, y: 0 }}
							exit={{ opacity: 0, y: -6 }}
							transition={{ duration: 0.18, ease: "easeOut" }}
						>
							<WorkspaceContentErrorBoundary resetKey={`${activeTab}:${contentRetryKey}`} onRetry={retryContent}>
								<Suspense fallback={<WorkspaceContentFallback />}>
									<WorkspaceContent activeTab={activeTab} retryKey={contentRetryKey} onPreviewFile={onPreviewFile} dndManager={dndManager} />
								</Suspense>
							</WorkspaceContentErrorBoundary>
						</motion.div>
					</AnimatePresence>
				) : null}
			</div>
		</aside>
	);
}

/**
 * react-arborist creates an HTML5 backend for every Tree unless a manager is
 * supplied. The workspace and skills tabs can overlap briefly during a tab
 * transition, so keep one manager for the whole panel and hand it to both
 * trees instead of letting each tab register a backend on document.
 */
export function WorkspacePanel(props: WorkspacePanelProps) {
	return (
		<DndProvider backend={HTML5Backend}>
			<WorkspacePanelContent {...props} />
		</DndProvider>
	);
}
