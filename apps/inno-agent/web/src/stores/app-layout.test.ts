import { describe, expect, it } from "vitest";
import {
	canOpenWorkspaceBesideSidebar,
	CHAT_BASELINE_WIDTH,
	CHAT_ONLY_BP,
	fitPanelLayout,
	getMaximumWorkspaceWidth,
	resolveWorkspaceModeForViewport,
	SIDEBAR_WIDTH,
	WORKSPACE_QUARTER_MIN_WIDTH,
} from "./app-layout.js";

describe("fitPanelLayout", () => {
	it("limits resize previews to the space the current layout can actually use", () => {
		expect(getMaximumWorkspaceWidth(1_140, true, "quarter")).toBe(340);
		expect(getMaximumWorkspaceWidth(1_700, false, "half")).toBe(636);
		expect(getMaximumWorkspaceWidth(2_800, true, "half")).toBe(920);
	});

	it("keeps the chat baseline when the workspace is resized too wide", () => {
		expect(fitPanelLayout(1_100, true, "half", 920)).toEqual({
			sidebarCollapsed: true,
			workspaceMode: "quarter",
			workspaceWidth: 300,
		});
	});

	it("fits both panels by reducing the workspace width", () => {
		expect(fitPanelLayout(1_700, false, "half", 920)).toEqual({
			sidebarCollapsed: false,
			workspaceMode: "half",
			workspaceWidth: 636,
		});
	});

	it("prioritizes the requested workspace over the sidebar when needed", () => {
		expect(fitPanelLayout(1_300, false, "half", 560)).toEqual({
			sidebarCollapsed: true,
			workspaceMode: "half",
			workspaceWidth: 500,
		});
	});

	it("returns no layout when even the smallest workspace would squeeze chat", () => {
		expect(fitPanelLayout(1_000, true, "half", 560)).toBeNull();
	});

	it("returns null without collapsing the sidebar when collapsing would not help either", () => {
		// At this width, even fully collapsing the sidebar leaves less room than
		// the smallest workspace needs, so the caller must not collapse it for nothing.
		expect(fitPanelLayout(1_000, false, "half", 560)).toBeNull();
	});

	it("collapses the sidebar on its own when that is what makes the panel fit", () => {
		expect(fitPanelLayout(1_080, false, "half", 560)).toEqual({
			sidebarCollapsed: true,
			workspaceMode: "quarter",
			workspaceWidth: 280,
		});
	});

	it("only opens a session preview when it can keep the sidebar visible", () => {
		expect(canOpenWorkspaceBesideSidebar(CHAT_BASELINE_WIDTH + SIDEBAR_WIDTH, 300)).toBe(false);
		expect(canOpenWorkspaceBesideSidebar(CHAT_BASELINE_WIDTH + SIDEBAR_WIDTH + WORKSPACE_QUARTER_MIN_WIDTH, 300)).toBe(true);
	});
});

describe("resolveWorkspaceModeForViewport", () => {
	it("maps side-by-side modes to the full overlay at and below the chat-only breakpoint", () => {
		expect(resolveWorkspaceModeForViewport("half", CHAT_ONLY_BP)).toBe("full");
		expect(resolveWorkspaceModeForViewport("quarter", CHAT_ONLY_BP)).toBe("full");
		expect(resolveWorkspaceModeForViewport("half", 375)).toBe("full");
		expect(resolveWorkspaceModeForViewport("quarter", 375)).toBe("full");
	});

	it("leaves overlay and collapsed modes untouched at narrow widths", () => {
		expect(resolveWorkspaceModeForViewport("full", 375)).toBe("full");
		expect(resolveWorkspaceModeForViewport("collapsed", 375)).toBe("collapsed");
	});

	it("returns every mode unchanged above the breakpoint", () => {
		expect(resolveWorkspaceModeForViewport("half", CHAT_ONLY_BP + 1)).toBe("half");
		expect(resolveWorkspaceModeForViewport("quarter", CHAT_ONLY_BP + 1)).toBe("quarter");
		expect(resolveWorkspaceModeForViewport("full", CHAT_ONLY_BP + 1)).toBe("full");
		expect(resolveWorkspaceModeForViewport("collapsed", CHAT_ONLY_BP + 1)).toBe("collapsed");
	});
});
