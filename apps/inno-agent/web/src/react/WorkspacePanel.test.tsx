import { useState } from "react";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithTooltipProvider as render } from "./test-utils.js";
import { InnoDndProvider } from "./ui/dnd-backend.js";
import { IconButton } from "./ui/index.js";
import { useStoreSnapshot } from "./hooks.js";
import { terminalStore } from "../stores/terminal-store.js";
import { workspaceStore, isStartTabKey } from "../stores/workspace-store.js";
import type { WorkspaceMode } from "../stores/app-store.js";
import { appStore } from "../stores/app-store.js";
import { getSidebarLayoutWidth, getEffectiveWorkspaceWidth } from "../stores/app-layout.js";
import { DesktopWindowChrome } from "./DesktopWindowChrome.js";
import { WorkspacePanel } from "./WorkspacePanel.js";
import { WorkspacePreviewTabs } from "./WorkspacePreviewTabs.js";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("./WorkspaceBrowser.js", () => ({
	WorkspaceBrowser: ({ variant }: { variant: string }) => <article aria-label="File preview" data-variant={variant}>Preview content</article>,
}));

function Layout({ desktop = true, terminal = false }: { desktop?: boolean; terminal?: boolean }) {
	const [mode, setMode] = useState<WorkspaceMode>("collapsed");
	const terminalOpen = useStoreSnapshot(terminalStore, () => terminalStore.isOpen);
	return (
		<InnoDndProvider>
			<DesktopWindowChrome
				showWorkspaceControl
				showSidebarControl={false}
				showNewChatControl={false}
				showChatHeader={false}
				isDesktopWindow={desktop}
				sidebarCollapsed={false}
				newChatLabel="New chat"
				sidebarExpandLabel="Expand sidebar"
				sidebarCollapseLabel="Collapse sidebar"
				workspaceCollapsed={mode === "collapsed"}
				workspaceOpenLabel="workspace.openWorkspace"
				workspaceCollapseLabel="workspace.collapseWorkspace"
				backLabel="Back"
				forwardLabel="Forward"
				canNavigateBack={false}
				canNavigateForward={false}
				onToggleSidebar={vi.fn()}
				onNewChat={vi.fn()}
				onNavigateBack={vi.fn()}
				onNavigateForward={vi.fn()}
				onToggleWorkspace={() => setMode((current) => current === "collapsed" ? "half" : "collapsed")}
				workspaceMode={mode}
				workspaceFullLabel="workspace.full"
				workspaceRestoreLabel="workspace.half"
				onWorkspaceModeChange={setMode}
				workspaceTabs={<WorkspacePreviewTabs />}
				terminalControl={terminal ? (
					<IconButton
						size="xs"
						aria-label={terminalOpen ? "terminal.collapse" : "terminal.expand"}
						aria-pressed={terminalOpen}
						onClick={() => terminalStore.setOpen(!terminalOpen)}
					>
						T
					</IconButton>
				) : undefined}
			/>
			<WorkspacePanel
				mode={mode}
				width={520}
				merged={desktop}
				showFileTree={!desktop}
				showTerminalToggle={terminal}
				onModeChange={setMode}
				onWidthChange={vi.fn()}
				onPreviewFile={vi.fn()}
			/>
		</InnoDndProvider>
	);
}

