import { describe, expect, it } from "vitest";
import { fitPanelLayout } from "./app-layout.js";

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
});
