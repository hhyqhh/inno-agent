import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
	getWorkspaceTree: vi.fn(),
	getWorkspaceActivity: vi.fn(),
	getWorkspaceFile: vi.fn(),
	createWorkspaceItem: vi.fn(),
	renameWorkspaceItem: vi.fn(),
	deleteWorkspaceItem: vi.fn(),
	moveWorkspaceItem: vi.fn(),
	uploadWorkspaceFiles: vi.fn(),
	saveWorkspaceFile: vi.fn(),
	uploadWorkspaceSkill: vi.fn(),
	inlineWorkspaceHtml: vi.fn(),
}));

vi.mock("../api/workspace.js", () => api);

import { workspaceStore, WorkspaceStoreImpl, isStartTab, isStartTabKey, previewTabKey } from "./workspace-store.js";
import type { WorkspaceFileDetail, WorkspaceTree } from "../types/workspace.js";

function fileDetail(path: string, content: string): WorkspaceFileDetail {
	return {
		path,
		name: path.split("/").pop() || path,
		kind: "text",
		mimeType: "text/plain",
		size: content.length,
		updatedAt: "2026-01-01T00:00:00.000Z",
		content,
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

const TREE: WorkspaceTree = {
	name: "Project", path: "", root: "project", type: "directory",
	children: [
		{ name: "a.ts", path: "a.ts", type: "file" },
		{ name: "b.md", path: "b.md", type: "file" },
		{ name: "docs", path: "docs", type: "directory", children: [] },
	],
};

describe("workspace preview tabs", () => {
	beforeEach(async () => {
		vi.clearAllMocks();
		workspaceStore.closeAllPreviews();
		workspaceStore.activeWorkspaceId = "reset";
		workspaceStore.recentFiles = [];
		api.getWorkspaceTree.mockResolvedValue(TREE);
		api.getWorkspaceActivity.mockResolvedValue({ files: [], trackingIncomplete: false });
		api.getWorkspaceFile.mockImplementation(async (path: string) => fileDetail(path, `content of ${path}`));
		api.saveWorkspaceFile.mockResolvedValue({ path: "", saved: true, size: 0, updatedAt: "" });
		await workspaceStore.setActiveWorkspace(null);
	});

	afterEach(() => {
		vi.resetAllMocks();
	});

	it("does not implicitly open a file when the tree loads", () => {
		expect(workspaceStore.previewTabs).toEqual([]);
		expect(workspaceStore.activePreviewPath).toBeNull();
	});
	it("keeps file drafts while visiting chat and selects preview for explicit file or start opens", async () => {
		await workspaceStore.selectFile("a.ts");
		workspaceStore.startEditing();
		workspaceStore.updateEditBuffer("draft");
		workspaceStore.setActiveSurface("conversation");
		expect(workspaceStore.editBuffer).toBe("draft");
		expect(workspaceStore.activePreviewPath).toBe("a.ts");
		workspaceStore.activatePreview("a.ts");
		expect(workspaceStore.activeSurface).toBe("preview");
		workspaceStore.setActiveSurface("conversation");
		workspaceStore.openStartPage();
		expect(workspaceStore.activeSurface).toBe("preview");
		expect(workspaceStore.previewTabs[0].editBuffer).toBe("draft");
	});
	it("does not steal focus from the conversation when a pending preview finishes loading", async () => {
		const pending = deferred<WorkspaceFileDetail>();
		api.getWorkspaceFile.mockReturnValueOnce(pending.promise);
		const opening = workspaceStore.selectFile("a.ts");
		workspaceStore.setActiveSurface("conversation");
		pending.resolve(fileDetail("a.ts", "loaded"));
		await opening;
		expect(workspaceStore.activeSurface).toBe("conversation");
		expect(workspaceStore.currentFile?.content).toBe("loaded");
	});
	it("keeps a single start page separate from files and retains drafts", async () => {
		await workspaceStore.selectFile("a.ts"); workspaceStore.startEditing(); workspaceStore.updateEditBuffer("draft");
		workspaceStore.openStartPage(); workspaceStore.openStartPage();
		expect(workspaceStore.previewTabs.filter((tab) => !isStartTab(tab)).map((tab) => tab.path)).toEqual(["a.ts"]);
		expect(workspaceStore.previewTabs.filter(isStartTab)).toHaveLength(1);
		expect(workspaceStore.currentFile).toBeNull();
		workspaceStore.activatePreview("a.ts");
		expect(workspaceStore.editBuffer).toBe("draft");
		expect(api.getWorkspaceFile).toHaveBeenCalledTimes(1);
	});
	it("opens a fresh start page per plus click while openStartPage reuses", () => {
		workspaceStore.newStartPage(); workspaceStore.newStartPage();
		expect(workspaceStore.previewTabs.filter(isStartTab)).toHaveLength(2);
		expect(workspaceStore.previewTabs[0].path).not.toBe(workspaceStore.previewTabs[1].path);
		expect(isStartTabKey(workspaceStore.activePreviewPath)).toBe(true);
		workspaceStore.openStartPage();
		expect(workspaceStore.previewTabs.filter(isStartTab)).toHaveLength(2);
	});
	it("navigates the active start tab in place when a file is opened from a start page", async () => {
		await workspaceStore.selectFile("a.ts"); workspaceStore.startEditing(); workspaceStore.updateEditBuffer("draft");
		workspaceStore.openStartPage();
		await workspaceStore.selectFile("b.md", undefined, null, { replaceStartTab: true });
		expect(workspaceStore.previewTabs.map((tab) => tab.path)).toEqual(["a.ts", "b.md"]);
		expect(workspaceStore.activePreviewPath).toBe("b.md");
		expect(workspaceStore.currentFile?.content).toBe("content of b.md");
		expect(workspaceStore.previewTabs[0].editBuffer).toBe("draft");
	});
	it("retires the start page and reuses the open tab when the file is already open", async () => {
		await workspaceStore.selectFile("a.ts");
		workspaceStore.openStartPage();
		await workspaceStore.selectFile("a.ts", undefined, null, { replaceStartTab: true });
		expect(workspaceStore.previewTabs).toHaveLength(1);
		expect(workspaceStore.activePreviewPath).toBe("a.ts");
		expect(workspaceStore.previewTabs.filter(isStartTab)).toHaveLength(0);
	});
	it("records successful opens once per file, scoped to the owning workspace", async () => {
		await workspaceStore.selectFile("a.ts"); await workspaceStore.selectFile("b.md"); workspaceStore.activatePreview("a.ts");
		expect(workspaceStore.recentFiles.map((file) => file.path)).toEqual(["a.ts", "b.md"]);
		api.getWorkspaceFile.mockRejectedValueOnce(new Error("missing")); await workspaceStore.selectFile("missing.txt");
		expect(workspaceStore.recentFiles).toHaveLength(2);
		await workspaceStore.setActiveWorkspace("other"); await workspaceStore.selectFile("a.ts");
		expect(workspaceStore.recentFiles.map((file) => file.workspaceId)).toEqual(["other", null, null]);
	});
	it("clears the previous workspace's tree before loading another start page", async () => {
		const pending = deferred<WorkspaceTree>(); api.getWorkspaceTree.mockReturnValueOnce(pending.promise);
		const load = workspaceStore.setActiveWorkspace("other");
		expect(workspaceStore.tree).toBeNull();
		pending.resolve(TREE); await load;
	});

	it("opens one tab per file and reuses the tab on repeat selection", async () => {
		await workspaceStore.selectFile("a.ts");
		await workspaceStore.selectFile("b.md");
		await workspaceStore.selectFile("a.ts");
		expect(workspaceStore.previewTabs.map((tab) => tab.path)).toEqual(["a.ts", "b.md"]);
		expect(workspaceStore.activePreviewPath).toBe("a.ts");
		expect(api.getWorkspaceFile).toHaveBeenCalledTimes(3);
		expect(workspaceStore.previewTabs[0].file?.content).toBe("content of a.ts");
		expect(workspaceStore.previewTabs[1].file?.content).toBe("content of b.md");
	});

	it("reloads an existing tab after an external file update without duplicating it", async () => {
		await workspaceStore.selectFile("a.ts");
		api.getWorkspaceFile.mockResolvedValueOnce(fileDetail("a.ts", "updated by agent"));
		await workspaceStore.loadTree();
		await workspaceStore.selectFile("a.ts");
		expect(workspaceStore.previewTabs).toHaveLength(1);
		expect(workspaceStore.currentFile?.content).toBe("updated by agent");
	});

	it("does not replace an editing tab's content or draft when the file is reopened", async () => {
		await workspaceStore.selectFile("a.ts");
		workspaceStore.startEditing();
		workspaceStore.updateEditBuffer("unsaved draft");
		await workspaceStore.selectFile("b.md");
		await workspaceStore.selectFile("a.ts");
		expect(workspaceStore.currentFile?.content).toBe("content of a.ts");
		expect(workspaceStore.editBuffer).toBe("unsaved draft");
		expect(workspaceStore.isEditing).toBe(true);
		expect(api.getWorkspaceFile).toHaveBeenCalledTimes(2);
	});

	it("does not let an earlier load overwrite a newer file-open response", async () => {
		const oldRead = deferred<WorkspaceFileDetail>();
		api.getWorkspaceFile.mockReturnValueOnce(oldRead.promise);
		const loading = workspaceStore.selectFile("a.ts");
		api.getWorkspaceFile.mockResolvedValueOnce(fileDetail("a.ts", "latest content"));
		await workspaceStore.selectFile("a.ts");
		oldRead.resolve(fileDetail("a.ts", "old content"));
		await loading;
		expect(workspaceStore.previewTabs).toHaveLength(1);
		expect(workspaceStore.currentFile?.content).toBe("latest content");
		expect(workspaceStore.isLoadingFile).toBe(false);
	});

	it("keeps per-tab edit drafts across tab switches", async () => {
		await workspaceStore.selectFile("a.ts");
		workspaceStore.startEditing();
		workspaceStore.updateEditBuffer("draft a");
		await workspaceStore.selectFile("b.md");
		workspaceStore.startEditing();
		workspaceStore.updateEditBuffer("draft b");
		workspaceStore.activatePreview("a.ts");
		expect(workspaceStore.editBuffer).toBe("draft a");
		expect(workspaceStore.isEditing).toBe(true);
		workspaceStore.activatePreview("b.md");
		expect(workspaceStore.editBuffer).toBe("draft b");
	});

	it("closing a tab activates its neighbour and closing the last clears the selection", async () => {
		await workspaceStore.selectFile("a.ts");
		await workspaceStore.selectFile("b.md");
		await workspaceStore.selectFile("c.ts");
		workspaceStore.closePreview("c.ts");
		expect(workspaceStore.activePreviewPath).toBe("b.md");
		workspaceStore.closePreview("b.md");
		expect(workspaceStore.activePreviewPath).toBe("a.ts");
		workspaceStore.closePreview("a.ts");
		expect(workspaceStore.activePreviewPath).toBeNull();
		expect(workspaceStore.previewTabs).toEqual([]);
	});

	it("closeOtherPreviews keeps only the anchor tab and reactivates it when active was closed", async () => {
		await workspaceStore.selectFile("a.ts");
		await workspaceStore.selectFile("b.md");
		await workspaceStore.selectFile("docs/c.ts");
		workspaceStore.activatePreview("b.md");
		workspaceStore.closeOtherPreviews("a.ts");
		expect(workspaceStore.previewTabs.map((tab) => tab.path)).toEqual(["a.ts"]);
		expect(workspaceStore.activePreviewPath).toBe("a.ts");
	});

	it("closePreviewsToRight drops later tabs but keeps the active tab when it survives", async () => {
		await workspaceStore.selectFile("a.ts");
		await workspaceStore.selectFile("b.md");
		await workspaceStore.selectFile("docs/c.ts");
		workspaceStore.activatePreview("a.ts");
		workspaceStore.closePreviewsToRight("b.md");
		expect(workspaceStore.previewTabs.map((tab) => tab.path)).toEqual(["a.ts", "b.md"]);
		expect(workspaceStore.activePreviewPath).toBe("a.ts");
		await workspaceStore.selectFile("docs/c.ts");
		workspaceStore.activatePreview("docs/c.ts");
		workspaceStore.closePreviewsToRight("b.md");
		expect(workspaceStore.previewTabs.map((tab) => tab.path)).toEqual(["a.ts", "b.md"]);
		expect(workspaceStore.activePreviewPath).toBe("b.md");
	});

	it("closeAllPreviews clears every tab and the active selection", async () => {
		await workspaceStore.selectFile("a.ts");
		await workspaceStore.selectFile("b.md");
		workspaceStore.closeAllPreviews();
		expect(workspaceStore.previewTabs).toEqual([]);
		expect(workspaceStore.activePreviewPath).toBeNull();
	});

	it("wordEditCloseGuard vetoes closing the protected tab and survives bulk closes", async () => {
		await workspaceStore.selectFile("a.ts");
		await workspaceStore.selectFile("b.md");
		await workspaceStore.selectFile("docs/c.ts");
		const guarded = previewTabKey({ path: "b.md", workspaceId: null });
		workspaceStore.wordEditCloseGuard = (tabKey) => tabKey === guarded;
		try {
			workspaceStore.closePreview(guarded);
			expect(workspaceStore.previewTabs.map((tab) => tab.path)).toEqual(["a.ts", "b.md", "docs/c.ts"]);
			workspaceStore.closeOtherPreviews("docs/c.ts");
			expect(workspaceStore.previewTabs.map((tab) => tab.path)).toEqual(["b.md", "docs/c.ts"]);
			workspaceStore.closeAllPreviews();
			expect(workspaceStore.previewTabs.map((tab) => tab.path)).toEqual(["b.md"]);
			expect(workspaceStore.activePreviewPath).toBe(guarded);
		} finally {
			workspaceStore.wordEditCloseGuard = null;
		}
		workspaceStore.closePreview(guarded);
		expect(workspaceStore.previewTabs).toEqual([]);
	});

	it("follows renames in open tabs, including the active path", async () => {
		await workspaceStore.selectFile("docs/a.ts");
		api.renameWorkspaceItem.mockResolvedValue({});
		await workspaceStore.renameItem("docs/a.ts", "b.ts");
		expect(api.renameWorkspaceItem).toHaveBeenCalledWith("docs/a.ts", "docs/b.ts", undefined);
		expect(workspaceStore.previewTabs[0].path).toBe("docs/b.ts");
		expect(workspaceStore.previewTabs[0].name).toBe("b.ts");
		expect(workspaceStore.activePreviewPath).toBe("docs/b.ts");
	});

	it("closes tabs under a deleted directory", async () => {
		await workspaceStore.selectFile("docs/a.ts");
		await workspaceStore.selectFile("b.md");
		api.deleteWorkspaceItem.mockResolvedValue({ deleted: true, path: "docs" });
		await workspaceStore.deleteItem("docs");
		expect(workspaceStore.previewTabs.map((tab) => tab.path)).toEqual(["b.md"]);
		expect(workspaceStore.activePreviewPath).toBe("b.md");
	});

	it("retains tabs and drafts across workspaces and saves to the tab's owner", async () => {
		await workspaceStore.selectFile("a.ts");
		workspaceStore.startEditing(); workspaceStore.updateEditBuffer("original workspace draft");
		await workspaceStore.setActiveWorkspace("ws-2");
		expect(workspaceStore.previewTabs).toHaveLength(1);
		expect(workspaceStore.editBuffer).toBe("original workspace draft");
		await workspaceStore.selectFile("a.ts");
		expect(workspaceStore.previewTabs).toHaveLength(2);
		expect(workspaceStore.currentFileWorkspaceId).toBe("ws-2");
		workspaceStore.startEditing(); workspaceStore.updateEditBuffer("second workspace draft");
		await workspaceStore.setActiveWorkspace("ws-3");
		await workspaceStore.saveFile();
		expect(api.saveWorkspaceFile).toHaveBeenCalledWith("a.ts", "second workspace draft", "ws-2");
		workspaceStore.activatePreview("a.ts");
		expect(workspaceStore.editBuffer).toBe("original workspace draft");
		workspaceStore.closePreview(previewTabKey({ path: "a.ts", workspaceId: "ws-2" }));
		expect(workspaceStore.previewTabs).toHaveLength(1);
		expect(workspaceStore.editBuffer).toBe("original workspace draft");
	});

	it("opens another workspace's file without changing the current file tree", async () => {
		await workspaceStore.selectFile("a.ts", undefined, "other");
		expect(api.getWorkspaceFile).toHaveBeenCalledWith("a.ts", "other");
		expect(workspaceStore.activeWorkspaceId).toBeNull();
		expect(workspaceStore.currentFileWorkspaceId).toBe("other");
		expect(workspaceStore.recentFiles[0].workspaceId).toBe("other");
	});

	it.each(["rename", "move", "delete"] as const)("keeps %s scoped to its original workspace across navigation", async (operation) => {
		await workspaceStore.selectFile("a.ts");
		await workspaceStore.selectFile("a.ts", undefined, "other");
		workspaceStore.startEditing(); workspaceStore.updateEditBuffer("foreign draft");
		const pending = deferred<object>();
		const mutation = operation === "rename" ? api.renameWorkspaceItem : operation === "move" ? api.moveWorkspaceItem : api.deleteWorkspaceItem;
		mutation.mockReturnValueOnce(pending.promise);
		const changing = operation === "rename" ? workspaceStore.renameItem("a.ts", "b.ts") : operation === "move" ? workspaceStore.moveItem("a.ts", "docs") : workspaceStore.deleteItem("a.ts");
		await workspaceStore.setActiveWorkspace("other");
		pending.resolve({}); await changing;
		expect(workspaceStore.currentFile?.path).toBe("a.ts");
		expect(workspaceStore.currentFileWorkspaceId).toBe("other");
		expect(workspaceStore.editBuffer).toBe("foreign draft");
		expect(workspaceStore.previewTabs.filter((tab) => tab.workspaceId === "other")).toHaveLength(1);
		expect(workspaceStore.previewTabs.find((tab) => !tab.workspaceId)?.path).toBe(operation === "delete" ? undefined : operation === "rename" ? "b.ts" : "docs/a.ts");
		expect(workspaceStore.recentFiles.find((file) => file.workspaceId === "other")?.path).toBe("a.ts");
	});

	it("finishes an owning tab's pending load after navigating without replacing the new selection", async () => {
		const pending = deferred<WorkspaceFileDetail>();
		api.getWorkspaceFile.mockReturnValueOnce(pending.promise);
		const opening = workspaceStore.selectFile("a.ts");
		await workspaceStore.setActiveWorkspace("other");
		await workspaceStore.selectFile("a.ts");
		pending.resolve(fileDetail("a.ts", "first workspace")); await opening;
		expect(workspaceStore.currentFileWorkspaceId).toBe("other");
		expect(workspaceStore.currentFile?.content).toBe("content of a.ts");
		workspaceStore.activatePreview("a.ts");
		expect(workspaceStore.currentFile?.content).toBe("first workspace");
	});

	it("persists successful open history and ignores malformed stored data", async () => {
		const storage = new Map<string, string>();
		vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
		await workspaceStore.selectFile("a.ts", undefined, "other");
		expect(new WorkspaceStoreImpl().recentFiles).toMatchObject([{ path: "a.ts", workspaceId: "other" }]);
		storage.set("inno.recentWorkspaceFiles", '[{"path":"../secret","name":"secret","workspaceId":"other","openedAt":1}]');
		expect(new WorkspaceStoreImpl().recentFiles).toEqual([]);
		storage.set("inno.recentWorkspaceFiles", "invalid json");
		expect(new WorkspaceStoreImpl().recentFiles).toEqual([]);
		vi.unstubAllGlobals();
	});

	it("ignores old workspace activity responses after navigation", async () => {
		const pending = deferred<{ files: { path: string; lastSeenAt: string }[]; trackingIncomplete: boolean }>();
		api.getWorkspaceActivity.mockReturnValueOnce(pending.promise);
		const loading = workspaceStore.loadActivity();
		await workspaceStore.setActiveWorkspace("other");
		pending.resolve({ files: [{ path: "old.md", lastSeenAt: "2026-10-25" }], trackingIncomplete: false });
		await loading;
		expect(workspaceStore.activity.files).toEqual([]);
	});

	it("keeps a save owned by its tab when the user switches away mid-save", async () => {
		await workspaceStore.selectFile("a.ts");
		await workspaceStore.selectFile("b.md");
		workspaceStore.activatePreview("a.ts");
		workspaceStore.startEditing();
		workspaceStore.updateEditBuffer("new a");
		let resolveSave!: (value: { path: string; saved: boolean; size: number; updatedAt: string }) => void;
		api.saveWorkspaceFile.mockReturnValue(new Promise((resolve) => { resolveSave = resolve; }));
		const saving = workspaceStore.saveFile();
		// The active tab changes while the save request is still in flight.
		workspaceStore.activatePreview("b.md");
		api.getWorkspaceFile.mockImplementation(async (path: string) => fileDetail(path, `saved ${path}`));
		resolveSave({ path: "a.ts", saved: true, size: 5, updatedAt: "2026-01-01T00:00:00.000Z" });
		await saving;
		const tabA = workspaceStore.previewTabs[0];
		expect(tabA.file?.content).toBe("saved a.ts");
		expect(tabA.isEditing).toBe(false);
		expect(tabA.editBuffer).toBe("");
		const tabB = workspaceStore.previewTabs[1];
		expect(tabB.file?.content).toBe("content of b.md");
		expect(tabB.isEditing).toBe(false);
	});

	it("reports load errors on the tab without dropping it", async () => {
		api.getWorkspaceFile.mockRejectedValueOnce(new Error("boom"));
		await workspaceStore.selectFile("a.ts");
		expect(workspaceStore.previewTabs).toHaveLength(1);
		expect(workspaceStore.previewTabs[0].error).toBe("boom");
		expect(workspaceStore.previewTabs[0].isLoading).toBe(false);
	});

	it.each(["rename", "move"] as const)("ignores stale save readback after a %s and saves the retained draft at its new path", async (operation) => {
		await workspaceStore.selectFile("a.ts");
		workspaceStore.startEditing();
		workspaceStore.updateEditBuffer("saved draft");
		const readback = deferred<WorkspaceFileDetail>();
		api.getWorkspaceFile.mockReturnValueOnce(readback.promise);
		const saving = workspaceStore.saveFile();
		await vi.waitFor(() => expect(api.getWorkspaceFile).toHaveBeenCalledTimes(2));
		const newPath = operation === "rename" ? "renamed.ts" : "docs/a.ts";
		if (operation === "rename") await workspaceStore.renameItem("a.ts", "renamed.ts");
		else await workspaceStore.moveItem("a.ts", "docs");
		readback.resolve(fileDetail("a.ts", "stale save response"));
		await saving;
		expect(workspaceStore.activePreviewPath).toBe(newPath);
		expect(workspaceStore.currentFile?.path).toBe(newPath);
		expect(workspaceStore.editBuffer).toBe("saved draft");
		expect(workspaceStore.isEditing).toBe(true);
		expect(workspaceStore.isSaving).toBe(false);
		await workspaceStore.saveFile();
		expect(api.saveWorkspaceFile).toHaveBeenLastCalledWith(newPath, "saved draft", undefined);
	});

	it("does not read the old path when a rename completes while the save request is pending", async () => {
		await workspaceStore.selectFile("a.ts");
		workspaceStore.startEditing();
		workspaceStore.updateEditBuffer("draft");
		const write = deferred<unknown>();
		api.saveWorkspaceFile.mockReturnValueOnce(write.promise);
		const saving = workspaceStore.saveFile();
		await workspaceStore.renameItem("a.ts", "renamed.ts");
		write.resolve({ saved: true });
		await saving;
		expect(api.getWorkspaceFile).toHaveBeenCalledTimes(1);
		expect(workspaceStore.currentFile?.path).toBe("renamed.ts");
		expect(workspaceStore.editBuffer).toBe("draft");
		expect(workspaceStore.isSaving).toBe(false);
	});

	it("does not attach an old path's readback error to a renamed tab", async () => {
		await workspaceStore.selectFile("a.ts");
		workspaceStore.startEditing();
		workspaceStore.updateEditBuffer("draft");
		const readback = deferred<WorkspaceFileDetail>();
		api.getWorkspaceFile.mockReturnValueOnce(readback.promise);
		const saving = workspaceStore.saveFile();
		await vi.waitFor(() => expect(api.getWorkspaceFile).toHaveBeenCalledTimes(2));
		await workspaceStore.renameItem("a.ts", "renamed.ts");
		readback.reject(new Error("File not found"));
		await saving;
		expect(workspaceStore.previewError).toBe("");
		expect(workspaceStore.currentFile?.path).toBe("renamed.ts");
		expect(workspaceStore.editBuffer).toBe("draft");
		expect(workspaceStore.isSaving).toBe(false);
	});

	it("replaces a streaming preview once a real file is selected", async () => {
		workspaceStore.startStreamingPreview({ id: "s1", title: "Generated", content: "..." });
		workspaceStore.updateStreamingPreview("s1", { content: "more" });
		workspaceStore.finishStreamingPreview("s1");
		expect(workspaceStore.streamingPreview?.status).toBe("done");
		await workspaceStore.selectFile("a.ts");
		expect(workspaceStore.streamingPreview).toBeNull();
		expect(workspaceStore.activePreviewPath).toBe("a.ts");
	});
});
