import { appStore, type WorkspaceMode } from "./app-store.js";
import {
	CHAT_BASELINE_WIDTH,
	getEffectiveWorkspaceWidth,
	getSidebarLayoutWidth,
} from "./app-layout.js";

export type WindowExpansionSide = "left" | "right";
export type PanelSpaceResult = "ready" | "busy" | "unavailable";

let pendingExpansion: WindowExpansionSide | null = null;

function waitForViewportWidth(minWidth: number): Promise<boolean> {
	if (typeof window === "undefined" || window.innerWidth >= minWidth) return Promise.resolve(true);

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

async function expandRightPanelWindow(requiredWidth: number, additionalWidth: number, preserveRightEdge: boolean): Promise<boolean> {
	if (typeof window === "undefined") return false;
	const expandWindowWidth = window.innoDesktop?.expandWindowWidth;
	if (!expandWindowWidth) return false;

	const getWindowWidthCapacity = window.innoDesktop?.getWindowWidthCapacity;
	if (!getWindowWidthCapacity) {
		const expanded = await expandWindowWidth(preserveRightEdge ? "left" : "right", additionalWidth);
		return expanded && await waitForViewportWidth(requiredWidth);
	}

	const [rightCapacity, leftCapacity] = await Promise.all([
		getWindowWidthCapacity("right").catch(() => 0),
		getWindowWidthCapacity("left").catch(() => 0),
	]);
	let remainingWidth = additionalWidth;

	// Opening a panel can use either side. A splitter release must keep the
	// right edge fixed: growing right by the same amount as the panel cancelled
	// the splitter's leftward move and left the body at its old screen position.
	const expansions: ReadonlyArray<readonly [WindowExpansionSide, number]> = preserveRightEdge
		? [["left", leftCapacity]]
		: [["right", rightCapacity], ["left", leftCapacity]];
	for (const [expansionSide, capacity] of expansions) {
		if (remainingWidth <= 0) break;
		const expansionWidth = Math.min(remainingWidth, Math.max(0, Math.round(capacity)));
		if (expansionWidth <= 0) continue;

		const viewportBeforeExpansion = window.innerWidth;
		const expanded = await expandWindowWidth(expansionSide, expansionWidth);
		if (!expanded) continue;
		const viewportReady = await waitForViewportWidth(viewportBeforeExpansion + expansionWidth);
		if (!viewportReady) continue;
		remainingWidth -= expansionWidth;
	}

	return remainingWidth <= 0 && await waitForViewportWidth(requiredWidth);
}

/**
 * Make room for a non-overlay panel before changing the app layout.
 *
 * In a normal browser there is no native window to resize. The caller still
 * applies its requested layout when this returns "unavailable", allowing the
 * existing fitPanelLayout fallback to keep the chat usable.
 */
export async function ensureWindowForPanel(
	side: WindowExpansionSide,
	requestedWorkspaceWidth?: number,
	requestedWorkspaceMode?: WorkspaceMode,
	options: { preserveRightEdge?: boolean } = {},
): Promise<PanelSpaceResult> {
	const currentSidebarCollapsed = appStore.sidebarCollapsed;
	const currentWorkspaceMode = appStore.workspaceMode;
	const workspaceWidth = requestedWorkspaceWidth ?? appStore.workspaceWidth;
	const workspaceMode = requestedWorkspaceMode ?? currentWorkspaceMode;
	const leftWidth = getSidebarLayoutWidth(
		currentSidebarCollapsed && side !== "left",
		Boolean(typeof window !== "undefined" && window.innoDesktop),
		appStore.sidebarWidth,
	);
	const rightWidth = currentWorkspaceMode === "collapsed" && side !== "right"
		? 0
		: getEffectiveWorkspaceWidth(workspaceWidth, workspaceMode === "collapsed" ? "half" : workspaceMode);
	const requiredWidth = CHAT_BASELINE_WIDTH + leftWidth + rightWidth;
	const viewportWidth = typeof window === "undefined" ? requiredWidth : window.innerWidth;
	const additionalWidth = Math.max(0, requiredWidth - viewportWidth);
	if (additionalWidth === 0) return "ready";

	if (pendingExpansion) return "busy";

	pendingExpansion = side;
	try {
		const expanded = side === "right"
			? await expandRightPanelWindow(requiredWidth, additionalWidth, options.preserveRightEdge === true)
			: typeof window !== "undefined" && window.innoDesktop?.expandWindowWidth
				? await window.innoDesktop.expandWindowWidth(side, additionalWidth)
					&& await waitForViewportWidth(requiredWidth)
				: false;
		if (!expanded) return "unavailable";
		return "ready";
	} catch {
		// A browser build, a closed Electron window, or a failed IPC request
		// should fall back to the renderer's fitted layout instead of blocking
		// the panel from opening.
		return "unavailable";
	} finally {
		pendingExpansion = null;
	}
}
