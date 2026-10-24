import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
	getWorkspaceTree: vi.fn(),
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

import { workspaceStore } from "./workspace-store.js";
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
		// Force setActiveWorkspace to run its full reset path even though the
		// singleton starts on the default workspace.
		workspaceStore.activeWorkspaceId = "reset";
		api.getWorkspaceTree.mockResolvedValue(TREE);
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

	it("opens one tab per file and reuses the tab on repeat selection", async () => {
		await workspaceStore.selectFile("a.ts");
		await workspaceStore.selectFile("b.md");
		await workspaceStore.selectFile("a.ts");
		expect(workspaceStore.previewTabs.map((tab) => tab.path)).toEqual(["a.ts", "b.md"]);
		expect(workspaceStore.activePreviewPath).toBe("a.ts");
		expect(api.getWorkspaceFile).toHaveBeenCalledTimes(2);
		expect(workspaceStore.previewTabs[0].file?.content).toBe("content of a.ts");
		expect(workspaceStore.previewTabs[1].file?.content).toBe("content of b.md");
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

	it("clears tabs when switching workspaces", async () => {
		await workspaceStore.selectFile("a.ts");
		await workspaceStore.setActiveWorkspace("ws-2");
		expect(workspaceStore.previewTabs).toEqual([]);
		expect(workspaceStore.activePreviewPath).toBeNull();
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
