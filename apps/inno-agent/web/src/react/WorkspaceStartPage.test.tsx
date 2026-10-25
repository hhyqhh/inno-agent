import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workspaceStore, WORKSPACE_START_TAB, previewTabKey } from "../stores/workspace-store.js";
import { workspacesStore } from "../stores/workspaces-store.js";
import { WorkspaceStartPage } from "./WorkspaceStartPage.js";
import { renderWithTooltipProvider as render } from "./test-utils.js";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }) }));
beforeEach(() => {
	vi.spyOn(workspaceStore, "loadActivity").mockResolvedValue();
	workspaceStore.activity = { files: [], trackingIncomplete: false }; workspaceStore.activityError = "";
	workspacesStore.workspaces = [{ id: "current", name: "Current project" }, { id: "other", name: "Other project" }] as typeof workspacesStore.workspaces;
	workspaceStore.activeWorkspaceId = "current";
	workspaceStore.isLoadingTree = false; workspaceStore.error = "";
	workspaceStore.tree = { name: "Current project", path: "", root: "project", type: "directory", children: [
		{ name: "older.md", path: "docs/older.md", type: "file", updatedAt: "2026-10-01T10:00:00Z" },
		{ name: "newer.md", path: "docs/newer.md", type: "file", updatedAt: "2026-10-23T10:00:00Z" },
	] };
	workspaceStore.recentFiles = [
		{ workspaceId: "current", path: "recent.ts", name: "recent.ts", openedAt: Date.now() },
		{ workspaceId: "other", path: "private.md", name: "private.md", openedAt: Date.now() },
	];
	workspaceStore.previewTabs = [{ path: "draft.md", workspaceId: "current", name: "draft.md", isEditing: true, editBuffer: "unsaved draft", isSaving: false, isLoading: false, error: "", requestId: 1,
		file: { path: "draft.md", name: "draft.md", content: "original", updatedAt: "now", size: 8, kind: "markdown", mimeType: "text/markdown" } }];
	workspaceStore.openStartPage();
});
afterEach(() => {
	cleanup(); vi.restoreAllMocks(); delete document.documentElement.dataset.theme;
	workspaceStore.previewTabs = []; workspaceStore.activePreviewPath = null; workspaceStore.recentFiles = []; workspaceStore.tree = null; workspaceStore.error = "";
});
describe("File start page", () => {
	it.each(["light", "dark"])("shows real draft/recent/modified state in %s mode", (theme) => {
		document.documentElement.dataset.theme = theme; render(<WorkspaceStartPage />);
		expect(screen.getByRole("heading", { name: "workspaceStart.heading" })).toBeTruthy();
		expect(screen.queryByText("private.md")).toBeNull();
		const modified = screen.getByRole("region", { name: "workspaceStart.modified" });
		expect(within(modified).getAllByRole("button").map((button) => button.textContent)).toEqual([expect.stringContaining("newer.md"), expect.stringContaining("older.md")]);
		fireEvent.click(screen.getByRole("button", { name: /draft.md/ }));
		expect(workspaceStore.activePreviewPath).toBe(previewTabKey({ path: "draft.md", workspaceId: "current" })); expect(workspaceStore.editBuffer).toBe("unsaved draft");
		expect(workspaceStore.previewTabs.some((tab) => tab.path === WORKSPACE_START_TAB)).toBe(true);
	});
	it("filters by path and provides a useful no-results state", () => {
		render(<WorkspaceStartPage />);
		fireEvent.change(screen.getByRole("textbox", { name: "workspaceStart.search" }), { target: { value: "docs/" } });
		expect(screen.queryByText("recent.ts")).toBeNull(); expect(screen.getByText("newer.md")).toBeTruthy();
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "unmatched" } });
		expect(screen.getByRole("status").textContent).toBe("workspaceStart.noMatches");
	});
	it("revalidates a recent file and supports retrying a tree error", () => {
		const select = vi.spyOn(workspaceStore, "selectFile").mockResolvedValue();
		const reload = vi.spyOn(workspaceStore, "loadTree").mockResolvedValue();
		workspaceStore.error = "network"; render(<WorkspaceStartPage />);
		fireEvent.click(screen.getByRole("button", { name: /recent.ts/ })); expect(select).toHaveBeenCalledWith("recent.ts", undefined, "current");
		expect(screen.getByRole("alert").textContent).toBe("workspaceStart.loadFailed");
		fireEvent.click(screen.getByRole("button", { name: "workspaceStart.refresh" })); expect(reload).toHaveBeenCalledOnce();
	});
	it("shows other-workspace history only in All and opens with its owner", () => {
		const select = vi.spyOn(workspaceStore, "selectFile").mockResolvedValue();
		render(<WorkspaceStartPage />);
		fireEvent.click(screen.getByRole("radio", { name: "workspaceStart.scopeAll" }));
		fireEvent.click(screen.getByRole("button", { name: /private.md/ }));
		expect(select).toHaveBeenCalledWith("private.md", undefined, "other");
		expect(workspaceStore.activeWorkspaceId).toBe("current");
		expect(screen.getByText(/Other project/)).toBeTruthy();
	});
	it("deduplicates drafts, recent files and AI activity, and omits missing AI paths", () => {
		workspaceStore.recentFiles.unshift({ path: "draft.md", name: "draft.md", workspaceId: "current", openedAt: Date.now() });
		workspaceStore.activity.files = [{ path: "docs/newer.md", lastSeenAt: "2026-10-23" }, { path: "missing.md", lastSeenAt: "2026-10-23" }];
		render(<WorkspaceStartPage />);
		expect(screen.getAllByText("draft.md")).toHaveLength(1);
		expect(within(screen.getByRole("region", { name: "workspaceStart.aiActivity" })).getByText("newer.md")).toBeTruthy();
		expect(screen.getAllByText("newer.md")).toHaveLength(1);
		expect(screen.queryByText("missing.md")).toBeNull();
	});
});
