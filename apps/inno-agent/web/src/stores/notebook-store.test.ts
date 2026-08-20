import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	listWikiPages: vi.fn(),
	getWikiPage: vi.fn(),
	updateWikiPage: vi.fn(),
	deleteWikiPage: vi.fn(),
	getWikiGraph: vi.fn(),
	refreshPageEvidence: vi.fn(),
	removeStalePageEvidence: vi.fn(),
}));

vi.mock("../api/wiki.js", () => mocks);

import { NotebookStoreImpl } from "./notebook-store.js";
import type { WikiPageDetail } from "../types/wiki.js";

const PAGE_REVISION = `sha256:${"a".repeat(64)}`;
const FILE_REVISION = `sha256:${"b".repeat(64)}`;

function detail(content = "Original body", revisions = { pageRevision: PAGE_REVISION, fileRevision: FILE_REVISION }): WikiPageDetail {
	return {
		path: "wiki/concepts/page.md",
		content,
		...revisions,
		provenance: {
			sourceGroups: [{
				availability: "missing-source",
				sourceId: "legacy@example.com",
				references: [],
			}],
			legacyPaths: ["raw/legacy.md"],
			referenceIssues: [],
		},
	};
}

describe("NotebookStore page persistence", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.listWikiPages.mockResolvedValue([]);
		mocks.getWikiGraph.mockResolvedValue({ nodes: [], edges: [] });
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("keeps the complete page detail and clears an old error when switching pages", async () => {
		const next = detail();
		mocks.getWikiPage.mockResolvedValue(next);
		const store = new NotebookStoreImpl();
		store.saveError = "Previous save failed";

		await store.selectPage(next.path);

		expect(store.currentPage).toEqual(next);
		expect(store.currentPage?.provenance).toEqual(next.provenance);
		expect(store.saveError).toBeNull();
		expect(store.editBuffer).toBe(next.content);
	});

	it("does not let an older page request overwrite a newer selection", async () => {
		let resolveFirst!: (value: WikiPageDetail) => void;
		let resolveSecond!: (value: WikiPageDetail) => void;
		mocks.getWikiPage
			.mockReturnValueOnce(new Promise<WikiPageDetail>((resolve) => { resolveFirst = resolve; }))
			.mockReturnValueOnce(new Promise<WikiPageDetail>((resolve) => { resolveSecond = resolve; }));
		const first = detail("First response");
		const second = { ...detail("Second response"), path: "wiki/concepts/second.md" };
		const store = new NotebookStoreImpl();

		const firstRequest = store.selectPage("wiki/concepts/first.md");
		const secondRequest = store.selectPage(second.path);
		resolveSecond(second);
		await secondRequest;
		resolveFirst(first);
		await firstRequest;

		expect(store.currentPage).toEqual(second);
		expect(store.editBuffer).toBe(second.content);
		expect(store.isLoadingPage).toBe(false);
	});

	it("exposes a visible error when a page request fails", async () => {
		mocks.getWikiPage.mockRejectedValue(new Error("Summary page unavailable"));
		const store = new NotebookStoreImpl();

		await store.selectPage("wiki/sources/missing-summary.md");

		expect(store.currentPage).toBeNull();
		expect(store.pageLoadError).toBe("Summary page unavailable");
		expect(store.isLoadingPage).toBe(false);
	});

	it("preserves the origin page and edit buffer when a summary request fails", async () => {
		const origin = detail("Origin body");
		mocks.getWikiPage.mockRejectedValue(new Error("Summary page unavailable"));
		const store = new NotebookStoreImpl();
		store.currentPage = origin;
		store.editBuffer = "Unsaved origin edit";
		store.isEditing = true;
		store.selectedNodeId = origin.path;

		await store.selectPage("wiki/sources/missing-summary.md", { preserveCurrentOnError: true });

		expect(store.currentPage).toBe(origin);
		expect(store.editBuffer).toBe("Unsaved origin edit");
		expect(store.isEditing).toBe(true);
		expect(store.selectedNodeId).toBe(origin.path);
		expect(store.pageLoadError).toBe("Summary page unavailable");
		expect(store.isLoadingPage).toBe(false);
	});

	it("keeps edits visible and exposes a displayable error when saving fails", async () => {
		mocks.updateWikiPage.mockRejectedValue(new Error("Save request failed"));
		const store = new NotebookStoreImpl();
		store.currentPage = detail();
		store.editBuffer = "Unsaved edit";
		store.isEditing = true;
		vi.spyOn(console, "error").mockImplementation(() => undefined);

		await store.savePage();

		expect(store.currentPage?.content).toBe("Original body");
		expect(store.editBuffer).toBe("Unsaved edit");
		expect(store.isEditing).toBe(true);
		expect(store.saveError).toBe("Save request failed");
		expect(mocks.listWikiPages).not.toHaveBeenCalled();
		expect(mocks.getWikiGraph).not.toHaveBeenCalled();
	});

	it("adopts the returned detail and refreshes derived views after saving", async () => {
		const original = detail();
		const saved = detail("Saved body", {
			pageRevision: `sha256:${"c".repeat(64)}`,
			fileRevision: `sha256:${"d".repeat(64)}`,
		});
		mocks.updateWikiPage.mockResolvedValue(saved);
		const store = new NotebookStoreImpl();
		store.currentPage = original;
		store.editBuffer = "Saved body";
		store.isEditing = true;
		store.saveError = "Old failure";

		await store.savePage();

		expect(mocks.updateWikiPage).toHaveBeenCalledWith(original.path, "Saved body");
		expect(store.currentPage).toEqual(saved);
		expect(store.currentPage?.pageRevision).toBe(saved.pageRevision);
		expect(store.currentPage?.fileRevision).toBe(saved.fileRevision);
		expect(store.editBuffer).toBe(saved.content);
		expect(store.isEditing).toBe(false);
		expect(store.saveError).toBeNull();
		expect(mocks.listWikiPages).toHaveBeenCalledTimes(1);
		expect(mocks.getWikiGraph).toHaveBeenCalledTimes(1);
	});

	it("sends both page revisions when refreshing evidence and adopts the returned detail", async () => {
		const original = detail("Stale body");
		const refreshed = detail("Stale body", {
			pageRevision: `sha256:${"e".repeat(64)}`,
			fileRevision: `sha256:${"f".repeat(64)}`,
		});
		mocks.refreshPageEvidence.mockResolvedValue(refreshed);
		const store = new NotebookStoreImpl();
		store.currentPage = original;

		const promise = store.refreshEvidence();
		expect(store.mutationPending).toBe(true);
		expect(store.mutationError).toBeNull();
		await promise;

		expect(mocks.refreshPageEvidence).toHaveBeenCalledWith({
			path: original.path,
			expectedPageRevision: original.pageRevision,
			expectedFileRevision: original.fileRevision,
		});
		expect(store.currentPage).toEqual(refreshed);
		expect(store.mutationPending).toBe(false);
		expect(store.mutationError).toBeNull();
	});

	it("does not leak a rejected mutation into a page selected while it was pending", async () => {
		let rejectRefresh!: (error: Error) => void;
		mocks.refreshPageEvidence.mockReturnValue(new Promise<WikiPageDetail>((_resolve, reject) => {
			rejectRefresh = reject;
		}));
		const first = detail("First page");
		const second = detail("Second page", {
			pageRevision: `sha256:${"3".repeat(64)}`,
			fileRevision: `sha256:${"4".repeat(64)}`,
		});
		mocks.getWikiPage.mockResolvedValue(second);
		const store = new NotebookStoreImpl();
		store.currentPage = first;

		const mutation = store.refreshEvidence();
		await store.selectPage("wiki/concepts/second.md");
		rejectRefresh(new Error("old page failed"));
		await mutation;

		expect(store.currentPage).toEqual(second);
		expect(store.mutationError).toBeNull();
		expect(store.mutationPending).toBe(false);
	});

	it("keeps old evidence and exposes a visible mutation error when refresh fails", async () => {
		const original = detail("Keep this body");
		mocks.refreshPageEvidence.mockRejectedValue(new Error("Model unavailable"));
		const store = new NotebookStoreImpl();
		store.currentPage = original;

		await store.refreshEvidence();

		expect(store.currentPage).toEqual(original);
		expect(store.mutationPending).toBe(false);
		expect(store.mutationError).toBe("Model unavailable");
	});

	it("blocks evidence mutations while editing to avoid overwriting the edit buffer", async () => {
		const original = detail("Unsaved edit");
		const store = new NotebookStoreImpl();
		store.currentPage = original;
		store.editBuffer = "Unsaved local edit";
		store.isEditing = true;

		await store.removeStaleEvidence();

		expect(mocks.removeStalePageEvidence).not.toHaveBeenCalled();
		expect(store.currentPage).toEqual(original);
		expect(store.editBuffer).toBe("Unsaved local edit");
		expect(store.isEditing).toBe(true);
		expect(store.mutationError).toContain("Finish editing");
	});
});