describe("Workspace header controls", () => {
	beforeEach(() => {
		workspaceStore.previewTabs = []; workspaceStore.activePreviewPath = null; workspaceStore.streamingPreview = null;
		vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
		terminalStore.setOpen(false);
	});
	afterEach(() => {
		cleanup();
		terminalStore.setOpen(false);
		vi.unstubAllGlobals();
	});

	it.each([true, false])("keeps one workspace toggle in the upper toolbar in desktop=%s", async (desktop) => {
		render(<Layout desktop={desktop} />);
		expect(screen.queryByRole("button", { name: "workspace.collapseWorkspace" })).toBeNull();
		const toggle = screen.getByRole("button", { name: "workspace.openWorkspace" });
		const toolbar = toggle.closest(".inno-window-chrome") as HTMLElement;
		fireEvent.click(toggle);
		const close = screen.getByRole("button", { name: "workspace.collapseWorkspace" });
		if (desktop) expect(isStartTabKey(workspaceStore.activePreviewPath)).toBe(true);
		expect(within(toolbar).getByRole("button", { name: "workspace.collapseWorkspace" })).toBe(toggle);
		expect(close.getAttribute("aria-expanded")).toBe("true");
		expect(close.closest(".inno-workspace-header")).toBeNull();
		expect(screen.queryByRole("button", { name: "workspace.openWorkspace" })).toBeNull();
		expect(screen.queryByRole("button", { name: "terminal.expand" })).toBeNull();
		const preview = await screen.findByRole("article", { name: "File preview" });
		expect(preview.getAttribute("data-variant")).toBe(desktop ? "preview" : "workspace");
		fireEvent.click(close);
		expect(screen.queryByRole("button", { name: "workspace.collapseWorkspace" })).toBeNull();
		expect(screen.getByRole("button", { name: "workspace.openWorkspace" }).getAttribute("aria-expanded")).toBe("false");
		fireEvent.click(screen.getByRole("button", { name: "workspace.openWorkspace" }));
		expect(screen.getByRole("article", { name: "File preview" })).toBe(preview);
	});

	it("restores split view from fullscreen and can close directly from fullscreen", () => {
		render(<Layout />);
		fireEvent.click(screen.getByRole("button", { name: "workspace.openWorkspace" }));
		const tab = screen.getByRole("tab", { name: "workspaceStart.tab" });
		const track = tab.closest(".inno-window-chrome-preview-tabs")!;
		const separator = track.querySelector(".inno-window-chrome-preview-divider");
		expect(separator?.parentElement).toBe(track);
		expect(screen.getByRole("button", { name: "workspaceStart.open" }).closest(".inno-window-chrome-preview-tabs")).toBe(track);
		fireEvent.click(screen.getByRole("button", { name: "workspace.full" }));
		expect(screen.getByRole("tab", { name: "workspaceStart.tab" })).toBe(tab);
		expect(track.querySelector(".inno-window-chrome-preview-divider")).toBe(separator);
		expect(screen.queryByRole("separator", { name: "workspace.resize" })).toBeNull();
		expect(screen.getByRole("button", { name: "workspace.half" }).getAttribute("aria-pressed")).toBe("true");
		expect(screen.getByRole("button", { name: "workspace.collapseWorkspace" }).closest(".inno-window-chrome")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "workspace.half" }));
		expect(screen.getByRole("button", { name: "workspace.full" }).getAttribute("aria-pressed")).toBe("false");
		expect(screen.getByRole("separator", { name: "workspace.resize" })).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "workspace.full" }));
		fireEvent.click(screen.getByRole("button", { name: "workspace.collapseWorkspace" }));
		expect(screen.getByRole("button", { name: "workspace.openWorkspace" })).toBeTruthy();
		expect(screen.queryByRole("tab")).toBeNull();
		expect(separator?.isConnected).toBe(true);
	});

	it("pins the editor content to the settled width during the open slide, then releases it", async () => {
		render(<Layout />);
		fireEvent.click(screen.getByRole("button", { name: "workspace.openWorkspace" }));
		const tabPanel = document.querySelector<HTMLElement>("#workspace-preview .inno-ui-tab-panel")!;
		// The pin lands in the open commit itself: the engine never lays out at
		// width 0 or an intermediate slide width, and the content stays visible
		// (clipped) instead of leaving a white pane during the slide.
		const expected = Math.max(0, getEffectiveWorkspaceWidth(appStore.workspaceWidth, "half") - 3);
		expect(tabPanel.style.width).toBe(`${expected}px`);
		expect(tabPanel.classList.contains("hidden")).toBe(false);
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 320)); });
		expect(tabPanel.style.width).toBe("");
		expect(tabPanel.classList.contains("hidden")).toBe(false);
	});

	it("shows the shared tooltip over the preview fullscreen button", async () => {
		render(<Layout />);
		fireEvent.click(screen.getByRole("button", { name: "workspace.openWorkspace" }));
		const expand = screen.getByRole("button", { name: "workspace.full" });
		fireEvent.pointerMove(expand);
		expect(await screen.findByText("workspace.full")).toBeTruthy();
		// The hint renders through the shared Tooltip; the native title stays
		// empty so the browser tooltip never doubles up with it.
		expect(expand.getAttribute("title")).toBeNull();
	});

	it("preserves a positive editor viewport through collapse and rapid reopen", async () => {
		render(<Layout />);
		fireEvent.click(screen.getByRole("button", { name: "workspace.openWorkspace" }));
		const preview = await screen.findByRole("article", { name: "File preview" });
		const panel = document.querySelector<HTMLElement>("#workspace-preview .inno-ui-tab-panel")!;
		await act(async () => { await new Promise(resolve => setTimeout(resolve, 320)); });
		vi.spyOn(panel, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 517, 700));
		for (let i = 0; i < 2; i++) {
			fireEvent.click(screen.getByRole("button", { name: "workspace.collapseWorkspace" }));
			expect(panel.classList.contains("hidden")).toBe(false);
			expect(panel.classList.contains("invisible")).toBe(true);
			expect(panel.style.width).toBe("517px");
			// The width must survive beyond the open animation's fallback timer.
			if (i === 0) await act(async () => { await new Promise(resolve => setTimeout(resolve, 320)); });
			expect(panel.style.width).toBe("517px");
			fireEvent.click(screen.getByRole("button", { name: "workspace.openWorkspace" }));
			expect(panel.classList.contains("invisible")).toBe(false);
			expect(parseFloat(panel.style.width)).toBeGreaterThan(0);
			expect(screen.getByRole("article", { name: "File preview" })).toBe(preview);
		}
	});

	it("keeps the optional terminal toggle in the same action row and exposes its state", () => {
		render(<Layout terminal />);
		fireEvent.click(screen.getByRole("button", { name: "workspace.openWorkspace" }));
		const terminal = screen.getByRole("button", { name: "terminal.expand" });
		const toolbar = terminal.closest(".inno-window-chrome") as HTMLElement;
		expect(within(toolbar).getByRole("button", { name: "workspace.full" })).toBeTruthy();
		fireEvent.click(terminal);
		expect(terminalStore.isOpen).toBe(true);
		expect(screen.getByRole("button", { name: "terminal.collapse" }).getAttribute("aria-pressed")).toBe("true");
		fireEvent.click(screen.getByRole("button", { name: "terminal.collapse" }));
		expect(terminalStore.isOpen).toBe(false);
	});
});

