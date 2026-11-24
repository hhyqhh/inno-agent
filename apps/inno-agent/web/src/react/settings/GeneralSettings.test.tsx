import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithTooltipProvider as render } from "../test-utils.js";
import { GeneralSettings } from "./GeneralSettings.js";
import { themeStore } from "../../stores/theme-store.js";
import { settingsStore } from "../../stores/settings-store.js";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }) }));
vi.mock("../../i18n/index.js", () => ({ setLocale: vi.fn() }));
vi.mock("../../api/settings.js", () => ({ saveThemeSettings: vi.fn(async () => ({})) }));

afterEach(() => {
	cleanup();
	themeStore.apply("light");
	settingsStore.settings = null;
	settingsStore.isSavingSmartCompact = false;
	settingsStore.error = null;
	vi.restoreAllMocks();
});

describe("system appearance setting", () => {
	it.each(["light", "dark"] as const)("keeps the resolved %s appearance when turning following off, then allows manual selection", (theme) => {
		themeStore.apply(theme);
		const save = vi.spyOn(themeStore, "save").mockImplementation(async (preference) => {
			themeStore.apply(preference);
		});
		render(<GeneralSettings />);
		const toggle = screen.getByRole("switch", { name: "settings.followSystem" });
		fireEvent.click(toggle);
		expect(save).toHaveBeenLastCalledWith("system");
		expect(toggle.getAttribute("aria-checked")).toBe("true");
		expect((screen.getByRole("button", { name: "settings.themeOptions.light" }) as HTMLButtonElement).disabled).toBe(true);
		// A native system update resolves to either palette without changing
		// the preference. Turning following off preserves that resolved value.
		act(() => {
			themeStore.current = theme;
		});
		fireEvent.click(toggle);
		expect(save).toHaveBeenLastCalledWith(theme);
		expect(toggle.getAttribute("aria-checked")).toBe("false");
		const other = theme === "light" ? "dark" : "light";
		fireEvent.click(screen.getByRole("button", { name: `settings.themeOptions.${other}` }));
		expect(save).toHaveBeenLastCalledWith(other);
	});
});

describe("Smart Compact settings", () => {
	function setup(overrides: Partial<NonNullable<NonNullable<typeof settingsStore.settings>["smartCompact"]>> = {}) {
		settingsStore.settings = {
			smartCompact: {
				enabled: true,
				preset: "300k",
				runtimeSupported: true,
				settingsError: false,
				...overrides,
			},
		} as typeof settingsStore.settings;
		return vi.spyOn(settingsStore, "saveSmartCompact").mockResolvedValue(undefined);
	}

	it("shows the three threshold presets and saves a selection immediately", () => {
		const save = setup();
		render(<GeneralSettings />);
		const select = screen.getByRole("combobox", { name: "settings.smartCompact.thresholdTitle" }) as HTMLSelectElement;
		expect(select.disabled).toBe(false);
		expect(select.value).toBe("300k");
		expect(Array.from(select.options).map((option) => option.value)).toEqual(["150k", "300k", "500k"]);
		fireEvent.change(select, { target: { value: "150k" } });
		expect(save).toHaveBeenCalledWith({ preset: "150k" });
	});

	it("saves the enable switch separately and shows the restart hint", async () => {
		const save = setup();
		render(<GeneralSettings />);
		const toggle = screen.getByRole("switch", { name: "settings.smartCompact.title" });
		expect(toggle.getAttribute("aria-checked")).toBe("true");
		fireEvent.click(toggle);
		expect(save).toHaveBeenCalledWith({ enabled: false });
		expect(await screen.findByText("settings.smartCompact.restartHint")).toBeTruthy();
	});

	it("keeps custom advanced settings visible and disables thresholds while the plugin is off", () => {
		setup({ enabled: false, preset: "custom" });
		render(<GeneralSettings />);
		const select = screen.getByRole("combobox", { name: "settings.smartCompact.thresholdTitle" }) as HTMLSelectElement;
		expect(select.disabled).toBe(true);
		expect(select.value).toBe("custom");
		expect(screen.getByRole("option", { name: "settings.smartCompact.presets.custom" })).toBeTruthy();
	});
});
