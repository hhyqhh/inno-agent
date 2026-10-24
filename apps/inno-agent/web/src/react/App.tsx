import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Terminal as TerminalIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { appStore, pageFromSearch, type AppPage, type WorkspaceMode } from "../stores/app-store.js";
import { settingsStore } from "../stores/settings-store.js";
import { themeStore, type ThemeId } from "../stores/theme-store.js";
import { sessionsStore } from "../stores/sessions-store.js";
import { workspacesStore } from "../stores/workspaces-store.js";
import { chatStore } from "../stores/chat-store.js";
import { terminalStore } from "../stores/terminal-store.js";
import { workspaceStore } from "../stores/workspace-store.js";
import { notebookStore } from "../stores/notebook-store.js";
import type { SearchResult } from "../../../src/shared/search.js";
import { useStoreSnapshot } from "./hooks.js";
import { InnoDndProvider } from "./ui/dnd-backend.js";
import { ChatCenter } from "./ChatCenter.js";
import { FeaturePage } from "./FeaturePage.js";
import { SessionSidebar, startNewChat } from "./SessionSidebar.js";
import { WorkspacePanel } from "./WorkspacePanel.js";
import { WorkspacePreviewTabs } from "./WorkspacePreviewTabs.js";
import { DesktopWindowChrome } from "./DesktopWindowChrome.js";
import { Tooltip } from "./ui/index.js";
import {
	CHAT_ONLY_BP,
	CHAT_BASELINE_WIDTH,
	DESKTOP_SIDEBAR_RAIL_WIDTH,
	fitPanelLayout,
	getSidebarLayoutWidth,
	WORKSPACE_DEFAULT_WIDTH,
} from "../stores/app-layout.js";
import { ensureWindowForPanel } from "../stores/window-expansion.js";
import { SearchPanel } from "./SearchPanel.js";
import {
	getNavigationAvailability,
	initializeNavigationHistory,
	NAVIGATION_HISTORY_CHANGE_EVENT,
	type NavigationAvailability,
} from "../stores/navigation-history.js";

const SettingsOverlay = lazy(() => import("./settings/SettingsOverlay.js").then((module) => ({ default: module.SettingsOverlay })));

let initializationPromise: Promise<void> | null = null;

function jumpToConversationEntry(entryId: string): void {
	const deadline = performance.now() + 5000;
	const findAndScroll = () => {
		const target = [...document.querySelectorAll<HTMLElement>("[data-entry-id]")]
			.find((element) => element.dataset.entryId === entryId);
		if (target) {
			target.scrollIntoView({ block: "center", behavior: "smooth" });
			return;
		}
		if (performance.now() < deadline) window.requestAnimationFrame(findAndScroll);
	};
	window.requestAnimationFrame(findAndScroll);
}

function initializeApp(): Promise<void> {
	if (initializationPromise) return initializationPromise;
	initializationPromise = (async () => {
		await Promise.all([sessionsStore.load(), workspacesStore.load()]);
		const requestedSession = new URL(window.location.href).searchParams.get("session");
		if (requestedSession) await sessionsStore.openSession(requestedSession, { historyMode: "none" });
	})();
	return initializationPromise;
}

