import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/settings.js", () => ({ saveThemeSettings: vi.fn(async () => ({})) }));

let dark = false;
let notify: (() => void) | undefined;
const native = vi.fn(async (_preference: string): Promise<"light" | "dark" | null> => null);

beforeEach(() => {
	vi.resetModules();
	localStorage.clear();
	dark = false;
	notify = undefined;
	native.mockReset().mockResolvedValue(null);
	vi.stubGlobal("matchMedia", vi.fn(() => ({
		get matches() { return dark; },
		addEventListener: (_event: string, listener: () => void) => { notify = listener; },
	})));
	vi.stubGlobal("innoDesktop", { setThemePreference: native });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("theme preference", () => {
	it("restores system preference, follows changes, and keeps resolved palettes two-valued", async () => {
		dark = true;
		localStorage.setItem("inno.theme", "system");
		const { themeStore } = await import("./theme-store.js");
		expect(themeStore.preference).toBe("system");
		expect(themeStore.current).toBe("dark");
		expect(document.documentElement.dataset.theme).toBe("dark");
		expect(document.documentElement.classList.contains("dark")).toBe(true);
		expect(native).toHaveBeenCalledWith("system");
		dark = false; notify!();
		expect(themeStore.current).toBe("light");
		expect(document.documentElement.style.colorScheme).toBe("light");
		expect(localStorage.getItem("inno.theme")).toBe("system");
	});

	it("persists system through the existing endpoint and locks manual choices until system is chosen again", async () => {
		const { themeStore } = await import("./theme-store.js");
		const { saveThemeSettings } = await import("../api/settings.js");
		await themeStore.save("system");
		expect(saveThemeSettings).toHaveBeenLastCalledWith("system");
		themeStore.apply("dark");
		dark = false; notify!();
		expect(themeStore.preference).toBe("dark");
		expect(themeStore.current).toBe("dark");
		expect(native).toHaveBeenLastCalledWith("dark");
	});

	it("uses native resolution when removing a forced-light override and ignores stale replies", async () => {
		const { themeStore } = await import("./theme-store.js");
		// Electron's matchMedia can still be forced-light until IPC removes
		// the native override, even though the real OS appearance is dark.
		native.mockResolvedValueOnce("dark");
		themeStore.apply("system");
		await Promise.resolve();
		expect(themeStore.current).toBe("dark");
		let reply!: (value: "dark") => void;
		native.mockImplementationOnce(() => new Promise((resolve) => { reply = resolve; }));
		themeStore.apply("system");
		themeStore.apply("light");
		reply("dark"); await Promise.resolve();
		expect(themeStore.current).toBe("light");
		expect(themeStore.preference).toBe("light");
	});

	it("migrates retired and invalid themes to light while keeping explicit dark", async () => {
		const { normalizeThemeId } = await import("./theme-store.js");
		for (const value of [null, "warm", "ocean", "innospark", "bogus"]) expect(normalizeThemeId(value)).toBe("light");
		expect(normalizeThemeId("dark")).toBe("dark");
		expect(normalizeThemeId("system")).toBe("system");
	});
});
