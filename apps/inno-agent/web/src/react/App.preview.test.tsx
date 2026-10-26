import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithTooltipProvider as render } from "./test-utils.js";
import { appStore } from "../stores/app-store.js";
import { sessionsStore } from "../stores/sessions-store.js";
import { workspacesStore } from "../stores/workspaces-store.js";
import { settingsStore } from "../stores/settings-store.js";

const mocks = vi.hoisted(() => ({ ensure: vi.fn() }));
vi.mock("../stores/window-expansion.js", () => ({ ensureWindowForPanel: mocks.ensure }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("./ChatCenter.js", () => ({ ChatCenter: () => null }));
vi.mock("./FeaturePage.js", () => ({ FeaturePage: () => null }));
vi.mock("./WorkspacePanel.js", () => ({ WorkspacePanel: () => null }));
vi.mock("./WorkspacePreviewTabs.js", () => ({ WorkspacePreviewTabs: () => null }));
vi.mock("./DesktopWindowChrome.js", () => ({ DesktopWindowChrome: () => null }));
vi.mock("./SearchPanel.js", () => ({ SearchPanel: () => null }));
vi.mock("./SessionSidebar.js", () => ({
	startNewChat: vi.fn(),
	SessionSidebar: ({ onPreviewFile }: { onPreviewFile: (width: number) => Promise<void> }) =>
		<button onClick={() => void onPreviewFile(560)}>Open file</button>,
}));
import { App } from "./App.js";

const previous = { sidebarCollapsed: appStore.sidebarCollapsed, workspaceMode: appStore.workspaceMode, workspaceWidth: appStore.workspaceWidth, page: appStore.page };

beforeEach(() => {
	vi.spyOn(sessionsStore, "load").mockResolvedValue(undefined);
	vi.spyOn(workspacesStore, "load").mockResolvedValue(undefined);
	vi.spyOn(settingsStore, "load").mockResolvedValue(undefined);
	vi.stubGlobal("innerWidth", 612);
	vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
	appStore.sidebarCollapsed = true;
	appStore.workspaceMode = "collapsed";
	appStore.workspaceWidth = 520;
	appStore.page = "chat";
	mocks.ensure.mockReset();
});
afterEach(() => { cleanup(); Object.assign(appStore, previous); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("opening a file from a minimum-width window", () => {
	it("expands Electron before opening a split preview", async () => {
		vi.stubGlobal("innoDesktop", { onSearchNavigation: () => () => {} });
		mocks.ensure.mockImplementation(async () => { vi.stubGlobal("innerWidth", 1172); return "ready"; });
		render(<App />);
		fireEvent.click(screen.getByRole("button", { name: "Open file" }));
		await waitFor(() => expect(appStore.workspaceMode).toBe("half"));
		expect(mocks.ensure).toHaveBeenCalledExactlyOnceWith("right", 560, "half");
		expect(appStore.workspaceWidth).toBe(560);
	});

	it("still opens a readable overlay if Electron cannot expand", async () => {
		vi.stubGlobal("innoDesktop", { onSearchNavigation: () => () => {} });
		mocks.ensure.mockResolvedValue("unavailable");
		render(<App />);
		fireEvent.click(screen.getByRole("button", { name: "Open file" }));
		await waitFor(() => expect(appStore.workspaceMode).toBe("full"));
		expect(mocks.ensure).toHaveBeenCalledOnce();
	});

	it("keeps the narrow browser overlay without requesting native expansion", async () => {
		vi.stubGlobal("innoDesktop", undefined);
		render(<App />);
		fireEvent.click(screen.getByRole("button", { name: "Open file" }));
		await waitFor(() => expect(appStore.workspaceMode).toBe("full"));
		expect(mocks.ensure).not.toHaveBeenCalled();
	});
});
