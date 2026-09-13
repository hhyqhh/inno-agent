import { EventEmitter } from "./event-emitter.js";
import { fitPanelLayout, resolveWorkspaceModeForViewport, WORKSPACE_DEFAULT_WIDTH } from "./app-layout.js";

/**
 * The right panel only hosts the artifact/file browser now — notebook,
 * profile, skills and jobs graduated to full pages in the workbench nav.
 * The type remains so legacy call sites keep compiling until Phase 11.
 */
export type RightPanelTab = "preview";
/** Top-level main-area pages (new IA): chat plus the workbench feature pages. */
export type AppPage = "chat" | "notebook" | "skills" | "learner" | "jobs";
export type WorkspaceMode = "collapsed" | "quarter" | "half" | "full";
export type SettingsTab = "general" | "lab" | "models" | "memory" | "integrations" | "channels" | "mcp" | "about";

interface AppStoreEvents {
	change: void;
}

const VALID_PAGES: AppPage[] = ["chat", "notebook", "skills", "learner", "jobs"];

/**
 * Legacy `?tab=` deep links that now resolve to full pages instead of right
 * panel tabs (page-based IA). `preview` stays a panel tab, `settings` opens
 * the settings overlay — both handled separately.
 */
const TAB_TO_PAGE: Record<string, AppPage> = {
	notebook: "notebook",
	wiki: "notebook",
	graph: "notebook",
	skills: "skills",
	profile: "learner",
	jobs: "jobs",
};

/** Pure URL parsing for the initial page — exported for tests. */
export function pageFromSearch(search: string): AppPage {
	const params = new URLSearchParams(search);
	const page = params.get("page");
	if (page && (VALID_PAGES as string[]).includes(page)) return page as AppPage;
	const tab = params.get("tab");
	if (tab && TAB_TO_PAGE[tab]) return TAB_TO_PAGE[tab];
	return "chat";
}

class AppStoreImpl extends EventEmitter<AppStoreEvents> {
	page: AppPage = getInitialPage();
	rightPanelTab: RightPanelTab = "preview";
	sidebarCollapsed = false;
	workspaceMode: WorkspaceMode = "collapsed";
	workspaceWidth = getInitialWorkspaceWidth();
	settingsOpen = getInitialSettingsOpen();
	activeSettingsTab: SettingsTab = "general";

	/**
	 * Switch the main-area page. Feature pages own the whole center column, so
	 * the right workspace panel only makes sense on the chat page — its mode is
	 * left untouched here and simply not rendered while a feature page is
	 * active (App.tsx), so returning to chat restores the previous layout.
	 */
	setPage(page: AppPage, historyMode: "push" | "replace" | "none" = "push") {
		if (this.page === page && historyMode === "none") return;
		this.page = page;
		this.syncPageUrl(page, historyMode);
		this.emit("change", undefined);
	}

	private syncPageUrl(page: AppPage, mode: "push" | "replace" | "none") {
		if (mode === "none" || typeof window === "undefined") return;
		const nextUrl = new URL(window.location.href);
		if (page === "chat") nextUrl.searchParams.delete("page");
		else nextUrl.searchParams.set("page", page);
		// The ?tab= form is superseded by ?page= — drop it to keep URLs canonical.
		if (TAB_TO_PAGE[nextUrl.searchParams.get("tab") ?? ""]) nextUrl.searchParams.delete("tab");
		const current = new URL(window.location.href);
		if (nextUrl.href === current.href) return;
		if (mode === "push") window.history.pushState({}, "", nextUrl);
		else window.history.replaceState({}, "", nextUrl);
	}

	openSettings(tab: SettingsTab = "general") {
		this.settingsOpen = true;
		this.activeSettingsTab = tab;
		this.emit("change", undefined);
	}

	closeSettings() {
		if (!this.settingsOpen) return;
		this.settingsOpen = false;
		this.emit("change", undefined);
	}

	setSettingsTab(tab: SettingsTab) {
		if (this.activeSettingsTab === tab) return;
		this.activeSettingsTab = tab;
		this.emit("change", undefined);
	}

	setRightPanelTab(tab: RightPanelTab) {
		if (this.rightPanelTab === tab) return;
		this.rightPanelTab = tab;
		this.emit("change", undefined);
	}

	toggleSidebar() {
		this.setSidebarCollapsed(!this.sidebarCollapsed);
	}

