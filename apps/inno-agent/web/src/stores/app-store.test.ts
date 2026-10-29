import { describe, expect, it, vi } from "vitest";
import { appStore, pageFromSearch } from "./app-store.js";
import { fitPanelLayout } from "./app-layout.js";

describe("desktop window shrinking", () => {
	it.each([1, 7, 48])("never maximizes the preview during repeated %ipx native resize steps", (step) => {
		const previous = { mode: appStore.workspaceMode, width: appStore.workspaceWidth, collapsed: appStore.sidebarCollapsed };
		const viewport = { innerWidth: 1200, innoDesktop: {}, localStorage: { setItem: vi.fn() } };
		vi.stubGlobal("window", viewport);
		try {
			appStore.workspaceMode = "half";
			appStore.workspaceWidth = 520;
			appStore.sidebarCollapsed = true;
			// Follow App's resize fitting path, including the half -> quarter
			// mode update which previously re-entered the browser-only fallback.
			for (let width = 1200; width >= 612; width -= step) {
				viewport.innerWidth = width;
				const fitted = fitPanelLayout(width, appStore.sidebarCollapsed, appStore.workspaceMode, appStore.workspaceWidth, true);
				if (!fitted) appStore.setWorkspaceMode("collapsed");
				else {
					if (fitted.workspaceMode !== appStore.workspaceMode) appStore.setWorkspaceMode(fitted.workspaceMode);
					if (fitted.workspaceWidth !== appStore.workspaceWidth) appStore.setWorkspaceWidth(fitted.workspaceWidth);
				}
				expect(appStore.workspaceMode, `viewport ${width}`).not.toBe("full");
			}
			expect(appStore.workspaceMode).toBe("collapsed");
			appStore.setWorkspaceMode("full");
			expect(appStore.workspaceMode).toBe("full");
		} finally {
			appStore.workspaceMode = previous.mode;
			appStore.workspaceWidth = previous.width;
			appStore.sidebarCollapsed = previous.collapsed;
			vi.unstubAllGlobals();
		}
	});
});

describe("pageFromSearch", () => {
	it("defaults to chat when no params are present", () => {
		expect(pageFromSearch("")).toBe("chat");
		expect(pageFromSearch("?session=abc")).toBe("chat");
	});

	it("reads the ?page= param for valid pages", () => {
		expect(pageFromSearch("?page=notebook")).toBe("notebook");
		expect(pageFromSearch("?page=skills")).toBe("skills");
		expect(pageFromSearch("?page=learner")).toBe("learner");
		expect(pageFromSearch("?page=jobs")).toBe("jobs");
		expect(pageFromSearch("?page=chat")).toBe("chat");
	});

	it("rejects unknown ?page= values", () => {
		expect(pageFromSearch("?page=dashboard")).toBe("chat");
		expect(pageFromSearch("?page=preview")).toBe("chat");
	});

	it("maps legacy ?tab= deep links to pages", () => {
		expect(pageFromSearch("?tab=notebook")).toBe("notebook");
		expect(pageFromSearch("?tab=wiki")).toBe("notebook");
		expect(pageFromSearch("?tab=graph")).toBe("notebook");
		expect(pageFromSearch("?tab=skills")).toBe("skills");
		expect(pageFromSearch("?tab=profile")).toBe("learner");
		expect(pageFromSearch("?tab=jobs")).toBe("jobs");
	});

	it("keeps panel-only tabs on the chat page", () => {
		expect(pageFromSearch("?tab=preview")).toBe("chat");
		expect(pageFromSearch("?tab=settings")).toBe("chat");
	});

	it("?page= wins over ?tab=", () => {
		expect(pageFromSearch("?page=skills&tab=notebook")).toBe("skills");
	});
});

describe("sidebar navigation state", () => {
	it("keeps one bounded sidebar width through page changes and collapse", () => {
		const previousWidth = appStore.sidebarWidth;
		const previousCollapsed = appStore.sidebarCollapsed;
		const setItem = vi.fn();
		vi.stubGlobal("window", { innerWidth: 1800, localStorage: { setItem } });
		try {
			appStore.setSidebarWidth(360);
			expect(setItem).toHaveBeenLastCalledWith("inno.sidebarWidth", "360");
			appStore.setPage("notebook", "none");
			appStore.setSidebarCollapsed(true);
			appStore.setPage("chat", "none");
			appStore.setSidebarCollapsed(false);
			expect(appStore.sidebarWidth).toBe(360);
			appStore.setSidebarWidth(900);
			expect(appStore.sidebarWidth).toBe(480);
			appStore.setSidebarWidth(100);
			expect(appStore.sidebarWidth).toBe(220);
		} finally {
			appStore.sidebarWidth = previousWidth;
			appStore.sidebarCollapsed = previousCollapsed;
			appStore.setPage("chat", "none");
			vi.unstubAllGlobals();
		}
	});

	it("does not change the fixed expand state when navigating between pages", () => {
		const previousCollapsed = appStore.sidebarCollapsed;
		try {
			appStore.sidebarCollapsed = true;
			appStore.setPage("notebook", "none");
			expect(appStore.sidebarCollapsed).toBe(true);
			appStore.sidebarCollapsed = false;
			appStore.setPage("chat", "none");
			expect(appStore.sidebarCollapsed).toBe(false);
		} finally {
			appStore.sidebarCollapsed = previousCollapsed;
			appStore.setPage("chat", "none");
		}
	});
});
