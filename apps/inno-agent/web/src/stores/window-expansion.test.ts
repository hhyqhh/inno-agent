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
		vi.stubGlobal("window", { innerWidth: 960 });

		await expect(ensureWindowForPanel("right", 640, "half")).resolves.toBe("unavailable");
	});

	it("uses the shared resized width when making room to reopen the sidebar", async () => {
		mocks.appStore.sidebarCollapsed = true;
		mocks.appStore.sidebarWidth = 400;
		const windowMock = { innerWidth: 960, innoDesktop: { expandWindowWidth: vi.fn(async (_side: string, width: number) => {
			windowMock.innerWidth += width;
			return true;
		}) } };
		vi.stubGlobal("window", windowMock);
		await expect(ensureWindowForPanel("left")).resolves.toBe("ready");
		expect(windowMock.innoDesktop.expandWindowWidth).toHaveBeenCalledWith("left", 52);
	});

	it("grows the minimum desktop window by the requested file-preview width", async () => {
		mocks.appStore.sidebarCollapsed = true;
		const windowMock = { innerWidth: 612, innoDesktop: { expandWindowWidth: vi.fn(async (_side: string, width: number) => {
			windowMock.innerWidth += width;
			return true;
		}) } };
		vi.stubGlobal("window", windowMock);
		await expect(ensureWindowForPanel("right", 560, "half")).resolves.toBe("ready");
		expect(windowMock.innoDesktop.expandWindowWidth).toHaveBeenCalledWith("right", 560);
		expect(windowMock.innerWidth).toBe(1172);
	});

	it("moves the window left when the right edge has no room", async () => {
		const windowMock = {
			innerWidth: 960,
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
		// 52px rail + 246px sidebar + 500px workspace + 560px chat - 960px window.
		expect(expandWindowWidth).toHaveBeenCalledWith("left", 398);
	});

	it("reserves the 52px rail when expanding a workspace from collapsed desktop state", async () => {
		mocks.appStore.sidebarCollapsed = true;
		const windowMock = {
			innerWidth: 860,
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

	it("lands a released splitter at the preview's screen position even with space on both sides", async () => {
		mocks.appStore.sidebarCollapsed = true;
		let windowLeft = 400;
		const viewport = {
			innerWidth: 1200,
			innoDesktop: {
				getWindowWidthCapacity: vi.fn(async () => 400),
				expandWindowWidth: vi.fn(async (side: "left" | "right", width: number) => {
					viewport.innerWidth += width;
					if (side === "left") windowLeft -= width;
					return true;
				}),
			},
		};
		vi.stubGlobal("window", viewport);
		const requestedWidth = 768;
		const releaseScreenX = windowLeft + viewport.innerWidth - requestedWidth;
		await expect(ensureWindowForPanel("right", requestedWidth, "half", { preserveRightEdge: true })).resolves.toBe("ready");
		expect(viewport.innoDesktop.expandWindowWidth).toHaveBeenCalledExactlyOnceWith("left", 180);
		expect(windowLeft + viewport.innerWidth - requestedWidth).toBe(releaseScreenX);
	});

	it("does not spend right-side space on a splitter position that needs left-side room", async () => {
		mocks.appStore.sidebarCollapsed = true;
		const viewport = {
			innerWidth: 1200,
			innoDesktop: {
				getWindowWidthCapacity: vi.fn(async (side: "left" | "right") => side === "left" ? 0 : 400),
				expandWindowWidth: vi.fn(),
			},
		};
		vi.stubGlobal("window", viewport);
		await expect(ensureWindowForPanel("right", 768, "half", { preserveRightEdge: true })).resolves.toBe("unavailable");
		expect(viewport.innoDesktop.expandWindowWidth).not.toHaveBeenCalled();
	});
});
