// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("navigation history", () => {
	beforeEach(() => { vi.resetModules(); window.history.replaceState({ unrelated: "keep" }, "", "/"); });
	const go = (delta: number) => new Promise<void>((resolve) => {
		window.addEventListener("popstate", () => resolve(), { once: true });
		window.history.go(delta);
	});

	it("tracks push/replace navigation and preserves existing history state", async () => {
		const history = await import("./navigation-history.js");
		history.initializeNavigationHistory();
		expect(history.getNavigationAvailability()).toEqual({ canGoBack: false, canGoForward: false });
		history.syncNavigationHistory(new URL("/chat?session=a", location.href), "push");
		history.syncNavigationHistory(new URL("/chat?session=b", location.href), "replace");
		expect(window.history.state.unrelated).toBe("keep");
		expect(history.getNavigationAvailability()).toEqual({ canGoBack: true, canGoForward: false });
		await go(-1);
		expect(history.getNavigationAvailability()).toEqual({ canGoBack: false, canGoForward: true });
	});

	it("does not revive a discarded forward branch from an older entry's saved maximum", async () => {
		const history = await import("./navigation-history.js");
		history.initializeNavigationHistory();
		for (const page of ["a", "b", "c"]) history.syncNavigationHistory(new URL(`/${page}`, location.href), "push");
		await go(-2);
		history.getNavigationAvailability();
		history.syncNavigationHistory(new URL("/replacement", location.href), "push");
		await go(-1);
		history.getNavigationAvailability();
		await go(1);
		expect(history.getNavigationAvailability()).toEqual({ canGoBack: true, canGoForward: false });
	});

	it("restores the current forward boundary after a module reload", async () => {
		const history = await import("./navigation-history.js");
		history.initializeNavigationHistory();
		history.syncNavigationHistory(new URL("/a", location.href), "push");
		await go(-1);
		history.getNavigationAvailability();
		vi.resetModules();
		const reloaded = await import("./navigation-history.js");
		reloaded.initializeNavigationHistory();
		expect(reloaded.getNavigationAvailability()).toEqual({ canGoBack: false, canGoForward: true });
	});
});
