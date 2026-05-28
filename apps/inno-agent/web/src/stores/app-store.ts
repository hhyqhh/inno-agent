import { EventEmitter } from "./event-emitter.js";

export type RightPanelTab = "notebook" | "preview" | "profile" | "skills" | "jobs" | "settings";
export type SidebarSection = "chat" | "wiki" | "jobs" | "settings";
export type WorkspaceMode = "collapsed" | "half" | "full";

interface AppStoreEvents {
	change: void;
}

const VALID_TABS: RightPanelTab[] = ["notebook", "preview", "profile", "skills", "jobs", "settings"];
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

	setRightPanelTab(tab: RightPanelTab) {
		this.rightPanelTab = tab;
		this.emit("change", undefined);
	}

	setSidebarSection(section: SidebarSection) {
		this.sidebarSection = section;
		this.emit("change", undefined);
	}

	toggleSidebar() {
		this.sidebarCollapsed = !this.sidebarCollapsed;
		this.emit("change", undefined);
	}

	setSidebarCollapsed(collapsed: boolean) {
		this.sidebarCollapsed = collapsed;
		this.emit("change", undefined);
	}

	setWorkspaceMode(mode: WorkspaceMode) {
		this.workspaceMode = mode;
		this.emit("change", undefined);
	}

	setWorkspaceWidth(width: number) {
		this.workspaceWidth = Math.max(320, Math.min(920, Math.round(width)));
		if (typeof window !== "undefined") {
			window.localStorage.setItem("inno.workspaceWidth", String(this.workspaceWidth));
		}
		this.emit("change", undefined);
	}

	toggleWorkspace() {
		this.workspaceMode = this.workspaceMode === "collapsed" ? "half" : "collapsed";
		this.emit("change", undefined);
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

export const appStore = new AppStoreImpl();
