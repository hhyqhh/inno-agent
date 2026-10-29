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
vi.mock("./DesktopWindowChrome.js", () => ({
	DesktopWindowChrome: ({ onToggleSidebar }: { onToggleSidebar: () => void }) =>
		<button onClick={onToggleSidebar}>Toggle sidebar</button>,
}));
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

describe.each(["light", "dark"])("sidebar scrim in the %s theme", (theme) => {
	beforeEach(() => {
		const previousTheme = document.documentElement.getAttribute("data-theme");
		document.documentElement.setAttribute("data-theme", theme);
		return () => {
			if (previousTheme === null) document.documentElement.removeAttribute("data-theme");
			else document.documentElement.setAttribute("data-theme", previousTheme);
		};
	});

	it.each([612, 856, 960])("keeps the Electron sidebar unobstructed at %ipx", async (width) => {
		vi.stubGlobal("innerWidth", width);
		vi.stubGlobal("innoDesktop", { onSearchNavigation: () => () => {} });
		mocks.ensure.mockResolvedValue("ready");
		const { container } = render(<App />);
		fireEvent.click(screen.getByRole("button", { name: "Toggle sidebar" }));
		await waitFor(() => expect(appStore.sidebarCollapsed).toBe(false));
		expect(container.querySelector(".app-layout-scrim")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Toggle sidebar" }));
		expect(appStore.sidebarCollapsed).toBe(true);
	});

	it("keeps tap-to-dismiss on the narrow browser drawer", async () => {
		vi.stubGlobal("innoDesktop", undefined);
		mocks.ensure.mockResolvedValue("ready");
		const { container } = render(<App />);
		expect(container.querySelector(".app-layout-scrim")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Toggle sidebar" }));
		await waitFor(() => expect(appStore.sidebarCollapsed).toBe(false));
		const scrim = container.querySelector(".app-layout-scrim");
		expect(scrim).not.toBeNull();
		fireEvent.click(scrim!);
		expect(appStore.sidebarCollapsed).toBe(true);
		expect(container.querySelector(".app-layout-scrim")).toBeNull();
	});
});

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
