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

/** Breakpoint below which sidebars auto-collapse */
const SIDEBAR_COLLAPSE_BP = 960;
const WORKSPACE_COLLAPSE_BP = 820;

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
	const app = useStoreSnapshot(appStore, () => ({
		rightPanelTab: appStore.rightPanelTab,
		sidebarCollapsed: appStore.sidebarCollapsed,
		workspaceMode: appStore.workspaceMode,
		workspaceWidth: appStore.workspaceWidth,
	}));

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

	// Track whether user manually toggled the sidebar so we don't fight them
	const userExpandedSidebar = useRef(false);
	const userExpandedWorkspace = useRef(false);

	// Auto-collapse left sidebar when viewport narrows
	useEffect(() => {
		const mql = window.matchMedia(`(max-width: ${SIDEBAR_COLLAPSE_BP}px)`);
		const handler = (e: MediaQueryListEvent | MediaQueryList) => {
			if (e.matches) {
				// Narrow: collapse if expanded
				if (!appStore.sidebarCollapsed) {
					userExpandedSidebar.current = false;
					appStore.setSidebarCollapsed(true);
				}
			} else {
				// Wide: restore if not manually collapsed
				if (appStore.sidebarCollapsed && !userExpandedSidebar.current) {
					appStore.setSidebarCollapsed(false);
				}
			}
		};
		handler(mql);
		mql.addEventListener("change", handler);
		return () => mql.removeEventListener("change", handler);
	}, []);

	// Auto-collapse right workspace panel when viewport narrows
	useEffect(() => {
		const mql = window.matchMedia(`(max-width: ${WORKSPACE_COLLAPSE_BP}px)`);
		const handler = (e: MediaQueryListEvent | MediaQueryList) => {
			if (e.matches) {
				if (appStore.workspaceMode === "half") {
					userExpandedWorkspace.current = false;
					appStore.setWorkspaceMode("collapsed");
				}
			} else {
				if (appStore.workspaceMode === "collapsed" && !userExpandedWorkspace.current) {
					// Don't auto-expand workspace — it starts collapsed by default
				}
			}
		};
		handler(mql);
		mql.addEventListener("change", handler);
		return () => mql.removeEventListener("change", handler);
	}, []);

	const setTab = useCallback((tab: RightPanelTab) => appStore.setRightPanelTab(tab), []);
	const setWorkspaceMode = useCallback((mode: WorkspaceMode) => {
		userExpandedWorkspace.current = mode !== "collapsed";
		appStore.setWorkspaceMode(mode);
	}, []);
	const setWorkspaceWidth = useCallback((width: number) => appStore.setWorkspaceWidth(width), []);

	return (
		<div
			className={`app-layout app-layout--sidebar-${app.sidebarCollapsed ? "collapsed" : "expanded"} app-layout--workspace-${app.workspaceMode}`}
			style={{ "--inno-workspace-width": `${app.workspaceWidth}px` } as React.CSSProperties}
		>
			<SessionSidebar collapsed={app.sidebarCollapsed} />
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
	);
}
