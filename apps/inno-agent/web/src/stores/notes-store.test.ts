import { afterEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
	archiveNote: vi.fn(),
	createNote: vi.fn(),
	deleteNoteAttachment: vi.fn(),
	fetchNoteContent: vi.fn(),
	fetchRawContent: vi.fn(),
	listNotes: vi.fn(),
	saveNoteContent: vi.fn(),
	saveRawMarkdownContent: vi.fn(),
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
	notesStore.error = null;
	notesStore.notice = null;
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
