import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workspaceStore, isStartTab, previewTabKey } from "../stores/workspace-store.js";
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
	vi.useRealTimers();
	workspaceStore.previewTabs = []; workspaceStore.activePreviewPath = null; workspaceStore.recentFiles = []; workspaceStore.tree = null; workspaceStore.error = "";
});
describe("File start page", () => {
	it.each(["light", "dark"])("merges recent and modified files and preserves drafts in %s mode", (theme) => {
		document.documentElement.dataset.theme = theme; render(<WorkspaceStartPage />);
		expect(screen.getByRole("heading", { name: "workspaceStart.heading" })).toBeTruthy();
		expect(screen.queryByText("private.md")).toBeNull();
		const recent = screen.getByRole("region", { name: "workspaceStart.recent" });
		expect(within(recent).getAllByRole("button").map((button) => button.textContent)).toEqual([expect.stringContaining("recent.ts"), expect.stringContaining("newer.md"), expect.stringContaining("older.md")]);
		fireEvent.click(screen.getByRole("button", { name: /draft.md/ }));
		expect(workspaceStore.activePreviewPath).toBe(previewTabKey({ path: "draft.md", workspaceId: "current" })); expect(workspaceStore.editBuffer).toBe("unsaved draft");
		expect(workspaceStore.previewTabs.some(isStartTab)).toBe(true);
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
		fireEvent.click(screen.getByRole("button", { name: /recent.ts/ })); expect(select).toHaveBeenCalledWith("recent.ts", undefined, "current", { replaceStartTab: true });
		expect(screen.getByRole("alert").textContent).toBe("workspaceStart.loadFailed");
		fireEvent.click(screen.getByRole("button", { name: "workspaceStart.refresh" })); expect(reload).toHaveBeenCalledOnce();
	});
	it("shows other-workspace history only in All and opens with its owner", () => {
		const select = vi.spyOn(workspaceStore, "selectFile").mockResolvedValue();
		render(<WorkspaceStartPage />);
		fireEvent.click(screen.getByRole("radio", { name: "workspaceStart.scopeAll" }));
		fireEvent.click(screen.getByRole("button", { name: /private.md/ }));
		expect(select).toHaveBeenCalledWith("private.md", undefined, "other", { replaceStartTab: true });
		expect(workspaceStore.activeWorkspaceId).toBe("current");
		expect(screen.getByText(/Other project/)).toBeTruthy();
	});
	it("retains AI provenance when merging recent files and omits missing AI paths", () => {
		workspaceStore.recentFiles.unshift({ path: "draft.md", name: "draft.md", workspaceId: "current", openedAt: Date.now() });
		workspaceStore.recentFiles.unshift({ path: "docs/newer.md", name: "newer.md", workspaceId: "current", openedAt: Date.now() + 1000 });
		workspaceStore.activity.files = [{ path: "docs/newer.md", lastSeenAt: "2026-10-23" }, { path: "missing.md", lastSeenAt: "2026-10-23" }];
		render(<WorkspaceStartPage />);
		expect(screen.getAllByText("draft.md")).toHaveLength(1);
		const newer = screen.getByRole("button", { name: /newer.md/ });
		expect(within(newer).getByText("workspaceStart.aiBadge")).toBeTruthy();
		expect(within(newer).getByText("workspaceStart.opened")).toBeTruthy();
		expect(screen.getAllByText("newer.md")).toHaveLength(1);
		expect(screen.queryByText("missing.md")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "workspaceStart.aiFilter" }));
		expect(screen.getByText("newer.md")).toBeTruthy();
		expect(screen.queryByText("recent.ts")).toBeNull();
		expect(screen.queryByText("draft.md")).toBeNull();
	});
	it("defaults to six files, expands all remaining files and can collapse again", () => {
		workspaceStore.recentFiles = Array.from({ length: 14 }, (_, index) => ({ workspaceId: "current", path: `file-${index}.md`, name: `file-${index}.md`, openedAt: Date.now() - index * 1000 }));
		render(<WorkspaceStartPage />);
		const recent = screen.getByRole("region", { name: "workspaceStart.recent" });
		expect(within(recent).getAllByRole("button", { name: /file-\d+\.md/ })).toHaveLength(6);
		expect(screen.queryByText("file-13.md")).toBeNull();
		const expand = screen.getByRole("button", { name: "workspaceStart.showMore" });
		expect(expand.getAttribute("aria-expanded")).toBe("false");
		expect(document.getElementById(expand.getAttribute("aria-controls")!)).toBeTruthy();
		fireEvent.click(expand);
		expect(screen.getByText("file-13.md")).toBeTruthy();
		expect(screen.getByText("older.md")).toBeTruthy();
		expect(within(recent).getAllByRole("button", { name: /file-\d+\.md/ })).toHaveLength(14);
		const collapse = screen.getByRole("button", { name: "workspaceStart.showLess" });
		expect(collapse.getAttribute("aria-expanded")).toBe("true");
		fireEvent.click(collapse);
		expect(within(recent).getAllByRole("button", { name: /file-\d+\.md/ })).toHaveLength(6);
	});
	it("searches beyond the folded rows and resets expansion when the search changes", () => {
		workspaceStore.recentFiles = Array.from({ length: 14 }, (_, index) => ({ workspaceId: "current", path: `file-${index}.md`, name: `file-${index}.md`, openedAt: Date.now() - index * 1000 }));
		render(<WorkspaceStartPage />);
		fireEvent.click(screen.getByRole("button", { name: "workspaceStart.showMore" }));
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "file-13" } });
		expect(screen.getByText("file-13.md")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "workspaceStart.showLess" })).toBeNull();
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
		expect(screen.queryByText("file-13.md")).toBeNull();
		expect(screen.getByRole("button", { name: "workspaceStart.showMore" }).getAttribute("aria-expanded")).toBe("false");
	});
	it("applies file-type filters to drafts and all recent sources", () => {
		const names = ["report.DOCX", "guide.pdf", "slides.pptx", "table.xlsx", "photo.png"];
		workspaceStore.recentFiles = names.map((name) => ({ workspaceId: "current", path: name, name, openedAt: Date.now() }));
		render(<WorkspaceStartPage />);
		fireEvent.click(screen.getByRole("button", { name: "workspaceStart.types.doc" }));
		expect(screen.getByText("report.DOCX")).toBeTruthy();
		expect(screen.getByText("guide.pdf")).toBeTruthy();
		expect(screen.getByText("draft.md")).toBeTruthy();
		expect(screen.queryByText("slides.pptx")).toBeNull();
		for (const [kind, file] of [["ppt", "slides.pptx"], ["xls", "table.xlsx"], ["image", "photo.png"]]) {
			const filter = screen.getByRole("button", { name: `workspaceStart.types.${kind}` });
			fireEvent.click(filter);
			expect(filter.getAttribute("aria-pressed")).toBe("true");
			expect(screen.getByText(file)).toBeTruthy();
			expect(screen.queryByText("draft.md")).toBeNull();
			expect(screen.queryByText("newer.md")).toBeNull();
		}
	});
	it("uses the same workspace scope for drafts and recent files and distinguishes equal paths", () => {
		workspaceStore.previewTabs.push({ ...workspaceStore.previewTabs[0], name: "other-draft.md", path: "other-draft.md", workspaceId: "other" });
		workspaceStore.recentFiles.push({ workspaceId: "other", name: "recent.ts", path: "recent.ts", openedAt: Date.now() });
		render(<WorkspaceStartPage />);
		expect(screen.queryByText("other-draft.md")).toBeNull();
		fireEvent.click(screen.getByRole("radio", { name: "workspaceStart.scopeAll" }));
		expect(screen.getByText("other-draft.md")).toBeTruthy();
		expect(screen.getAllByText("recent.ts")).toHaveLength(2);
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "Other project" } });
		expect(screen.getAllByText("recent.ts")).toHaveLength(1);
		expect(screen.queryByText("draft.md")).toBeNull();
	});
	it("labels temporary workspaces clearly and omits repeated root-directory text", () => {
		workspaceStore.activeWorkspaceId = null;
		workspaceStore.tree!.name = ".tmp";
		workspaceStore.recentFiles = [{ workspaceId: null, name: "temp.docx", path: "temp.docx", openedAt: Date.now() }];
		render(<WorkspaceStartPage />);
		expect(screen.getByText("workspace.tempWorkspaceLabel")).toBeTruthy();
		expect(screen.queryByText(".tmp")).toBeNull();
		expect(screen.queryByText("workspaceStart.rootFolder")).toBeNull();
		expect(screen.getByText("temp.docx")).toBeTruthy();
	});
	it("ignores invalid timestamps without breaking the remaining file list", () => {
		workspaceStore.recentFiles.push({ workspaceId: "current", path: "invalid.md", name: "invalid.md", openedAt: 1e16 });
		workspaceStore.tree!.children.push({ path: "invalid-tree.md", name: "invalid-tree.md", type: "file", updatedAt: "not-a-date" });
		render(<WorkspaceStartPage />);
		expect(screen.getByText("recent.ts")).toBeTruthy();
		expect(screen.queryByText("invalid.md")).toBeNull();
		expect(screen.queryByText("invalid-tree.md")).toBeNull();
	});
	it("groups files by local day using the latest opened, modified or AI-write event", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 9, 29, 12));
		workspaceStore.recentFiles = [{ workspaceId: "current", name: "recent.ts", path: "recent.ts", openedAt: new Date(2026, 9, 28, 10).getTime() }];
		workspaceStore.tree!.children.push({ name: "ai.md", path: "ai.md", type: "file", updatedAt: new Date(2026, 9, 27).toISOString() });
		workspaceStore.activity.files = [{ path: "ai.md", lastSeenAt: new Date(2026, 9, 29, 11).toISOString() }];
		render(<WorkspaceStartPage />);
		expect(within(screen.getByRole("group", { name: "workspaceStart.today" })).getByText("ai.md")).toBeTruthy();
		expect(within(screen.getByRole("group", { name: "workspaceStart.yesterday" })).getByText("recent.ts")).toBeTruthy();
		expect(within(screen.getByRole("group", { name: "workspaceStart.earlier" })).getByText("older.md")).toBeTruthy();
		expect(within(screen.getByRole("button", { name: /ai.md/ })).getByText("workspaceStart.aiUpdated")).toBeTruthy();
	});
});
