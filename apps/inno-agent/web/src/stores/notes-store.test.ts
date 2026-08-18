import { afterEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
	archiveNote: vi.fn(),
	createNote: vi.fn(),
	deleteNoteAttachment: vi.fn(),
	deleteNoteItem: vi.fn(),
	fetchNoteContent: vi.fn(),
	fetchRawContent: vi.fn(),
	listNotes: vi.fn(),
	saveNoteContent: vi.fn(),
	saveRawMarkdownContent: vi.fn(),
	unarchiveNote: vi.fn(),
	uploadNoteAttachment: vi.fn(),
	uploadNoteFile: vi.fn(),
}));
vi.mock("../api/notes.js", () => apiMocks);

import { notesStore } from "./notes-store.js";
import type { NoteSummary } from "../types/notes.js";

const archivedMarkdown: NoteSummary = {
	noteId: "l2src_test",
	sourceId: "l2src_test",
	rawPath: "raw/uploads/source.md",
	title: "Source",
	tags: [],
	notebookType: "file",
	contentType: "markdown",
	status: "indexed",
	kind: "archived",
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
};

afterEach(() => {
	for (const mock of Object.values(apiMocks)) mock.mockReset();
	notesStore.notes = [];
	notesStore.selected = null;
	notesStore.previewContent = "";
	notesStore.savedPreviewContent = "";
	notesStore.isLoading = false;
	notesStore.isLoadingPreview = false;
	notesStore.isSaving = false;
	notesStore.isDeleting = false;
	notesStore.error = null;
	notesStore.notice = null;
	notesStore.listBox = "drafts";
	notesStore.searchQuery = "";
	notesStore.filterTag = null;
});

describe("notesStore tag filtering", () => {
	it("summarizes and filters tags in the active list", () => {
		notesStore.notes = [
			{ ...archivedMarkdown, kind: "markdown", status: "draft", rawPath: "raw/notes/a.md", tags: ["AI", "TypeScript"] },
			{ ...archivedMarkdown, kind: "markdown", status: "draft", rawPath: "raw/notes/b.md", tags: ["ai"] },
			{ ...archivedMarkdown, kind: "markdown", status: "indexed", rawPath: "raw/notes/c.md", tags: ["AI"] },
		];

		expect(notesStore.tagSummaries).toEqual([
			{ displayName: "AI", usageCount: 2 },
			{ displayName: "TypeScript", usageCount: 1 },
		]);
		notesStore.setFilterTag("ai");
		expect(notesStore.filteredNotes.map((note) => note.rawPath)).toEqual(["raw/notes/a.md", "raw/notes/b.md"]);
	});
});

describe("notesStore raw Markdown editing", () => {
	it("loads the full source, saves edits, and marks the selected item outdated", async () => {
		apiMocks.fetchRawContent.mockResolvedValue("# Original\n");
		apiMocks.saveRawMarkdownContent.mockResolvedValue({
			rawPath: archivedMarkdown.rawPath,
			status: "outdated",
		});
		const outdated = { ...archivedMarkdown, status: "outdated" as const };
		apiMocks.listNotes.mockResolvedValue({ notes: [outdated] });

		await notesStore.selectNote(archivedMarkdown);
		expect(apiMocks.fetchRawContent).toHaveBeenCalledWith(archivedMarkdown.rawPath, { full: true });
		notesStore.updatePreviewContent("# Updated\n");
		expect(notesStore.isDirty).toBe(true);

		await expect(notesStore.saveSelected()).resolves.toBe(true);
		expect(apiMocks.saveRawMarkdownContent).toHaveBeenCalledWith({
			rawPath: archivedMarkdown.rawPath,
			content: "# Updated\n",
		});
		expect(notesStore.selected?.status).toBe("outdated");
		expect(notesStore.isDirty).toBe(false);
	});
});

describe("notesStore item deletion", () => {
	it("clears the selection after deleting an unarchived item", async () => {
		apiMocks.fetchRawContent.mockResolvedValue("draft");
		apiMocks.deleteNoteItem.mockResolvedValue({ rawPath: archivedMarkdown.rawPath, title: "Source" });
		apiMocks.listNotes.mockResolvedValue({ notes: [] });
		const orphan = { ...archivedMarkdown, kind: "orphan" as const, status: "uploaded" as const };

		await notesStore.selectNote(orphan);
		await expect(notesStore.deleteSelected()).resolves.toBe(true);
		expect(apiMocks.deleteNoteItem).toHaveBeenCalledWith(orphan.rawPath);
		expect(notesStore.selected).toBeNull();
		expect(notesStore.notice).toBe("deleted");
	});
});

describe("notesStore unarchive", () => {
	it("moves the returned item back to drafts and keeps success feedback", async () => {
		apiMocks.unarchiveNote.mockResolvedValue({
			rawPath: archivedMarkdown.rawPath,
			title: archivedMarkdown.title,
			removedWikiPages: [],
			backupPaths: [],
			status: "uploaded",
		});
		const orphan = { ...archivedMarkdown, kind: "orphan" as const, status: "uploaded" as const };
		apiMocks.listNotes.mockResolvedValue({ notes: [orphan] });
		apiMocks.fetchRawContent.mockResolvedValue("source");
		notesStore.selected = archivedMarkdown;

		await expect(notesStore.unarchiveSelected()).resolves.toBe(true);
		expect(apiMocks.unarchiveNote).toHaveBeenCalledWith(archivedMarkdown.rawPath);
		expect(notesStore.listBox).toBe("drafts");
		expect(notesStore.selected?.kind).toBe("orphan");
		expect(notesStore.notice).toBe("unarchived");
	});
});

describe("notesStore archive feedback", () => {
	it("keeps the archived success notice after refreshing and selecting the result", async () => {
		const orphan = { ...archivedMarkdown, kind: "orphan" as const, status: "uploaded" as const };
		notesStore.selected = orphan;
		apiMocks.archiveNote.mockResolvedValue({
			rawPath: orphan.rawPath,
			wikiPagePath: "wiki/sources/source.md",
			wikiPages: ["wiki/sources/source.md"],
			status: "indexed",
		});
		apiMocks.listNotes.mockResolvedValue({ notes: [archivedMarkdown] });
		apiMocks.fetchRawContent.mockResolvedValue("source");

		await expect(notesStore.archiveSelected()).resolves.toBe("wiki/sources/source.md");
		expect(notesStore.notice).toBe("archived");
		expect(notesStore.listBox).toBe("archived");
	});
});
