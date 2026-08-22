import type { WorkspaceMode } from "./app-store.js";

/** The chat should remain usable while optional panels are visible. */
export const CHAT_BASELINE_WIDTH = 800;
export const SIDEBAR_WIDTH = 264;
export const WORKSPACE_QUARTER_MIN_WIDTH = 240;
export const WORKSPACE_MIN_WIDTH = 320;
export const WORKSPACE_MAX_WIDTH = 920;

export function getEffectiveWorkspaceWidth(width: number, mode: WorkspaceMode = "half"): number {
	const minWidth = mode === "quarter" ? WORKSPACE_QUARTER_MIN_WIDTH : WORKSPACE_MIN_WIDTH;
	return Math.max(minWidth, Math.min(WORKSPACE_MAX_WIDTH, Math.round(width)));
}

export interface FittedPanelLayout {
	sidebarCollapsed: boolean;
	workspaceMode: WorkspaceMode;
	workspaceWidth: number;
}

/**
 * Fit a requested non-overlay layout into the current viewport.
 *
 * The left sidebar is optional when opening the workspace, and the workspace
 * can fall back from half to quarter mode when the viewport can only support
 * a narrower preview. Returning null means even the smallest useful layout
 * cannot coexist with the chat, so the requested workspace should stay closed.
 */
export function fitPanelLayout(
	viewportWidth: number,
	sidebarCollapsed: boolean,
	workspaceMode: WorkspaceMode,
	workspaceWidth: number,
): FittedPanelLayout | null {
	if (workspaceMode === "collapsed" || workspaceMode === "full") {
		return { sidebarCollapsed, workspaceMode, workspaceWidth };
	}

	let nextSidebarCollapsed = sidebarCollapsed;
	let availableWorkspaceWidth = viewportWidth
		- CHAT_BASELINE_WIDTH
		- (nextSidebarCollapsed ? 0 : SIDEBAR_WIDTH);

	// If the requested workspace would squeeze the chat, hide the optional
	// left column first. This is used by direct workspace-opening call sites
	// that do not go through the Electron window-expansion path.
	if (availableWorkspaceWidth < WORKSPACE_QUARTER_MIN_WIDTH && !nextSidebarCollapsed) {
		nextSidebarCollapsed = true;
		availableWorkspaceWidth = viewportWidth - CHAT_BASELINE_WIDTH;
	}

	let nextWorkspaceMode = workspaceMode;
	if (nextWorkspaceMode === "half" && availableWorkspaceWidth < WORKSPACE_MIN_WIDTH) {
		if (availableWorkspaceWidth >= WORKSPACE_QUARTER_MIN_WIDTH) {
			nextWorkspaceMode = "quarter";
		} else {
			return null;
		}
	}
	const minWidth = nextWorkspaceMode === "quarter" ? WORKSPACE_QUARTER_MIN_WIDTH : WORKSPACE_MIN_WIDTH;
	if (availableWorkspaceWidth < minWidth) return null;

	return {
		sidebarCollapsed: nextSidebarCollapsed,
		workspaceMode: nextWorkspaceMode,
		workspaceWidth: Math.min(
			getEffectiveWorkspaceWidth(workspaceWidth, nextWorkspaceMode),
			availableWorkspaceWidth,
		),
	};
}

/** Whether a quarter-width workspace can open while keeping the sidebar visible. */
export function canOpenWorkspaceBesideSidebar(viewportWidth: number, workspaceWidth: number): boolean {
	const fitted = fitPanelLayout(viewportWidth, false, "quarter", workspaceWidth);
	return fitted?.sidebarCollapsed === false;
}
