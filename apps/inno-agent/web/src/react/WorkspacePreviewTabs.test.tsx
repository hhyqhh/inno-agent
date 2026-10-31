import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workspaceStore, isStartTab, isStartTabKey, previewTabKey } from "../stores/workspace-store.js";
import { workspacesStore } from "../stores/workspaces-store.js";
import { appStore } from "../stores/app-store.js";
import { sessionsStore } from "../stores/sessions-store.js";
import { chatStore } from "../stores/chat-store.js";
import { WorkspacePreviewTabs } from "./WorkspacePreviewTabs.js";
import { renderWithTooltipProvider as render } from "./test-utils.js";
import { Tooltip } from "./ui/index.js";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

describe("Workspace preview tab activation", () => {
	beforeEach(() => {
		appStore.workspaceMode = "half";
		workspaceStore.activeSurface = "preview";
		sessionsStore.currentSessionId = null;
		sessionsStore.pendingNewSession = false;
		chatStore.messages = [];
		workspaceStore.previewTabs = ["a.ts", "b.ts"].map((path) => ({
			path, name: path, isLoading: false, isEditing: false, isSaving: false, editBuffer: "", error: "", requestId: 1,
			file: { path, name: path, kind: "text", mimeType: "text/plain", size: 1, updatedAt: "now", content: path },
		}));
		workspaceStore.activePreviewPath = "a.ts";
		workspaceStore.streamingPreview = null;
		vi.spyOn(workspaceStore, "selectFile").mockResolvedValue();
	});

	afterEach(() => {
		cleanup();
		workspaceStore.previewTabs = [];
		workspaceStore.activePreviewPath = null;
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("activates a loaded tab without refetching its preview", () => {
		render(<WorkspacePreviewTabs />);
		fireEvent.click(screen.getByRole("tab", { name: "b.ts" }));
		expect(workspaceStore.activePreviewPath).toBe("b.ts");
		expect(screen.getByRole("tab", { name: "b.ts" }).getAttribute("aria-selected")).toBe("true");
		expect(workspaceStore.selectFile).not.toHaveBeenCalled();
	});

	it("adds the live conversation only in fullscreen and switches surfaces without losing file drafts", () => {
		vi.stubGlobal("innerWidth", 1600);
		appStore.workspaceMode = "full";
		sessionsStore.currentSessionId = "session-a";
		sessionsStore.sessions = [{ id: "session-a", name: "Optimization", hasTopic: true }] as typeof sessionsStore.sessions;
		workspaceStore.previewTabs[0].isEditing = true;
		workspaceStore.previewTabs[0].editBuffer = "unsaved draft";
		render(<WorkspacePreviewTabs />);
		const conversation = screen.getByRole("tab", { name: "Optimization" });
		expect(conversation.querySelector("[data-inno-tab-close]")).toBeNull();
		expect(conversation.getAttribute("aria-controls")).toBe("workspace-conversation-panel");
		fireEvent.click(conversation);
		expect(workspaceStore.activeSurface).toBe("conversation");
		expect(workspaceStore.activePreviewPath).toBe("a.ts");
		expect(conversation.getAttribute("aria-selected")).toBe("true");
		fireEvent.keyDown(conversation, { key: "ArrowRight" });
		expect(workspaceStore.activeSurface).toBe("preview");
		expect(screen.getByRole("tab", { name: "a.ts" }).getAttribute("aria-selected")).toBe("true");
		expect(workspaceStore.previewTabs[0].editBuffer).toBe("unsaved draft");
		fireEvent.click(conversation);
		act(() => appStore.setWorkspaceMode("half"));
		expect(screen.queryByRole("tab", { name: "Optimization" })).toBeNull();
		expect(workspaceStore.activeSurface).toBe("preview");
	});

	it("does not add a conversation tab on the welcome page", () => {
		appStore.workspaceMode = "full";
		render(<WorkspacePreviewTabs />);
		expect(screen.getAllByRole("tab")).toHaveLength(2);
	});

	it("retries an unloaded tab when activated", () => {
		workspaceStore.previewTabs[1].file = null;
		workspaceStore.previewTabs[1].error = "Failed to load";
		render(<WorkspacePreviewTabs />);
		fireEvent.click(screen.getByRole("tab", { name: "b.ts" }));
		expect(workspaceStore.selectFile).toHaveBeenCalledWith("b.ts", undefined, null);
	});
	it("keeps same-path tabs from different workspaces separate and closes only the chosen owner", () => {
		workspacesStore.workspaces = [{ id: "one", name: "First" }, { id: "two", name: "Second" }] as typeof workspacesStore.workspaces;
		workspaceStore.previewTabs = ["one", "two"].map((workspaceId) => ({ ...workspaceStore.previewTabs[0], workspaceId }));
		workspaceStore.activePreviewPath = previewTabKey(workspaceStore.previewTabs[0]);
		render(<WorkspacePreviewTabs />);
		fireEvent.click(screen.getByRole("tab", { name: "a.ts · Second" }));
		expect(workspaceStore.currentFileWorkspaceId).toBe("two");
		fireEvent.keyDown(screen.getByRole("tab", { name: "a.ts · Second" }), { key: "Delete" });
		expect(workspaceStore.previewTabs.map((tab) => tab.workspaceId)).toEqual(["one"]);
		expect(workspaceStore.currentFileWorkspaceId).toBe("one");
	});
	it("mints a fresh start page per plus click and preserves edited files", () => {
		workspaceStore.previewTabs[0].isEditing = true;
		workspaceStore.previewTabs[0].editBuffer = "unsaved draft";
		render(<WorkspacePreviewTabs />);
		fireEvent.click(screen.getByRole("button", { name: "workspaceStart.open" }));
		fireEvent.click(screen.getByRole("button", { name: "workspaceStart.open" }));
		expect(workspaceStore.previewTabs.filter(isStartTab)).toHaveLength(2);
		expect(workspaceStore.previewTabs[0].editBuffer).toBe("unsaved draft");
		expect(isStartTabKey(workspaceStore.activePreviewPath)).toBe(true);
		expect(workspaceStore.selectFile).not.toHaveBeenCalled();
	});
	it("preserves scroll, focus and file drafts when the tab row enters and leaves a sidebar drag", () => {
		appStore.workspaceMode = "full";
		sessionsStore.currentSessionId = "session-a";
		sessionsStore.sessions = [{ id: "session-a", name: "Conversation", hasTopic: true }] as typeof sessionsStore.sessions;
		workspaceStore.previewTabs[0].isEditing = true;
		workspaceStore.previewTabs[0].editBuffer = "unsaved draft";
		const { rerender } = render(<WorkspacePreviewTabs />);
		const strip = screen.getByRole("tablist");
		const plus = screen.getByRole("button", { name: "workspaceStart.open" });
		strip.scrollLeft = 82;
		plus.focus();
		for (const resizing of [true, false, true, false]) {
			rerender(<WorkspacePreviewTabs resizing={resizing} />);
			expect(screen.getByRole("tablist")).toBe(strip);
			expect(strip.scrollLeft).toBe(82);
			expect(document.activeElement).toBe(plus);
		}
		fireEvent.click(plus);
		expect(workspaceStore.previewTabs.filter(isStartTab)).toHaveLength(1);
		expect(workspaceStore.previewTabs[0].editBuffer).toBe("unsaved draft");
	});
	it("collapses only when closing the final start page", () => {
		const collapse = vi.spyOn(appStore, "setWorkspaceMode");
		workspaceStore.openStartPage();
		render(<WorkspacePreviewTabs />);
		fireEvent.keyDown(screen.getByRole("tab", { name: "workspaceStart.tab" }), { key: "Delete" });
		expect(collapse).not.toHaveBeenCalled();
		expect(workspaceStore.previewTabs).toHaveLength(2);
		fireEvent.keyDown(screen.getByRole("tab", { name: "a.ts" }), { key: "Delete" });
		fireEvent.keyDown(screen.getByRole("tab", { name: "b.ts" }), { key: "Delete" });
		expect(workspaceStore.activePreviewPath != null && isStartTabKey(workspaceStore.activePreviewPath)).toBe(true);
		expect(collapse).not.toHaveBeenCalled();
		fireEvent.keyDown(screen.getByRole("tab", { name: "workspaceStart.tab" }), { key: "Delete" });
		expect(collapse).toHaveBeenCalledWith("collapsed");
		expect(workspaceStore.previewTabs).toEqual([]);
	});
	it.each(["pointer", "keyboard"])("does not open the workspace tooltip after closing the last tab via %s", async (input) => {
		workspaceStore.previewTabs = []; workspaceStore.activePreviewPath = null;
		workspaceStore.openStartPage();
		render(<><Tooltip label="Open workspace"><button className="inno-window-chrome-workspace-button">Workspace toggle</button></Tooltip><WorkspacePreviewTabs /></>);
		const tab = screen.getByRole("tab", { name: "workspaceStart.tab" });
		if (input === "pointer") fireEvent.click(tab.querySelector("[data-inno-tab-close]")!);
		else fireEvent.keyDown(tab, { key: "Delete" });
		const toggle = screen.getByRole("button", { name: "Workspace toggle" });
		await waitFor(() => expect(document.activeElement).toBe(toggle));
		expect(screen.queryByRole("tooltip")).toBeNull();
		// Suppress only restoration; normal subsequent hovering must still work.
		fireEvent.pointerMove(toggle, { pointerType: "mouse", clientX: 10, clientY: 10 });
		expect(await screen.findByRole("tooltip")).toBeTruthy();
	});
});

describe("Workspace preview tab context menu", () => {
	const threeTabs = ["a.ts", "b.ts", "c.ts"].map((path) => ({
		path, name: path, isLoading: false, isEditing: false, isSaving: false, editBuffer: "", error: "", requestId: 1,
		file: { path, name: path, kind: "text" as const, mimeType: "text/plain", size: 1, updatedAt: "now", content: path },
	}));

	beforeEach(() => {
		workspaceStore.previewTabs = threeTabs.map((tab) => ({ ...tab }));
		workspaceStore.activePreviewPath = "b.ts";
		workspaceStore.streamingPreview = null;
		vi.spyOn(workspaceStore, "selectFile").mockResolvedValue();
	});

	afterEach(() => {
		cleanup();
		workspaceStore.previewTabs = [];
		workspaceStore.activePreviewPath = null;
		workspaceStore.streamingPreview = null;
		vi.restoreAllMocks();
	});

	it("closes other tabs from the context menu", () => {
		render(<WorkspacePreviewTabs />);
		fireEvent.contextMenu(screen.getByRole("tab", { name: "b.ts" }));
		fireEvent.click(screen.getByRole("menuitem", { name: "files.closeOtherTabs" }));
		expect(workspaceStore.previewTabs.map((tab) => tab.path)).toEqual(["b.ts"]);
		expect(workspaceStore.activePreviewPath).toBe("b.ts");
	});

	it("closes tabs to the right, reactivating the anchor when the active tab was closed", () => {
		workspaceStore.activePreviewPath = "c.ts";
		render(<WorkspacePreviewTabs />);
		fireEvent.contextMenu(screen.getByRole("tab", { name: "a.ts" }));
		fireEvent.click(screen.getByRole("menuitem", { name: "files.closeTabsToRight" }));
		expect(workspaceStore.previewTabs.map((tab) => tab.path)).toEqual(["a.ts"]);
		expect(workspaceStore.activePreviewPath).toBe("a.ts");
	});

	it("closes all tabs from the context menu", () => {
		render(<WorkspacePreviewTabs />);
		fireEvent.contextMenu(screen.getByRole("tab", { name: "c.ts" }));
		fireEvent.click(screen.getByRole("menuitem", { name: "files.closeAllTabs" }));
		expect(workspaceStore.previewTabs.filter(isStartTab)).toHaveLength(1);
		expect(isStartTabKey(workspaceStore.activePreviewPath)).toBe(true);
	});

	it("offers only close-all over the streaming tab without touching file tabs", () => {
		workspaceStore.streamingPreview = {
			id: "s1", title: "generated.ts", language: "ts", content: "x", status: "streaming", source: "assistant", createdAt: 0, updatedAt: 0,
		};
		render(<WorkspacePreviewTabs />);
		fireEvent.contextMenu(screen.getByRole("tab", { name: "generated.ts" }));
		expect(screen.queryByRole("menuitem", { name: "files.closeOtherTabs" })).toBeNull();
		fireEvent.click(screen.getByRole("menuitem", { name: "files.closeAllTabs" }));
		expect(workspaceStore.previewTabs).toEqual([]);
		expect(workspaceStore.activePreviewPath).toBeNull();
		expect(workspaceStore.streamingPreview?.title).toBe("generated.ts");
	});
});
