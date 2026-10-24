import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	appStore: {
		sidebarCollapsed: false,
		sidebarWidth: 246,
		workspaceMode: "collapsed" as const,
		workspaceWidth: 520,
	},
}));

vi.mock("./app-store.js", () => ({ appStore: mocks.appStore }));

import { ensureWindowForPanel } from "./window-expansion.js";

	describe("ensureWindowForPanel", () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
		mocks.appStore.sidebarCollapsed = false;
		mocks.appStore.sidebarWidth = 246;
		mocks.appStore.workspaceMode = "collapsed";
		mocks.appStore.workspaceWidth = 520;
	});

	it("falls back cleanly for a browser without the Electron bridge", async () => {
		vi.stubGlobal("window", { innerWidth: 1200 });

		await expect(ensureWindowForPanel("right", 640, "half")).resolves.toBe("unavailable");
	});

	it("uses the shared resized width when making room to reopen the sidebar", async () => {
		mocks.appStore.sidebarCollapsed = true;
		mocks.appStore.sidebarWidth = 400;
		const windowMock = { innerWidth: 1200, innoDesktop: { expandWindowWidth: vi.fn(async (_side: string, width: number) => {
			windowMock.innerWidth += width;
			return true;
		}) } };
		vi.stubGlobal("window", windowMock);
		await expect(ensureWindowForPanel("left")).resolves.toBe("ready");
		expect(windowMock.innoDesktop.expandWindowWidth).toHaveBeenCalledWith("left", 52);
	});

	it("moves the window left when the right edge has no room", async () => {
		const windowMock = {
			innerWidth: 1200,
			innoDesktop: {} as NonNullable<Window["innoDesktop"]>,
		};
		const expandWindowWidth = vi.fn(async (side: "left" | "right", additionalWidth: number) => {
			if (side !== "left") return false;
			windowMock.innerWidth += additionalWidth;
			return true;
		});
		const getWindowWidthCapacity = vi.fn(async (side: "left" | "right") => side === "left" ? 400 : 0);
		windowMock.innoDesktop = {
			setCloseDialogCopy: vi.fn(),
			expandWindowWidth,
			getWindowWidthCapacity,
			openLocalFile: vi.fn(async () => false),
			openSearchWindow: vi.fn(async () => true),
			closeSearchWindow: vi.fn(),
			openSearchResult: vi.fn(),
			onSearchNavigation: vi.fn(() => () => {}),
		};
		vi.stubGlobal("window", windowMock);

		await expect(ensureWindowForPanel("right", 500, "half")).resolves.toBe("ready");
		expect(getWindowWidthCapacity).toHaveBeenCalledWith("right");
		expect(getWindowWidthCapacity).toHaveBeenCalledWith("left");
		// 52px rail + 246px sidebar + 500px workspace + 800px chat - 1200px window.
		expect(expandWindowWidth).toHaveBeenCalledWith("left", 398);
	});

	it("reserves the 52px rail when expanding a workspace from collapsed desktop state", async () => {
		mocks.appStore.sidebarCollapsed = true;
		const windowMock = {
			innerWidth: 1_100,
			innoDesktop: {} as NonNullable<Window["innoDesktop"]>,
		};
		const expandWindowWidth = vi.fn(async (_side: "left" | "right", additionalWidth: number) => {
			windowMock.innerWidth += additionalWidth;
			return true;
		});
		windowMock.innoDesktop = {
			setCloseDialogCopy: vi.fn(),
			expandWindowWidth,
			getWindowWidthCapacity: vi.fn(async (side: "left" | "right") => side === "right" ? 252 : 0),
			openLocalFile: vi.fn(async () => false),
			openSearchWindow: vi.fn(async () => true),
			closeSearchWindow: vi.fn(),
			openSearchResult: vi.fn(),
			onSearchNavigation: vi.fn(() => () => {}),
		};
		vi.stubGlobal("window", windowMock);

		await expect(ensureWindowForPanel("right", 500, "half")).resolves.toBe("ready");
		expect(expandWindowWidth).toHaveBeenCalledWith("right", 252);
	});
});
