import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
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
vi.mock("./WorkspacePreviewTabs.js", () => ({ WorkspacePreviewTabs: ({ resizing }: { resizing: boolean }) => <output data-testid="tabs-resizing">{String(resizing)}</output> }));
vi.mock("./DesktopWindowChrome.js", () => ({
	DesktopWindowChrome: ({ onToggleSidebar, workspaceTabs }: { onToggleSidebar: () => void; workspaceTabs: import("react").ReactNode }) =>
		<><button onClick={onToggleSidebar}>Toggle sidebar</button>{workspaceTabs}</>,
}));
vi.mock("./SearchPanel.js", () => ({ SearchPanel: () => null }));
vi.mock("./SessionSidebar.js", () => ({
	startNewChat: vi.fn(),
	SessionSidebar: ({ onPreviewFile, onResizingChange }: { onPreviewFile: (width: number) => Promise<void>; onResizingChange: (resizing: boolean) => void }) =>
		<><button onClick={() => void onPreviewFile(560)}>Open file</button><button onClick={() => onResizingChange(true)}>Start sidebar drag</button><button onClick={() => onResizingChange(false)}>End sidebar drag</button></>,
}));
import { App } from "./App.js";

const previous = { sidebarWidth: appStore.sidebarWidth, sidebarCollapsed: appStore.sidebarCollapsed, workspaceMode: appStore.workspaceMode, workspaceWidth: appStore.workspaceWidth, page: appStore.page };

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

it("suspends tab animations for the entire sidebar drag", () => {
	vi.stubGlobal("innoDesktop", { onSearchNavigation: () => () => {} });
	appStore.workspaceMode = "full";
	render(<App />);
	// The top track's animation suspension is CSS-owned (see app.css.test.ts);
	// the JS-side Motion projection lives in the tabs row.
	expect(screen.getByTestId("tabs-resizing").textContent).toBe("false");
	fireEvent.click(screen.getByRole("button", { name: "Start sidebar drag" }));
	expect(screen.getByTestId("tabs-resizing").textContent).toBe("true");
	act(() => appStore.setSidebarWidth(appStore.sidebarWidth + 32));
	expect(screen.getByTestId("tabs-resizing").textContent).toBe("true");
	fireEvent.click(screen.getByRole("button", { name: "End sidebar drag" }));
	expect(screen.getByTestId("tabs-resizing").textContent).toBe("false");
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

describe("fitting an existing preview while the desktop window shrinks", () => {
	it.each(["light", "dark"])("uses the preview minimum instead of the browser breakpoint (%s)", (theme) => {
		const previousTheme = document.documentElement.getAttribute("data-theme");
		document.documentElement.setAttribute("data-theme", theme);
		try {
			vi.stubGlobal("innoDesktop", { onSearchNavigation: () => () => {} });
			vi.stubGlobal("innerWidth", 1200);
			appStore.workspaceMode = "half";
			render(<App />);
			for (const [width, mode, previewWidth] of [
				[960, "half", 348], [932, "half", 320], [900, "quarter", 288],
				[858, "quarter", 246], [857, "quarter", 245], [852, "quarter", 240],
			] as const) {
				act(() => { vi.stubGlobal("innerWidth", width); fireEvent.resize(window); });
				expect(appStore.workspaceMode).toBe(mode);
				expect(appStore.workspaceWidth).toBe(previewWidth);
			}
			act(() => { vi.stubGlobal("innerWidth", 851); fireEvent.resize(window); });
			expect(appStore.workspaceMode).toBe("collapsed");
		} finally {
			if (previousTheme === null) document.documentElement.removeAttribute("data-theme");
			else document.documentElement.setAttribute("data-theme", previousTheme);
		}
	});
});
