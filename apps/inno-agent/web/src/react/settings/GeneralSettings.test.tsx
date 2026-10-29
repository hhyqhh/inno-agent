import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithTooltipProvider as render } from "../test-utils.js";
import { GeneralSettings } from "./GeneralSettings.js";
import { themeStore } from "../../stores/theme-store.js";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }) }));
vi.mock("../../i18n/index.js", () => ({ setLocale: vi.fn() }));
vi.mock("../../api/settings.js", () => ({ saveThemeSettings: vi.fn(async () => ({})) }));

afterEach(() => { cleanup(); themeStore.apply("light"); vi.restoreAllMocks(); });

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
