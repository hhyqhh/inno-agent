import { useCallback, useEffect } from "react";
import { DndProvider } from "react-dnd";
import { HTML5Backend } from "react-dnd-html5-backend";
import { MessageCircleQuestion } from "lucide-react";
import { appStore, pageFromSearch, type AppPage, type WorkspaceMode } from "../stores/app-store.js";
import { settingsStore } from "../stores/settings-store.js";
import { themeStore, type ThemeId } from "../stores/theme-store.js";
import { sessionsStore } from "../stores/sessions-store.js";
import { btwStore } from "../stores/btw-store.js";
import { workspacesStore } from "../stores/workspaces-store.js";
import { useStoreSnapshot } from "./hooks.js";
import { ChatCenter } from "./ChatCenter.js";
import { FeaturePage } from "./FeaturePage.js";
import { SessionSidebar } from "./SessionSidebar.js";
import { WorkspacePanel } from "./WorkspacePanel.js";
import { DesktopWindowChrome } from "./DesktopWindowChrome.js";
import { SettingsOverlay } from "./settings/SettingsOverlay.js";
import {
	fitPanelLayout,
	WORKSPACE_DEFAULT_WIDTH,
} from "../stores/app-layout.js";
import { ensureWindowForPanel } from "../stores/window-expansion.js";

/** Below this width the chat takes the whole window. */
const CHAT_ONLY_BP = 960;

let initializationPromise: Promise<void> | null = null;

function initializeApp(): Promise<void> {
	if (initializationPromise) return initializationPromise;
	initializationPromise = (async () => {
		await Promise.all([sessionsStore.load(), workspacesStore.load()]);
		const requestedSession = new URL(window.location.href).searchParams.get("session");
		if (requestedSession) await sessionsStore.openSession(requestedSession, { historyMode: "none" });
	})();
	return initializationPromise;
}

