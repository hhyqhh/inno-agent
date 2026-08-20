import { EventEmitter } from "./event-emitter.js";
import { fitPanelLayout } from "./app-layout.js";

export type RightPanelTab = "notebook" | "preview" | "profile" | "skills" | "jobs";
export type SidebarSection = "chat" | "wiki" | "jobs" | "settings";
export type WorkspaceMode = "collapsed" | "quarter" | "half" | "full";
export type SettingsTab = "general" | "models" | "memory" | "integrations" | "channels" | "mcp" | "about";

interface AppStoreEvents {
	change: void;
}

const VALID_TABS: RightPanelTab[] = ["notebook", "preview", "profile", "skills", "jobs"];
// Legacy values mapped to current ones.
const TAB_ALIASES: Record<string, RightPanelTab> = {
	wiki: "notebook",
	graph: "notebook",
};

class AppStoreImpl extends EventEmitter<AppStoreEvents> {
	rightPanelTab: RightPanelTab = getInitialRightPanelTab();
	sidebarSection: SidebarSection = "chat";
	sidebarCollapsed = false;
	workspaceMode: WorkspaceMode = "collapsed";
	workspaceWidth = getInitialWorkspaceWidth();
	settingsOpen = getInitialSettingsOpen();
	activeSettingsTab: SettingsTab = "general";

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

	setSidebarSection(section: SidebarSection) {
		this.sidebarSection = section;
		this.emit("change", undefined);
	}

	toggleSidebar() {
		this.setSidebarCollapsed(!this.sidebarCollapsed);
	}

	setSidebarCollapsed(collapsed: boolean) {
		let nextWorkspaceMode = this.workspaceMode;
		let nextWorkspaceWidth = this.workspaceWidth;
		if (!collapsed) {
			// Full mode intentionally overlays the chat, so opening the sidebar
			// first returns to a normal two-column layout.
			if (nextWorkspaceMode === "full") {
				nextWorkspaceMode = "collapsed";
			} else if (typeof window !== "undefined") {
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
	if (typeof window === "undefined") return 520;
	const saved = Number(window.localStorage.getItem("inno.workspaceWidth"));
	return Number.isFinite(saved) && saved > 0 ? Math.max(320, Math.min(920, Math.round(saved))) : 520;
}

function getInitialRightPanelTab(): RightPanelTab {
	if (typeof window === "undefined") return "preview";
	const tab = new URLSearchParams(window.location.search).get("tab");
	if (tab && TAB_ALIASES[tab]) return TAB_ALIASES[tab];
	if (tab && (VALID_TABS as string[]).includes(tab)) return tab as RightPanelTab;
	return "preview";
}

function getInitialSettingsOpen(): boolean {
	if (typeof window === "undefined") return false;
	return new URLSearchParams(window.location.search).get("tab") === "settings";
}

export const appStore = new AppStoreImpl();