function MainApp() {
	const { t } = useTranslation();
	const isDesktopWindow = Boolean(window.innoDesktop);
	const isWindowsDesktop = isDesktopWindow && /Win/i.test(window.navigator.platform);
	const [isMacFullScreen, setIsMacFullScreen] = useState(false);
	useEffect(() => {
		const desktop = window.innoDesktop;
		if (!desktop?.isFullScreen || !desktop.onFullScreenChange || !/Mac/i.test(window.navigator.platform)) return;
		let active = true;
		const unsubscribe = desktop.onFullScreenChange(setIsMacFullScreen);
		void desktop.isFullScreen().then((isFullScreen) => {
			if (active) setIsMacFullScreen(isFullScreen);
		});
		return () => {
			active = false;
			unsubscribe();
		};
	}, []);
	const [desktopHeaderHost, setDesktopHeaderHost] = useState<HTMLDivElement | null>(null);
	const setDesktopHeaderHostRef = useCallback((host: HTMLDivElement | null) => {
		setDesktopHeaderHost((current) => current === host ? current : host);
	}, []);
	const [searchOpen, setSearchOpen] = useState(false);
	const [navigation, setNavigation] = useState<NavigationAvailability>({ canGoBack: false, canGoForward: false });
	const [workspaceNarrowHint, setWorkspaceNarrowHint] = useState(false);
	const workspaceHintTimerRef = useRef<number | null>(null);
	const showWorkspaceNarrowHint = useCallback(() => {
		setWorkspaceNarrowHint(true);
		if (workspaceHintTimerRef.current !== null) window.clearTimeout(workspaceHintTimerRef.current);
		workspaceHintTimerRef.current = window.setTimeout(() => setWorkspaceNarrowHint(false), 2600);
	}, []);
	useEffect(() => () => {
		if (workspaceHintTimerRef.current !== null) window.clearTimeout(workspaceHintTimerRef.current);
	}, []);
	const app = useStoreSnapshot(appStore, () => ({
		page: appStore.page,
		settingsOpen: appStore.settingsOpen,
		sidebarCollapsed: appStore.sidebarCollapsed,
		sidebarWidth: appStore.sidebarWidth,
		workspaceMode: appStore.workspaceMode,
		workspaceWidth: appStore.workspaceWidth,
	}));
	const currentSessionId = useStoreSnapshot(sessionsStore, () => sessionsStore.currentSessionId);
	const showNewChatControl = isDesktopWindow && app.page === "chat" && app.sidebarCollapsed && currentSessionId !== null;
	const terminalOpen = useStoreSnapshot(terminalStore, () => terminalStore.isOpen);
	// The terminal toggle belongs beside "随便问问" in the chat title row.
	const desktopTerminalControl = isDesktopWindow && app.page === "chat" ? (
		<Tooltip label={t(terminalOpen ? "terminal.collapse" : "terminal.expand")} side="bottom">
			<button
				type="button"
				className={`inno-window-chrome-button inno-window-chrome-terminal-button ${terminalOpen ? "is-active" : ""}`}
				aria-label={t(terminalOpen ? "terminal.collapse" : "terminal.expand") ?? ""}
				aria-pressed={terminalOpen}
				onClick={() => terminalStore.setOpen(!terminalOpen)}
			>
				<TerminalIcon size={15} strokeWidth={1.8} />
			</button>
		</Tooltip>
	) : undefined;
	useEffect(() => {
		void initializeApp();
		const updateNavigation = () => setNavigation(getNavigationAvailability());
		const onPopState = () => {
			updateNavigation();
			// Restore the main-area page from the URL (back/forward navigation).
			appStore.setPage(pageFromSearch(window.location.search), "none");
			const sessionId = new URL(window.location.href).searchParams.get("session");
			if (!sessionId) sessionsStore.showWelcomeFromHistory();
			else if (sessionId !== sessionsStore.currentSessionId) void sessionsStore.openSession(sessionId, { historyMode: "none" });
		};
		window.addEventListener(NAVIGATION_HISTORY_CHANGE_EVENT, updateNavigation);
		window.addEventListener("popstate", onPopState);
		initializeNavigationHistory();
		updateNavigation();
		return () => {
			window.removeEventListener(NAVIGATION_HISTORY_CHANGE_EVENT, updateNavigation);
			window.removeEventListener("popstate", onPopState);
		};
	}, []);

	useEffect(() => {
		const root = document.documentElement;
		const markPointerInput = () => { root.dataset.innoInputModality = "pointer"; };
		const markKeyboardInput = () => { root.dataset.innoInputModality = "keyboard"; };
		document.addEventListener("pointerdown", markPointerInput, true);
		document.addEventListener("keydown", markKeyboardInput, true);
		return () => {
			document.removeEventListener("pointerdown", markPointerInput, true);
			document.removeEventListener("keydown", markKeyboardInput, true);
			delete root.dataset.innoInputModality;
		};
	}, []);

	// Load settings once at boot so Simple Mode (tab hiding) is
	// available app-wide before the user ever opens the Settings panel.
	useEffect(() => {
		void settingsStore.load();
		// After settings load, sync theme from backend if it differs from local.
		// localStorage is the instant source (FOWT prevention); backend keeps
		// theme consistent across devices.
		const unsubscribe = settingsStore.on("change", () => {
			const remote = settingsStore.settings?.ui?.theme as ThemeId | undefined;
			if (remote && remote !== themeStore.current) {
				themeStore.apply(remote);
			}
		});
		return unsubscribe;
	}, []);

	// Re-arm live connections when a backgrounded page returns. Mobile browsers
	// suspend timers and kill in-flight streams/sockets while hidden, so both
	// the chat SSE stream and the terminal WebSocket get a resume hook.
	useEffect(() => {
		const onResume = () => {
			if (document.visibilityState !== "visible") return;
			void chatStore.handleAppResume();
			terminalStore.handleAppResume();
		};
		document.addEventListener("visibilitychange", onResume);
		window.addEventListener("pageshow", onResume);
		window.addEventListener("online", onResume);
		return () => {
			document.removeEventListener("visibilitychange", onResume);
			window.removeEventListener("pageshow", onResume);
			window.removeEventListener("online", onResume);
		};
	}, []);

	// At narrow widths keep the icon rail but fold the optional Chat panel so it
	// cannot squeeze the conversation. Browser sizing retains its old breakpoint.
	// We intentionally do not restore either column when the window widens again;
	// reopening a panel is an explicit user action. Runs only on mount and on
	// window-width changes — NOT on panel state changes, so panels reopened at
	// narrow widths (drawer sidebar / full-overlay workspace) stay open.
	useEffect(() => {
		let previousWidth = window.innerWidth;
		const enforceChatOnly = () => {
			const sidebarBreakpoint = isDesktopWindow
				? CHAT_BASELINE_WIDTH + getSidebarLayoutWidth(false, true, appStore.sidebarWidth) - 1 : CHAT_ONLY_BP;
			if (window.innerWidth > sidebarBreakpoint) return;
			if (!appStore.sidebarCollapsed) appStore.setSidebarCollapsed(true);
			if (window.innerWidth <= CHAT_ONLY_BP && appStore.workspaceMode !== "collapsed") {
				appStore.setWorkspaceMode("collapsed");
			}
		};
		const onResize = () => {
			if (previousWidth === window.innerWidth) return;
			previousWidth = window.innerWidth;
			enforceChatOnly();
		};
		enforceChatOnly();
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, [isDesktopWindow]);

	// Track the narrow breakpoint so the drawer scrim only renders on small
	// viewports; desktop uses the side-by-side column layout instead.
	const [isNarrow, setIsNarrow] = useState(() =>
		typeof window !== "undefined" && window.matchMedia(`(max-width: ${CHAT_ONLY_BP}px)`).matches,
	);
	useEffect(() => {
		const mql = window.matchMedia(`(max-width: ${CHAT_ONLY_BP}px)`);
		const onChange = (e: MediaQueryListEvent) => setIsNarrow(e.matches);
		mql.addEventListener("change", onChange);
		return () => mql.removeEventListener("change", onChange);
	}, []);

	// Keep the app shell matched to the *visual* viewport. On iOS the virtual
	// keyboard shrinks the visual viewport without touching the layout viewport,
	// which would otherwise leave the bottom-docked composer hidden behind the
	// keyboard. Chrome/Android handles this via `interactive-widget=resizes-content`
	// in the viewport meta; this hook is the cross-browser fallback. Ignored
	// while pinch-zoomed (scale !== 1), where tracking would fight the zoom.
	useEffect(() => {
		const vv = window.visualViewport;
		if (!vv) return;
		const apply = () => {
			if (vv.scale !== 1) return;
			document.documentElement.style.setProperty("--inno-viewport-height", `${Math.round(vv.height)}px`);
		};
		apply();
		vv.addEventListener("resize", apply);
		vv.addEventListener("scroll", apply);
		return () => {
			vv.removeEventListener("resize", apply);
			vv.removeEventListener("scroll", apply);
			document.documentElement.style.removeProperty("--inno-viewport-height");
		};
	}, []);

	// A window can be resized after a panel was opened. Keep that action from
	// leaving the chat squeezed beside a stale, oversized workspace preview.
	// Feature pages don't render the right panel — leave its layout state alone.
	useEffect(() => {
		if (app.page !== "chat") return;
		const fitCurrentLayout = () => {
			if (isDesktopWindow && !appStore.sidebarCollapsed
				&& window.innerWidth < CHAT_BASELINE_WIDTH + getSidebarLayoutWidth(false, true, appStore.sidebarWidth)) {
				appStore.setSidebarCollapsed(true);
			}
			const currentMode = appStore.workspaceMode;
			if (currentMode === "collapsed" || currentMode === "full") return;
			const fitted = fitPanelLayout(
				window.innerWidth,
				appStore.sidebarCollapsed,
				currentMode,
				appStore.workspaceWidth,
				isDesktopWindow,
				appStore.sidebarWidth,
			);
			if (!fitted) {
				appStore.setWorkspaceMode("collapsed");
				return;
			}
			if (fitted.sidebarCollapsed !== appStore.sidebarCollapsed) {
				appStore.setSidebarCollapsed(fitted.sidebarCollapsed);
			}
			if (fitted.workspaceMode !== appStore.workspaceMode) {
				appStore.setWorkspaceMode(fitted.workspaceMode);
			}
			if (fitted.workspaceWidth !== appStore.workspaceWidth) {
				appStore.setWorkspaceWidth(fitted.workspaceWidth);
			}
		};

		fitCurrentLayout();
		window.addEventListener("resize", fitCurrentLayout);
		return () => window.removeEventListener("resize", fitCurrentLayout);
	}, [app.page, isDesktopWindow]);


	const openFilePreview = useCallback(async (minimumWidth: number) => {
		// Full mode is already the reading surface; selecting another file should
		// not unexpectedly return the user to a split layout.
		if (appStore.workspaceMode === "full") return;
		if (isNarrow) {
			appStore.setWorkspaceMode("full");
			return;
		}
		const previewWidth = appStore.workspaceMode === "collapsed"
			? minimumWidth
			: Math.max(minimumWidth, appStore.workspaceWidth);
		const result = await ensureWindowForPanel("right", previewWidth, "half");
		if (result === "busy") return;
		// Do not force the sidebar closed here: setWorkspaceWidth/setWorkspaceMode
		// below already collapse it if (and only if) that is what makes the panel fit.
		appStore.setWorkspaceWidth(previewWidth);
		appStore.setWorkspaceMode("half");
	}, [isNarrow, ensureWindowForPanel]);

	const openSearchResult = useCallback(async (result: SearchResult) => {
		if (isNarrow) appStore.setSidebarCollapsed(true);
		if (result.category === "conversation") {
			if (!result.sessionId) return;
			appStore.setPage("chat");
			await sessionsStore.openSession(result.sessionId);
			if (result.entryId) jumpToConversationEntry(result.entryId);
			return;
		}
		if (result.category === "workspace" || result.category === "file") {
			if (!result.workspaceId) return;
			appStore.setPage("chat");
			appStore.setRightPanelTab("preview");
			await workspaceStore.setActiveWorkspace(result.workspaceId);
			if (result.category === "file" && result.path) await workspaceStore.selectFile(result.path);
			await openFilePreview(WORKSPACE_DEFAULT_WIDTH);
			return;
		}
		appStore.setPage("notebook");
		if (result.path) await notebookStore.selectPage(result.path);
	}, [isNarrow, openFilePreview]);

	const openSearch = useCallback(() => {
		sessionsStore.setSearchQuery("");
		if (window.innoDesktop) {
			void window.innoDesktop.openSearchWindow(themeStore.current);
			return;
		}
		setSearchOpen(true);
	}, []);
	const navigateFromSearch = useCallback((result: SearchResult) => {
		setSearchOpen(false);
		return openSearchResult(result);
	}, [openSearchResult]);

	useEffect(() => {
		if (isDesktopWindow) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "k") return;
			event.preventDefault();
			openSearch();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [isDesktopWindow, openSearch]);

	useEffect(() => window.innoDesktop?.onSearchNavigation((result) => {
		void openSearchResult(result);
	}), [openSearchResult]);

	const openSidebar = useCallback(() => {
		void (async () => {
			const result = await ensureWindowForPanel("left");
			if (result === "busy") return;
			if (isDesktopWindow && result === "unavailable") return;
			// If the display cannot fit both optional columns, the store fits the
			// workspace or closes it so the clicked panel still responds. Electron
			// keeps the icon rail when there is no room for its fixed-width panel.
			appStore.setSidebarCollapsed(false);
		})();
	}, [ensureWindowForPanel, isDesktopWindow]);
	const toggleSidebar = useCallback(() => {
		if (appStore.sidebarCollapsed) {
			void openSidebar();
			return;
		}
		appStore.setSidebarCollapsed(true);
	}, [openSidebar]);

	const setWorkspaceMode = useCallback((mode: WorkspaceMode) => {
		if (mode === "collapsed" || app.workspaceMode !== "collapsed") {
			appStore.setWorkspaceMode(mode);
			return;
		}
		void (async () => {
			// Opening the file area is a deliberate transition into the split
			// workspace view. Restore the reference width when an older saved
			// value is only wide enough for the narrow single-pane fallback.
			const requestedWidth = Math.max(app.workspaceWidth, WORKSPACE_DEFAULT_WIDTH);
			const result = await ensureWindowForPanel("right", requestedWidth, "half");
			if (result === "busy") return;
			// Do not force the sidebar closed here: setWorkspaceMode below already
			// collapses it if (and only if) that is what makes the panel fit, and
			// otherwise leaves the layout untouched instead of collapsing for nothing.
			if (appStore.workspaceWidth < requestedWidth) appStore.setWorkspaceWidth(requestedWidth);
			appStore.setWorkspaceMode(mode);
			// The layout fitter can refuse the split when the viewport is too
			// narrow; a clickable button that silently does nothing is worse than
			// an explicit hint.
			if (appStore.workspaceMode === "collapsed") showWorkspaceNarrowHint();
		})();
	}, [app.workspaceMode, ensureWindowForPanel, showWorkspaceNarrowHint]);
	const toggleWorkspace = useCallback(() => {
		setWorkspaceMode(app.workspaceMode === "collapsed" ? "half" : "collapsed");
	}, [app.workspaceMode, setWorkspaceMode]);
	const setWorkspaceWidth = useCallback((width: number) => appStore.setWorkspaceWidth(width), []);

	// Feature pages occupy the whole center column; the right workspace panel is
	// a chat-only surface. Its mode/width state is preserved (not mutated) so
	// returning to chat restores the exact previous layout.
	const chatVisible = app.page === "chat";
	const layoutWorkspaceMode = chatVisible ? app.workspaceMode : "collapsed";
	const workspacePanel = <WorkspacePanel
		mode={app.workspaceMode}
		width={app.workspaceWidth}
		merged={isDesktopWindow}
		showFileTree={!isDesktopWindow}
		showTerminalToggle={!isDesktopWindow}
		onModeChange={setWorkspaceMode}
		onWidthChange={setWorkspaceWidth}
		onPreviewFile={openFilePreview}
	/>;

	return (
		<>
			<InnoDndProvider>
				<div
					className={`app-layout app-layout--${isDesktopWindow ? "desktop" : "browser"}${isWindowsDesktop ? " app-layout--windows" : ""}${isMacFullScreen ? " app-layout--macos-fullscreen" : ""}${chatVisible ? " app-layout--chat" : ""} app-layout--sidebar-${app.sidebarCollapsed ? "collapsed" : "expanded"} app-layout--workspace-${layoutWorkspaceMode}`}
					style={{
						"--inno-workspace-width": `${app.workspaceWidth}px`,
						"--sidebar-rail-w": `${DESKTOP_SIDEBAR_RAIL_WIDTH}px`,
						"--sidebar-content-w": `min(${app.sidebarWidth}px, calc(100vw - ${DESKTOP_SIDEBAR_RAIL_WIDTH + 8}px))`,
					} as React.CSSProperties}
				>
					<SessionSidebar
						onPreviewFile={openFilePreview}
						collapsed={app.sidebarCollapsed}
						isDesktopWindow={isDesktopWindow}
						onOpenSearch={openSearch}
						workspaceContent={isDesktopWindow && chatVisible ? workspacePanel : undefined}
						chatContent={isDesktopWindow && chatVisible
							? <ChatCenter onPreviewFile={openFilePreview} desktopHeaderHost={desktopHeaderHost} />
							: undefined}
					/>
					{isDesktopWindow && chatVisible ? null : chatVisible ? (
						<ChatCenter onPreviewFile={openFilePreview} terminalControl={desktopTerminalControl} />
					) : (
						<FeaturePage page={app.page as Exclude<AppPage, "chat">} />
					)}
					{chatVisible && !isDesktopWindow ? workspacePanel : null}
					<DesktopWindowChrome
						showWorkspaceControl={chatVisible}
						showSidebarControl={chatVisible}
						showNewChatControl={showNewChatControl}
						showChatHeader={chatVisible}
						isDesktopWindow={isDesktopWindow}
						terminalControl={desktopTerminalControl}
						workspaceTabs={<WorkspacePreviewTabs />}
						workspaceMode={app.workspaceMode}
						workspaceFullLabel={t("workspace.full")}
						workspaceRestoreLabel={t("workspace.half")}
						onWorkspaceModeChange={setWorkspaceMode}
						sidebarCollapsed={app.sidebarCollapsed}
						newChatLabel={t("nav.newChat")}
						sidebarExpandLabel={t("sidebar.expandSidebar")}
						sidebarCollapseLabel={t("sidebar.collapseSidebar")}
						workspaceCollapsed={app.workspaceMode === "collapsed"}
						workspaceOpenLabel={t("workspace.openWorkspace")}
						workspaceCollapseLabel={t("workspace.collapseWorkspace")}
						backLabel={t("common.back")}
						forwardLabel={t("common.forward")}
						canNavigateBack={navigation.canGoBack}
						canNavigateForward={navigation.canGoForward}
						onHeaderHostChange={setDesktopHeaderHostRef}
						onToggleSidebar={toggleSidebar}
						onNewChat={startNewChat}
						onNavigateBack={() => window.history.back()}
						onNavigateForward={() => window.history.forward()}
						onToggleWorkspace={toggleWorkspace}
					/>
					{/* Narrow viewports present the sidebar as an overlay drawer; the
						scrim behind it dismisses the drawer on tap. */}
					{isNarrow && !app.sidebarCollapsed ? (
						<div
							className="app-layout-scrim"
							aria-hidden="true"
							onClick={() => appStore.setSidebarCollapsed(true)}
						/>
					) : null}
				</div>
			</InnoDndProvider>
			{workspaceNarrowHint ? (
				<div
					role="status"
					className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full border border-[var(--inno-border)] bg-[var(--inno-surface)] px-4 py-2 text-xs text-[var(--inno-text-muted)] shadow-[var(--inno-shadow-soft)]"
				>
					{t("workspace.windowTooNarrow")}
				</div>
			) : null}
			{app.settingsOpen ? <Suspense fallback={null}><SettingsOverlay /></Suspense> : null}
			{searchOpen ? <SearchPanel onClose={() => setSearchOpen(false)} onNavigate={navigateFromSearch} /> : null}
		</>
	);
}

function SearchWindow() {
	const close = useCallback(() => window.innoDesktop?.closeSearchWindow(), []);
	const navigate = useCallback((result: SearchResult) => window.innoDesktop?.openSearchResult(result), []);
	const macTitlebarInset = new URL(window.location.href).searchParams.get("macTitlebar") === "1";
	return <SearchPanel standalone macTitlebarInset={macTitlebarInset} onClose={close} onNavigate={navigate} />;
}

export function App() {
	const isSearchWindow = Boolean(window.innoDesktop) && new URL(window.location.href).searchParams.get("window") === "search";
	return isSearchWindow ? <SearchWindow /> : <MainApp />;
}
