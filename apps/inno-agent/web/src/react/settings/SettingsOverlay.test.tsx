import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithTooltipProvider as render } from "../test-utils.js";
import { SettingsOverlay } from "./SettingsOverlay.js";
import { appStore } from "../../stores/app-store.js";
import { settingsStore } from "../../stores/settings-store.js";
import type { InnoSettings } from "../../types/settings.js";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }) }));
vi.mock("../../i18n/index.js", () => ({ setLocale: vi.fn() }));
vi.mock("../../api/settings.js", () => ({
	saveThemeSettings: vi.fn(async () => ({})),
	getWebAccessSettings: vi.fn(async () => ({ defaultProvider: "auto", providers: [] })),
	saveWebAccessSettings: vi.fn(async () => ({ defaultProvider: "auto", providers: [] })),
	feishuQrRegister: vi.fn(),
	feishuQrStatus: vi.fn(),
	wechatQrLogin: vi.fn(),
	wechatQrStatus: vi.fn(),
	wechatStatus: vi.fn(async () => ({ connected: false })),
}));
vi.mock("../../api/wiki.js", () => ({
	getWikiStats: vi.fn(async () => ({ pageCount: 2, totalSize: 1024 })),
}));

afterEach(() => {
	cleanup();
	appStore.closeSettings();
	appStore.setSettingsTab("general");
	settingsStore.settings = null;
	vi.restoreAllMocks();
});

describe("SettingsOverlay", () => {
	it("renders four navigation groups and switches between categorized tabs", () => {
		vi.spyOn(settingsStore, "load").mockResolvedValue(undefined);
		settingsStore.settings = {
			defaultProvider: "openai",
			defaultModel: "gpt-4o",
			providers: {},
			availableModels: [],
			configuredModels: [],
			memory: { l1Enabled: true, l2Enabled: true, l3Enabled: true },
			smartCompact: { enabled: true, preset: "300k", runtimeSupported: true, settingsError: false },
			computerUse: { enabled: false, explicit: null, isDesktop: true },
			codemode: { enabled: false },
			smartInput: { enabled: true, allowDrag: true, allowRightClick: true, allowAgentCommands: true, rules: [] },
		} as InnoSettings;

		appStore.openSettings("general");
		render(<SettingsOverlay />);

		expect(screen.getByText("settings.navGroups.basic")).toBeTruthy();
		expect(screen.getByText("settings.navGroups.intelligence")).toBeTruthy();
		expect(screen.getByText("settings.navGroups.extensions")).toBeTruthy();
		expect(screen.getByText("settings.navGroups.system")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "settings.tabs.memory" }));
		expect(screen.getByText("settings.groups.contextManagement")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "settings.tabs.lab" }));
		expect(screen.getByText("settings.groups.agentCapabilities")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "settings.tabs.integrations" }));
		expect(screen.getByText("settings.groups.webSearch")).toBeTruthy();
		expect(screen.getByText("settings.groups.mediaAndContent")).toBeTruthy();
	});
});
