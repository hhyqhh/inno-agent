import { useState } from "react";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithTooltipProvider as render } from "./test-utils.js";
import { InnoDndProvider } from "./ui/dnd-backend.js";
import { IconButton } from "./ui/index.js";
import { useStoreSnapshot } from "./hooks.js";
import { terminalStore } from "../stores/terminal-store.js";
import { workspaceStore, isStartTabKey } from "../stores/workspace-store.js";
import type { WorkspaceMode } from "../stores/app-store.js";
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
