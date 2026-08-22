import { describe, expect, it } from "vitest";
import {
	canOpenWorkspaceBesideSidebar,
	CHAT_BASELINE_WIDTH,
	fitPanelLayout,
	SIDEBAR_WIDTH,
	WORKSPACE_QUARTER_MIN_WIDTH,
} from "./app-layout.js";

describe("fitPanelLayout", () => {
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
