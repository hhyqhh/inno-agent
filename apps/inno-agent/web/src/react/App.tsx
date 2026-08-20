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
import {
	CHAT_BASELINE_WIDTH,
	SIDEBAR_WIDTH,
	getEffectiveWorkspaceWidth,
	fitPanelLayout,
} from "../stores/app-layout.js";

/** Below this width the chat takes the whole window. */
const CHAT_ONLY_BP = 960;
type WindowExpansionSide = "left" | "right";
type PanelSpaceResult = "ready" | "busy" | "unavailable";

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

	// A window can be resized after a panel was opened. Keep that action from
	// leaving the chat squeezed beside a stale, oversized workspace preview.
	useEffect(() => {
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
	}, []);

	const setTab = useCallback((tab: RightPanelTab) => appStore.setRightPanelTab(tab), []);
	const ensureWindowForPanel = useCallback(async (
		side: WindowExpansionSide,
		requestedWorkspaceWidth?: number,
		requestedWorkspaceMode?: WorkspaceMode,
	): Promise<PanelSpaceResult> => {
		// Read the store at call time. Opening both panels is sequential, so the
		// second expansion must see the sidebar state changed by the first one.
		const currentSidebarCollapsed = appStore.sidebarCollapsed;
		const currentWorkspaceMode = appStore.workspaceMode;
		const workspaceWidth = requestedWorkspaceWidth ?? appStore.workspaceWidth;
		const workspaceMode = requestedWorkspaceMode ?? currentWorkspaceMode;
		const leftWidth = currentSidebarCollapsed && side !== "left" ? 0 : SIDEBAR_WIDTH;
		const rightWidth = currentWorkspaceMode === "collapsed" && side !== "right"
			? 0
			: getEffectiveWorkspaceWidth(workspaceWidth, workspaceMode === "collapsed" ? "half" : workspaceMode);
		const requiredWidth = CHAT_BASELINE_WIDTH + leftWidth + rightWidth;
		const additionalWidth = Math.max(0, requiredWidth - window.innerWidth);
		if (additionalWidth === 0) return "ready";

		const expandWindowWidth = window.innoDesktop?.expandWindowWidth;
		if (!expandWindowWidth) return "unavailable";
		if (pendingExpansion.current) return "busy";
		pendingExpansion.current = side;
		try {
			const expanded = await expandWindowWidth(side, additionalWidth);
			if (!expanded) return "unavailable";
			return (await waitForViewportWidth(requiredWidth)) ? "ready" : "unavailable";
		} finally {
			pendingExpansion.current = null;
		}
	}, []);

	const openPresetPanels = useCallback(async () => {
		const previewWidth = 560;
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

	const setWorkspaceMode = useCallback((mode: WorkspaceMode) => {
		if (mode === "collapsed" || app.workspaceMode !== "collapsed") {
			appStore.setWorkspaceMode(mode);
			return;
		}
		void (async () => {
			const result = await ensureWindowForPanel("right");
			if (result === "busy") return;
			// Do not force the sidebar closed here: setWorkspaceMode below already
			// collapses it if (and only if) that is what makes the panel fit, and
			// otherwise leaves the layout untouched instead of collapsing for nothing.
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
				<ChatCenter onOpenPresetPanels={openPresetPanels} />
				<WorkspacePanel
					activeTab={app.rightPanelTab}
					mode={app.workspaceMode}
					width={app.workspaceWidth}
					onTabChange={setTab}
					onModeChange={setWorkspaceMode}
					onWidthChange={setWorkspaceWidth}
					onPreviewFile={openFilePreview}
				/>
			</div>
			<SettingsOverlay />
		</>
	);
}