function resizePointer(target: HTMLElement | Window, type: string, clientX: number, pointerId = 1) {
	const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX });
	Object.defineProperty(event, "pointerId", { value: pointerId });
	fireEvent(target, event);
}

// Drag moves are applied once per animation frame; let the pending frame run.
async function flushFrame() {
	await act(async () => {
		await new Promise((resolve) => requestAnimationFrame(resolve));
	});
}

describe("Workspace drag to fullscreen", () => {
	beforeEach(() => {
		vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
		vi.stubGlobal("innerWidth", 1400);
		vi.stubGlobal("innoDesktop", undefined);
	});
	const originalTheme = document.documentElement.getAttribute("data-theme");
	afterEach(() => {
		cleanup(); vi.unstubAllGlobals();
		if (originalTheme === null) document.documentElement.removeAttribute("data-theme");
		else document.documentElement.setAttribute("data-theme", originalTheme);
	});

	function startDrag(theme = "light", mode: WorkspaceMode = "half", renderedWidth = 520) {
		document.documentElement.setAttribute("data-theme", theme);
		const onModeChange = vi.fn();
		const onWidthChange = vi.fn();
		const view = render(<div className="app-layout"><InnoDndProvider><WorkspacePanel mode={mode} width={520}
			onModeChange={onModeChange} onWidthChange={onWidthChange} onPreviewFile={vi.fn()} /></InnoDndProvider></div>);
		const handle = screen.getByRole("separator", { name: "workspace.resize" });
		vi.spyOn(handle.closest("aside")!, "getBoundingClientRect").mockReturnValue(new DOMRect(800, 48, renderedWidth, 700));
		const max = Number(handle.getAttribute("aria-valuemax"));
		resizePointer(handle, "pointerdown", 800);
		return { layout: view.container.firstElementChild as HTMLElement, onModeChange, onWidthChange, edge: 800 - (max - 520), max };
	}

	it.each(["light", "dark"])("arms at 24px beyond the limit and enters fullscreen only on release (%s)", async (theme) => {
		const { edge, max, onModeChange, onWidthChange } = startDrag(theme);
		resizePointer(window, "pointermove", edge - 23);
		await flushFrame();
		expect(screen.queryByText("workspace.releaseToFullscreen")).toBeNull();
		resizePointer(window, "pointermove", edge - 24);
		await flushFrame();
		expect(screen.getByText("workspace.releaseToFullscreen").textContent).toBe("workspace.releaseToFullscreen");
		expect(screen.getAllByRole("tooltip")).toHaveLength(1);
		expect(onModeChange).not.toHaveBeenCalled();
		expect(onWidthChange).toHaveBeenLastCalledWith(max);
		resizePointer(window, "pointerup", edge - 24);
		expect(onModeChange).toHaveBeenCalledExactlyOnceWith("full");
		expect(screen.queryByText("workspace.releaseToFullscreen")).toBeNull();
		expect(document.body.classList.contains("workspace-resizing")).toBe(false);
	});

	it("shows live percentages in the top tooltip and clips the drag edge below the toolbar", async () => {
		const { layout } = startDrag();
		resizePointer(window, "pointermove", 760);
		await flushFrame();
		const total = 1400 - getSidebarLayoutWidth(appStore.sidebarCollapsed, false, appStore.sidebarWidth);
		expect(screen.getByRole("tooltip").textContent).toBe(`workspace.resize (${Math.round(560 / total * 100)}%)`);
		const preview = document.querySelector<HTMLElement>(".workspace-resize-preview")!;
		expect(preview.style.top).toBe("48px");
		expect(preview.style.right).toBe("80px");
		expect(preview.style.width).toBe("560px");
		expect(preview.querySelector(".workspace-resize-tooltip-anchor")).toBeTruthy();
		expect(layout.style.getPropertyValue("--inno-workspace-drag-width")).toBe("560px");
		expect(layout.style.getPropertyValue("--inno-workspace-drag-left")).toBe("760px");
		fireEvent.keyDown(window, { key: "Escape" });
		expect(layout.style.getPropertyValue("--inno-workspace-drag-width")).toBe("");
		expect(layout.style.getPropertyValue("--inno-workspace-drag-left")).toBe("");
		expect(screen.queryByRole("tooltip")).toBeNull();
	});

	it("keeps hover and drag hints on the same side aligned with the content top", async () => {
		render(<InnoDndProvider><WorkspacePanel mode="half" width={520}
			onModeChange={vi.fn()} onWidthChange={vi.fn()} onPreviewFile={vi.fn()} /></InnoDndProvider>);
		const handle = screen.getByRole("separator", { name: "workspace.resize" });
		fireEvent.pointerMove(handle, { pointerType: "mouse" });
		const hoverHint = await screen.findByRole("tooltip");
		expect(hoverHint.getAttribute("data-side")).toBe("right");
		expect(hoverHint.getAttribute("data-align")).toBe("start");
		resizePointer(handle, "pointerdown", 800);
		const dragHint = screen.getByRole("tooltip");
		expect(dragHint.getAttribute("data-side")).toBe("right");
		expect(dragHint.getAttribute("data-align")).toBe("start");
	});

	it.each(["light", "dark"])("keeps the line style and measured toolbar edge consistent through the whole gesture (%s)", async (theme) => {
		const { layout, edge } = startDrag(theme, "half", 517);
		const preview = document.querySelector<HTMLElement>(".workspace-resize-preview")!;
		// A 3px shell inset must not move the line when the pointer first presses.
		expect(preview.style.width).toBe("517px");
		expect(layout.style.getPropertyValue("--inno-workspace-drag-left")).toBe("800px");
		for (const clientX of [760, edge, edge - 24, edge + 8]) {
			resizePointer(window, "pointermove", clientX);
			await flushFrame();
			expect(preview.className).toBe("workspace-resize-preview");
			const previewX = 1400 - Number.parseFloat(preview.style.right) - Number.parseFloat(preview.style.width);
			expect(Number.parseFloat(layout.style.getPropertyValue("--inno-workspace-drag-left"))).toBe(previewX);
			expect(preview.style.top).toBe("48px");
			expect(preview.style.bottom).toBe(`${window.innerHeight - 748}px`);
			expect(screen.getByRole("tooltip").classList.contains("workspace-resize-tooltip")).toBe(true);
		}
		fireEvent.keyDown(window, { key: "Escape" });
		expect(layout.style.getPropertyValue("--inno-workspace-drag-left")).toBe("");
	});

	it("withdraws the pending fullscreen when the pointer returns before release", async () => {
		const { edge, onModeChange } = startDrag();
		resizePointer(window, "pointermove", edge - 30);
		await flushFrame();
		expect(screen.getByText("workspace.releaseToFullscreen")).toBeTruthy();
		resizePointer(window, "pointermove", edge);
		await flushFrame();
		expect(screen.queryByText("workspace.releaseToFullscreen")).toBeNull();
		resizePointer(window, "pointerup", edge);
		expect(onModeChange).not.toHaveBeenCalled();
	});

	it.each([0, 23])("keeps split view when released %spx beyond the maximum", async (overshoot) => {
		const { edge, max, onModeChange, onWidthChange } = startDrag();
		resizePointer(window, "pointermove", edge - overshoot);
		await flushFrame();
		resizePointer(window, "pointerup", edge - overshoot);
		expect(onModeChange).not.toHaveBeenCalled();
		expect(onWidthChange).toHaveBeenLastCalledWith(max);
	});

	it.each(["Escape", "pointercancel", "blur"])("cancels pending fullscreen on %s", async (cancel) => {
		const { edge, onModeChange, onWidthChange } = startDrag();
		resizePointer(window, "pointermove", edge - 30);
		await flushFrame();
		if (cancel === "Escape") fireEvent.keyDown(window, { key: "Escape" });
		else if (cancel === "blur") fireEvent.blur(window);
		else resizePointer(window, cancel, edge - 30);
		resizePointer(window, "pointerup", edge - 30);
		expect(onModeChange).not.toHaveBeenCalled();
		expect(onWidthChange).toHaveBeenLastCalledWith(520);
		expect(screen.queryByText("workspace.releaseToFullscreen")).toBeNull();
	});

	it("uses the release position and ignores other pointers in quarter mode", () => {
		const { edge, onModeChange } = startDrag("light", "quarter");
		resizePointer(window, "pointermove", edge - 30, 2);
		resizePointer(window, "pointerup", edge - 30, 2);
		expect(onModeChange).not.toHaveBeenCalled();
		resizePointer(window, "pointerup", edge - 24);
		expect(onModeChange).toHaveBeenCalledExactlyOnceWith("full");
	});

	it("measures the threshold against the desktop's expanded window capacity", async () => {
		vi.stubGlobal("innoDesktop", { getWindowWidthCapacity: vi.fn().mockResolvedValue(100) });
		const { edge, max, onModeChange, layout } = startDrag();
		await act(async () => { await Promise.resolve(); });
		resizePointer(window, "pointermove", edge - 24);
		await flushFrame();
		expect(screen.queryByText("workspace.releaseToFullscreen")).toBeNull();
		expect(layout.style.getPropertyValue("--inno-workspace-drag-width")).toBe(`${max + 24}px`);
		expect(layout.style.getPropertyValue("--inno-workspace-drag-left")).toBe(`${edge - 24}px`);
		expect(document.querySelector<HTMLElement>(".workspace-resize-preview")!.style.width).toBe(`${max + 24}px`);
		const expandedMax = Math.min(920, max + 200);
		const expandedEdge = 800 - (expandedMax - 520);
		resizePointer(window, "pointermove", expandedEdge - 24);
		await flushFrame();
		expect(screen.getByText("workspace.releaseToFullscreen")).toBeTruthy();
		expect(layout.style.getPropertyValue("--inno-workspace-drag-left")).toBe(`${expandedEdge}px`);
		resizePointer(window, "pointerup", expandedEdge - 24);
		expect(onModeChange).toHaveBeenCalledExactlyOnceWith("full");
	});

	it.each(["light", "dark"])("keeps the toolbar attached to the preview edge across deferred resizing and reversal (%s)", async (theme) => {
		vi.stubGlobal("innoDesktop", { getWindowWidthCapacity: vi.fn().mockResolvedValue(100) });
		const { edge, layout } = startDrag(theme, "half", 517);
		await act(async () => { await Promise.resolve(); });
		for (const clientX of [780, edge - 24, edge - 48, edge - 24, 780]) {
			resizePointer(window, "pointermove", clientX);
			await flushFrame();
			const preview = document.querySelector<HTMLElement>(".workspace-resize-preview")!;
			const previewX = window.innerWidth - parseFloat(preview.style.right) - parseFloat(preview.style.width);
			expect(Number.parseFloat(layout.style.getPropertyValue("--inno-workspace-drag-left"))).toBe(previewX);
			expect(layout.hasAttribute("data-workspace-resize-overlay")).toBe(clientX < edge);
		}
		expect(layout.style.getPropertyValue("--inno-workspace-drag-width")).toBe("540px");
		resizePointer(window, "pointermove", edge - 24);
		await flushFrame();
		expect(layout.hasAttribute("data-workspace-resize-overlay")).toBe(true);
		fireEvent.keyDown(window, { key: "Escape" });
		expect(layout.style.getPropertyValue("--inno-workspace-drag-left")).toBe("");
		expect(layout.hasAttribute("data-workspace-resize-overlay")).toBe(false);
	});
});