	setSidebarCollapsed(collapsed: boolean) {
		let nextWorkspaceMode = this.workspaceMode;
		let nextWorkspaceWidth = this.workspaceWidth;
		if (!collapsed) {
			// Full mode occupies the chat surface but keeps the session sidebar as
			// the navigation anchor. Only a split layout needs a fit pass here.
			if (nextWorkspaceMode !== "full" && typeof window !== "undefined") {
				const fitted = fitPanelLayout(window.innerWidth, false, nextWorkspaceMode, this.workspaceWidth);
				if (fitted?.sidebarCollapsed === false) {
					nextWorkspaceMode = fitted.workspaceMode;
					nextWorkspaceWidth = fitted.workspaceWidth;
				} else if (nextWorkspaceMode !== "collapsed") {
					nextWorkspaceMode = "collapsed";
				}
			}
		}
		if (
			this.sidebarCollapsed === collapsed
			&& this.workspaceMode === nextWorkspaceMode
			&& this.workspaceWidth === nextWorkspaceWidth
		) return;
		this.sidebarCollapsed = collapsed;
		this.workspaceMode = nextWorkspaceMode;
		this.workspaceWidth = nextWorkspaceWidth;
		this.emit("change", undefined);
	}

	setWorkspaceMode(mode: WorkspaceMode) {
		let nextSidebarCollapsed = this.sidebarCollapsed;
		let nextWorkspaceMode = mode;
		let nextWorkspaceWidth = this.workspaceWidth;
		if (typeof window !== "undefined") {
			// Narrow viewports have no room for a side-by-side panel: every call
			// site gets the full-width overlay instead of a refused/squeezed split.
			nextWorkspaceMode = resolveWorkspaceModeForViewport(nextWorkspaceMode, window.innerWidth);
			const fitted = fitPanelLayout(window.innerWidth, nextSidebarCollapsed, nextWorkspaceMode, nextWorkspaceWidth);
			if (!fitted) return;
			nextSidebarCollapsed = fitted.sidebarCollapsed;
			nextWorkspaceMode = fitted.workspaceMode;
			nextWorkspaceWidth = fitted.workspaceWidth;
		}
		if (
			this.sidebarCollapsed === nextSidebarCollapsed
			&& this.workspaceMode === nextWorkspaceMode
			&& this.workspaceWidth === nextWorkspaceWidth
		) return;
		this.sidebarCollapsed = nextSidebarCollapsed;
		this.workspaceMode = nextWorkspaceMode;
		this.workspaceWidth = nextWorkspaceWidth;
		this.emit("change", undefined);
	}

	setWorkspaceWidth(width: number) {
		let nextWorkspaceWidth = Math.max(240, Math.min(920, Math.round(width)));
		let nextSidebarCollapsed = this.sidebarCollapsed;
		let nextWorkspaceMode = this.workspaceMode;
		if (typeof window !== "undefined") {
			const fitted = fitPanelLayout(window.innerWidth, nextSidebarCollapsed, nextWorkspaceMode, nextWorkspaceWidth);
			if (fitted) {
				nextSidebarCollapsed = fitted.sidebarCollapsed;
				nextWorkspaceMode = fitted.workspaceMode;
				nextWorkspaceWidth = fitted.workspaceWidth;
			} else if (nextWorkspaceMode !== "collapsed" && nextWorkspaceMode !== "full") {
				nextWorkspaceMode = "collapsed";
			}
		}
		if (
			this.workspaceWidth === nextWorkspaceWidth
			&& this.sidebarCollapsed === nextSidebarCollapsed
			&& this.workspaceMode === nextWorkspaceMode
		) return;
		this.sidebarCollapsed = nextSidebarCollapsed;
		this.workspaceMode = nextWorkspaceMode;
		this.workspaceWidth = nextWorkspaceWidth;
		if (typeof window !== "undefined") {
			window.localStorage.setItem("inno.workspaceWidth", String(this.workspaceWidth));
		}
		this.emit("change", undefined);
	}

	toggleWorkspace() {
		this.setWorkspaceMode(this.workspaceMode === "collapsed" ? "half" : "collapsed");
	}
}

function getInitialWorkspaceWidth(): number {
	if (typeof window === "undefined") return WORKSPACE_DEFAULT_WIDTH;
	const saved = Number(window.localStorage.getItem("inno.workspaceWidth"));
	return Number.isFinite(saved) && saved > 0 ? Math.max(320, Math.min(920, Math.round(saved))) : WORKSPACE_DEFAULT_WIDTH;
}

function getInitialPage(): AppPage {
	if (typeof window === "undefined") return "chat";
	return pageFromSearch(window.location.search);
}

function getInitialSettingsOpen(): boolean {
	if (typeof window === "undefined") return false;
	return new URLSearchParams(window.location.search).get("tab") === "settings";
}

export const appStore = new AppStoreImpl();
