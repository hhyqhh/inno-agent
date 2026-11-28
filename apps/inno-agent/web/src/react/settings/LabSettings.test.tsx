import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithTooltipProvider as render } from "../test-utils.js";
import { LabSettings } from "./LabSettings.js";
import { settingsStore } from "../../stores/settings-store.js";
import type { InnoSettings } from "../../types/settings.js";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }) }));

afterEach(() => {
	cleanup();
	settingsStore.settings = null;
	settingsStore.isSavingComputerUse = false;
	settingsStore.isSavingCodemode = false;
	settingsStore.error = null;
	vi.restoreAllMocks();
});

function setupSettings() {
	settingsStore.settings = {
		defaultProvider: "openai",
		defaultModel: "gpt-4o",
		providers: {},
		availableModels: [],
		configuredModels: [],
		computerUse: { enabled: false, explicit: null, isDesktop: true },
		codemode: { enabled: false },
		smartInput: {
			enabled: true,
			allowDrag: true,
			allowRightClick: true,
			allowAgentCommands: true,
			rules: [],
		},
	} as InnoSettings;
}

describe("LabSettings", () => {
	it("saves computerUse and codemode toggles and shows restart hints", async () => {
		setupSettings();
		const saveComputerUse = vi.spyOn(settingsStore, "saveComputerUse").mockResolvedValue(undefined);
		const saveCodemode = vi.spyOn(settingsStore, "saveCodemode").mockResolvedValue(undefined);

		render(<LabSettings />);

		expect(screen.getByText("settings.groups.agentCapabilities")).toBeTruthy();

		const computerUseToggle = screen.getByRole("switch", { name: "settings.computerUse.title" });
		fireEvent.click(computerUseToggle);
		expect(saveComputerUse).toHaveBeenCalledWith(true);
		expect(await screen.findByText("settings.computerUse.restartHint")).toBeTruthy();

		const codemodeToggle = screen.getByRole("switch", { name: "settings.codemode.title" });
		fireEvent.click(codemodeToggle);
		expect(saveCodemode).toHaveBeenCalledWith(true);
		expect(await screen.findByText("settings.codemode.restartHint")).toBeTruthy();
	});
});
