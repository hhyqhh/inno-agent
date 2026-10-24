import type { WorkspaceMode } from "./app-store.js";

/** The chat should remain usable while optional panels are visible. */
export const CHAT_BASELINE_WIDTH = 800;
export const SIDEBAR_WIDTH = 264;
export const DESKTOP_SIDEBAR_RAIL_WIDTH = 52;
export const DESKTOP_SIDEBAR_CONTENT_WIDTH = 246;
export const DESKTOP_SIDEBAR_MIN_WIDTH = 220;
export const DESKTOP_SIDEBAR_MAX_WIDTH = 480;
export const DESKTOP_SIDEBAR_WIDTH = DESKTOP_SIDEBAR_RAIL_WIDTH + DESKTOP_SIDEBAR_CONTENT_WIDTH;
export const WORKSPACE_QUARTER_MIN_WIDTH = 240;
export const WORKSPACE_MIN_WIDTH = 320;
// Keep the split view close to the reference proportions: a 260px file tree
// plus a useful preview column without taking over the conversation.
export const WORKSPACE_DEFAULT_WIDTH = 520;
export const WORKSPACE_MAX_WIDTH = 920;

/** At and below this viewport width the chat is the only column; other panels become overlays. */
export const CHAT_ONLY_BP = 960;

/** The desktop Chat panel may only stay pinned when it fits beside the chat. */
export const DESKTOP_SIDEBAR_EXPANDED_MIN_WIDTH = CHAT_BASELINE_WIDTH + DESKTOP_SIDEBAR_WIDTH;

export function getEffectiveSidebarWidth(width: number): number {
	return Number.isFinite(width)
		? Math.max(DESKTOP_SIDEBAR_MIN_WIDTH, Math.min(DESKTOP_SIDEBAR_MAX_WIDTH, Math.round(width)))
		: DESKTOP_SIDEBAR_CONTENT_WIDTH;
}

/** Preview floats over the content; a pinned sidebar must leave room for chat and workspace. */
export function getMaximumSidebarWidth(viewportWidth: number, workspaceWidth = 0, isPreview = false): number {
	return getEffectiveSidebarWidth(viewportWidth - DESKTOP_SIDEBAR_RAIL_WIDTH - (isPreview ? 8 : CHAT_BASELINE_WIDTH + workspaceWidth));
}

export function getSidebarLayoutWidth(sidebarCollapsed: boolean, isDesktopWindow = false, sidebarWidth = DESKTOP_SIDEBAR_CONTENT_WIDTH): number {
	if (isDesktopWindow) {
		return DESKTOP_SIDEBAR_RAIL_WIDTH + (sidebarCollapsed ? 0 : getEffectiveSidebarWidth(sidebarWidth));
	}
	return sidebarCollapsed ? 0 : SIDEBAR_WIDTH;
}

export function getEffectiveWorkspaceWidth(width: number, mode: WorkspaceMode = "half"): number {
	const minWidth = mode === "quarter" ? WORKSPACE_QUARTER_MIN_WIDTH : WORKSPACE_MIN_WIDTH;
	return Math.max(minWidth, Math.min(WORKSPACE_MAX_WIDTH, Math.round(width)));
}

/**
 * Maximum workspace width that can fit in the current non-overlay layout
 * without squeezing the chat below its baseline width.
 */
export function getMaximumWorkspaceWidth(
	viewportWidth: number,
	sidebarCollapsed: boolean,
	mode: WorkspaceMode,
	isDesktopWindow = false,
	sidebarWidth = DESKTOP_SIDEBAR_CONTENT_WIDTH,
): number {
	const minWidth = mode === "quarter" ? WORKSPACE_QUARTER_MIN_WIDTH : WORKSPACE_MIN_WIDTH;
	const availableWidth = viewportWidth - CHAT_BASELINE_WIDTH - getSidebarLayoutWidth(sidebarCollapsed, isDesktopWindow, sidebarWidth);
	return Math.max(minWidth, Math.min(WORKSPACE_MAX_WIDTH, Math.round(availableWidth)));
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
	isDesktopWindow = false,
	sidebarWidth = DESKTOP_SIDEBAR_CONTENT_WIDTH,
): FittedPanelLayout | null {
	if (workspaceMode === "collapsed" || workspaceMode === "full") {
		return { sidebarCollapsed, workspaceMode, workspaceWidth };
	}

	let nextSidebarCollapsed = sidebarCollapsed;
	let availableWorkspaceWidth = viewportWidth
		- CHAT_BASELINE_WIDTH
		- getSidebarLayoutWidth(nextSidebarCollapsed, isDesktopWindow, sidebarWidth);

	// If the requested workspace would squeeze the chat, hide the optional
	// left column first. This is used by direct workspace-opening call sites
	// that do not go through the Electron window-expansion path.
	if (availableWorkspaceWidth < WORKSPACE_QUARTER_MIN_WIDTH && !nextSidebarCollapsed) {
		nextSidebarCollapsed = true;
		availableWorkspaceWidth = viewportWidth
			- CHAT_BASELINE_WIDTH
			- getSidebarLayoutWidth(true, isDesktopWindow, sidebarWidth);
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
export function canOpenWorkspaceBesideSidebar(viewportWidth: number, workspaceWidth: number, isDesktopWindow = false, sidebarWidth = DESKTOP_SIDEBAR_CONTENT_WIDTH): boolean {
	const fitted = fitPanelLayout(viewportWidth, false, "quarter", workspaceWidth, isDesktopWindow, sidebarWidth);
	return fitted?.sidebarCollapsed === false;
}

/**
 * Map a requested workspace mode to one that works at the current viewport.
 * At narrow widths there is no room for a side-by-side panel, so half/quarter
 * requests become the full-width overlay instead of being refused.
 */
export function resolveWorkspaceModeForViewport(mode: WorkspaceMode, viewportWidth: number): WorkspaceMode {
	if (viewportWidth > CHAT_ONLY_BP) return mode;
	if (mode === "half" || mode === "quarter") return "full";
	return mode;
}
