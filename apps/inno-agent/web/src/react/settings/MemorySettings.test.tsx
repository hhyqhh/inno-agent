import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithTooltipProvider as render } from "../test-utils.js";
import { MemorySettings } from "./MemorySettings.js";
import { settingsStore } from "../../stores/settings-store.js";
import type { InnoSettings } from "../../types/settings.js";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }) }));

afterEach(() => {
	cleanup();
	settingsStore.settings = null;
	settingsStore.isSavingSmartCompact = false;
	settingsStore.error = null;
	vi.restoreAllMocks();
});

function makeSettings(overrides: Partial<NonNullable<InnoSettings["smartCompact"]>> = {}): InnoSettings {
	return {
		defaultProvider: "openai",
		defaultModel: "gpt-4o",
		providers: {},
		availableModels: [],
		configuredModels: [],
		memory: { l1Enabled: true, l2Enabled: true, l3Enabled: true },
		smartCompact: {
			enabled: true,
			preset: "300k",
			runtimeSupported: true,
			settingsError: false,
			...overrides,
		},
	};
}

describe("MemorySettings", () => {
	it("renders layered memory toggles and context management group", () => {
		const settings = makeSettings();
		settingsStore.settings = settings;
		render(<MemorySettings settings={settings} />);

		expect(screen.getByText("settings.memorySection")).toBeTruthy();
		expect(screen.getByText("settings.groups.contextManagement")).toBeTruthy();
		expect(screen.getByRole("switch", { name: "settings.l1.title" }).getAttribute("aria-checked")).toBe("true");
		expect(screen.getByRole("switch", { name: "settings.l2.title" }).getAttribute("aria-checked")).toBe("true");
		expect(screen.getByRole("switch", { name: "settings.memory.title" }).getAttribute("aria-checked")).toBe("true");
	});

	it("saves the Smart Compact enable switch and shows the restart hint", async () => {
		const settings = makeSettings();
		settingsStore.settings = settings;
		const save = vi.spyOn(settingsStore, "saveSmartCompact").mockResolvedValue(undefined);
		render(<MemorySettings settings={settings} />);

		const toggle = screen.getByRole("switch", { name: "settings.smartCompact.title" });
		expect(toggle.getAttribute("aria-checked")).toBe("true");
		fireEvent.click(toggle);
		expect(save).toHaveBeenCalledWith({ enabled: false });
		expect(await screen.findByText("settings.smartCompact.restartHint")).toBeTruthy();
	});

	it("disables the threshold selector while Smart Compact is off and preserves custom display", () => {
		const settings = makeSettings({ enabled: false, preset: "custom" });
		settingsStore.settings = settings;
		render(<MemorySettings settings={settings} />);

		const trigger = screen.getByRole("combobox", { name: "settings.smartCompact.thresholdTitle" }) as HTMLButtonElement;
		expect(trigger.disabled).toBe(true);
		expect(trigger.textContent).toContain("settings.smartCompact.presets.custom");
	});
});