export function App() {
	const isDesktopWindow = Boolean(window.innoDesktop);
	const app = useStoreSnapshot(appStore, () => ({
		page: appStore.page,
		sidebarCollapsed: appStore.sidebarCollapsed,
		workspaceMode: appStore.workspaceMode,
		workspaceWidth: appStore.workspaceWidth,
	}));
	const currentSessionId = useStoreSnapshot(sessionsStore, () => sessionsStore.currentSessionId);
	const btwPanelVisible = useStoreSnapshot(btwStore, () => btwStore.isVisible && btwStore.activeSessionId === sessionsStore.currentSessionId);
	const desktopBtwControl = isDesktopWindow && app.workspaceMode === "collapsed" && currentSessionId ? (
		<button
			type="button"
			className={`inno-window-chrome-button inno-window-chrome-btw-button ${btwPanelVisible ? "is-active" : ""}`}
			title="随便问问"
			aria-label="随便问问"
			aria-expanded={btwPanelVisible}
			onClick={() => void btwStore.openOrRestore(currentSessionId)}
		>
			<MessageCircleQuestion size={15} />
		</button>
	) : undefined;
	useEffect(() => {
		void initializeApp();
		const onPopState = () => {
			// Restore the main-area page from the URL (back/forward navigation).
			appStore.setPage(pageFromSearch(window.location.search), "none");
			const sessionId = new URL(window.location.href).searchParams.get("session");
			if (!sessionId) sessionsStore.showWelcomeFromHistory();
			else if (sessionId !== sessionsStore.currentSessionId) void sessionsStore.openSession(sessionId, { historyMode: "none" });
		};
		window.addEventListener("popstate", onPopState);
		return () => window.removeEventListener("popstate", onPopState);
	}, []);

	// Load settings once at boot so Simple Mode (tab hiding, preset cards) is
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

	// At narrow widths the chat is the primary surface: remove both optional
	// columns together so they cannot squeeze the conversation into a sliver.
	// We intentionally do not restore either column when the window widens again;
	// reopening a panel is an explicit user action.
	useEffect(() => {
		const mql = window.matchMedia(`(max-width: ${CHAT_ONLY_BP}px)`);
		const enforceChatOnly = (e: MediaQueryListEvent | MediaQueryList) => {
			if (!e.matches) return;
			if (!appStore.sidebarCollapsed) appStore.setSidebarCollapsed(true);
			if (appStore.workspaceMode !== "collapsed") appStore.setWorkspaceMode("collapsed");
		};
		enforceChatOnly(mql);
		mql.addEventListener("change", enforceChatOnly);
		return () => mql.removeEventListener("change", enforceChatOnly);
	}, [app.sidebarCollapsed, app.workspaceMode]);

	// A window can be resized after a panel was opened. Keep that action from
	// leaving the chat squeezed beside a stale, oversized workspace preview.
	// Feature pages don't render the right panel — leave its layout state alone.
	useEffect(() => {
		if (app.page !== "chat") return;
		const fitCurrentLayout = () => {
			const currentMode = appStore.workspaceMode;
			if (currentMode === "collapsed" || currentMode === "full") return;
			const fitted = fitPanelLayout(
				window.innerWidth,
				appStore.sidebarCollapsed,
				currentMode,
				appStore.workspaceWidth,
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
	}, [app.page]);

	const openPresetPanels = useCallback(async () => {
		const previewWidth = WORKSPACE_DEFAULT_WIDTH;
		if (appStore.workspaceMode === "full") {
			// Full mode overlays the chat; start from the normal split state before
			// making room for both optional columns.
			appStore.setWorkspaceMode("collapsed");
		}

		if (appStore.sidebarCollapsed) {
			const leftResult = await ensureWindowForPanel("left");
			if (leftResult === "busy") return;
			appStore.setSidebarCollapsed(false);
		}

		const rightResult = await ensureWindowForPanel("right", previewWidth, "half");
		if (rightResult === "busy") return;
		// Do not force the sidebar closed here: setWorkspaceMode below already
		// collapses it if (and only if) that is what makes the panel fit.
		appStore.setRightPanelTab("preview");
		appStore.setWorkspaceWidth(previewWidth);
		appStore.setWorkspaceMode("half");
	}, [ensureWindowForPanel]);

	const openFilePreview = useCallback(async (minimumWidth: number) => {
		// Full mode is already the reading surface; selecting another file should
		// not unexpectedly return the user to a split layout.
		if (appStore.workspaceMode === "full") return;
		const previewWidth = appStore.workspaceMode === "collapsed"
			? minimumWidth
			: Math.max(minimumWidth, appStore.workspaceWidth);
		const result = await ensureWindowForPanel("right", previewWidth, "half");
		if (result === "busy") return;
		// Do not force the sidebar closed here: setWorkspaceWidth/setWorkspaceMode
		// below already collapse it if (and only if) that is what makes the panel fit.
		appStore.setWorkspaceWidth(previewWidth);
		appStore.setWorkspaceMode("half");
	}, [ensureWindowForPanel]);

	const openSidebar = useCallback(() => {
		void (async () => {
			const result = await ensureWindowForPanel("left");
			if (result === "busy") return;
			// If the display cannot fit both optional columns, the store fits the
			// workspace or closes it so the clicked panel still responds.
			appStore.setSidebarCollapsed(false);
		})();
	}, [ensureWindowForPanel]);
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
		})();
	}, [app.workspaceMode, ensureWindowForPanel]);
	const toggleWorkspace = useCallback(() => {
		setWorkspaceMode(app.workspaceMode === "collapsed" ? "half" : "collapsed");
	}, [app.workspaceMode, setWorkspaceMode]);
	const setWorkspaceWidth = useCallback((width: number) => appStore.setWorkspaceWidth(width), []);

	// Feature pages occupy the whole center column; the right workspace panel is
	// a chat-only surface. Its mode/width state is preserved (not mutated) so
	// returning to chat restores the exact previous layout.
	const chatVisible = app.page === "chat";
	const layoutWorkspaceMode = chatVisible ? app.workspaceMode : "collapsed";

	return (
		<>
			<DndProvider backend={HTML5Backend}>
				<div
					className={`app-layout app-layout--${isDesktopWindow ? "desktop" : "browser"} app-layout--sidebar-${app.sidebarCollapsed ? "collapsed" : "expanded"} app-layout--workspace-${layoutWorkspaceMode}`}
					style={{ "--inno-workspace-width": `${app.workspaceWidth}px` } as React.CSSProperties}
				>
					<SessionSidebar collapsed={app.sidebarCollapsed} />
					{chatVisible ? (
						<ChatCenter onOpenPresetPanels={openPresetPanels} onPreviewFile={openFilePreview} />
					) : (
						<FeaturePage page={app.page as Exclude<AppPage, "chat">} />
					)}
					{chatVisible ? (
						<WorkspacePanel
							mode={app.workspaceMode}
							width={app.workspaceWidth}
							onModeChange={setWorkspaceMode}
							onWidthChange={setWorkspaceWidth}
							onPreviewFile={openFilePreview}
						/>
					) : null}
					<DesktopWindowChrome
						showSidebarControl
						showWorkspaceControl={chatVisible}
						sidebarCollapsed={app.sidebarCollapsed}
						workspaceCollapsed={app.workspaceMode === "collapsed"}
						btwControl={desktopBtwControl}
						onToggleSidebar={toggleSidebar}
						onToggleWorkspace={toggleWorkspace}
					/>
				</div>
			</DndProvider>
			<SettingsOverlay />
		</>
	);
}
