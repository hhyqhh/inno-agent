import { useCallback, useEffect, useRef } from "react";
import { appStore, type RightPanelTab, type WorkspaceMode } from "../stores/app-store.js";
import { settingsStore } from "../stores/settings-store.js";
import { themeStore, type ThemeId } from "../stores/theme-store.js";
import { sessionsStore } from "../stores/sessions-store.js";
import { workspacesStore } from "../stores/workspaces-store.js";
import { useStoreSnapshot } from "./hooks.js";
import { ChatCenter } from "./ChatCenter.js";
import { SessionSidebar } from "./SessionSidebar.js";
import { WorkspacePanel } from "./WorkspacePanel.js";
import { SettingsOverlay } from "./settings/SettingsOverlay.js";

/** Below this width the chat takes the whole window. */
const CHAT_ONLY_BP = 960;
/** The Electron window's minimum usable width: the chat-only baseline. */
const CHAT_BASELINE_WIDTH = 800;
const SIDEBAR_WIDTH = 264;
const WORKSPACE_MIN_WIDTH = 320;
const WORKSPACE_MAX_WIDTH = 920;

type WindowExpansionSide = "left" | "right";

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

function getEffectiveWorkspaceWidth(width: number): number {
	return Math.max(WORKSPACE_MIN_WIDTH, Math.min(WORKSPACE_MAX_WIDTH, Math.round(width)));
}

function waitForViewportWidth(minWidth: number): Promise<boolean> {
	if (window.innerWidth >= minWidth) return Promise.resolve(true);

	return new Promise((resolve) => {
		const startedAt = performance.now();
		const check = () => {
			if (window.innerWidth >= minWidth) {
				resolve(true);
				return;
			}
			if (performance.now() - startedAt >= 600) {
				resolve(false);
				return;
			}
			window.requestAnimationFrame(check);
		};
		check();
	});
}

export function App() {
	const app = useStoreSnapshot(appStore, () => ({
		rightPanelTab: appStore.rightPanelTab,
		sidebarCollapsed: appStore.sidebarCollapsed,
		workspaceMode: appStore.workspaceMode,
		workspaceWidth: appStore.workspaceWidth,
	}));
	const pendingExpansion = useRef<WindowExpansionSide | null>(null);

	useEffect(() => {
		void initializeApp();
		const onPopState = () => {
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

	const setTab = useCallback((tab: RightPanelTab) => appStore.setRightPanelTab(tab), []);
	const ensureWindowForPanel = useCallback(async (side: WindowExpansionSide): Promise<boolean> => {
		const leftWidth = app.sidebarCollapsed && side !== "left" ? 0 : SIDEBAR_WIDTH;
		const rightWidth = app.workspaceMode === "collapsed" && side !== "right"
			? 0
			: getEffectiveWorkspaceWidth(app.workspaceWidth);
		const requiredWidth = CHAT_BASELINE_WIDTH + leftWidth + rightWidth;
		const additionalWidth = Math.max(0, requiredWidth - window.innerWidth);
		if (additionalWidth === 0) return true;

		const expandWindowWidth = window.innoDesktop?.expandWindowWidth;
		if (!expandWindowWidth) return true;
		if (pendingExpansion.current) return false;
		pendingExpansion.current = side;
		try {
			const expanded = await expandWindowWidth(side, additionalWidth);
			if (!expanded) return false;
			return waitForViewportWidth(requiredWidth);
		} finally {
			pendingExpansion.current = null;
		}
	}, [app.sidebarCollapsed, app.workspaceMode, app.workspaceWidth]);

	const openSidebar = useCallback(() => {
		void (async () => {
			if (!(await ensureWindowForPanel("left"))) return;
			appStore.setSidebarCollapsed(false);
		})();
	}, [ensureWindowForPanel]);

	const setWorkspaceMode = useCallback((mode: WorkspaceMode) => {
		if (mode === "collapsed" || app.workspaceMode !== "collapsed") {
			appStore.setWorkspaceMode(mode);
			return;
		}
		void (async () => {
			if (!(await ensureWindowForPanel("right"))) return;
			appStore.setWorkspaceMode(mode);
		})();
	}, [app.workspaceMode, ensureWindowForPanel]);
	const setWorkspaceWidth = useCallback((width: number) => appStore.setWorkspaceWidth(width), []);

	return (
		<>
			<div
				className={`app-layout app-layout--sidebar-${app.sidebarCollapsed ? "collapsed" : "expanded"} app-layout--workspace-${app.workspaceMode}`}
				style={{ "--inno-workspace-width": `${app.workspaceWidth}px` } as React.CSSProperties}
			>
				<SessionSidebar collapsed={app.sidebarCollapsed} onOpen={openSidebar} />
				<ChatCenter />
				<WorkspacePanel
					activeTab={app.rightPanelTab}
					mode={app.workspaceMode}
					width={app.workspaceWidth}
					onTabChange={setTab}
					onModeChange={setWorkspaceMode}
					onWidthChange={setWorkspaceWidth}
				/>
			</div>
			<SettingsOverlay />
		</>
	);
}
