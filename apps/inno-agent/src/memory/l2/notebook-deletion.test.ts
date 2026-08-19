import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { writeText } from "../../storage/file-store.js";
import { upsertManifest } from "./manifest-store.js";
import { listNoteAttachments, uploadNoteAttachment } from "./note-attachments-service.js";
import { serializeNoteFile } from "./note-frontmatter.js";
import { deleteL2NotebookItem } from "./notes-service.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "inno-delete-"));
	roots.push(root);
	mkdirSync(join(root, "raw", "uploads"), { recursive: true });
	mkdirSync(join(root, "raw", "notes"), { recursive: true });
	return root;
}

describe("deleteL2NotebookItem", () => {
	it("deletes an unarchived upload", () => {
		const root = tempRoot();
		const rawPath = "raw/uploads/draft.md";
		writeText(join(root, rawPath), "draft");
		expect(deleteL2NotebookItem(root, rawPath)).toEqual({ rawPath, title: "draft.md" });
		expect(existsSync(join(root, rawPath))).toBe(false);
	});

	it("deletes a draft note and its attachments", () => {
		const root = tempRoot();
		const rawPath = "raw/notes/draft.md";
		writeText(join(root, rawPath), serializeNoteFile({
			note_id: "note_draft",
			title: "Draft note",
			tags: [],
			record_date: "2026-01-01",
			status: "draft",
			created: "2026-01-01T00:00:00.000Z",
			updated: "2026-01-01T00:00:00.000Z",
		}, "body"));
		const attachment = uploadNoteAttachment(root, rawPath, {
			fileName: "evidence.txt",
			mimeType: "text/plain",
			dataBase64: Buffer.from("evidence").toString("base64"),
		});

		expect(deleteL2NotebookItem(root, rawPath)).toEqual({ rawPath, title: "Draft note" });
		expect(existsSync(join(root, rawPath))).toBe(false);
		expect(existsSync(join(root, attachment.filePath))).toBe(false);
		expect(listNoteAttachments(root, rawPath)).toEqual([]);
	});

	it("refuses archived uploads and notes carrying an archive source id", () => {
		const root = tempRoot();
		const uploadPath = "raw/uploads/archived.md";
		writeText(join(root, uploadPath), "archived");
		upsertManifest(root, {
			id: "l2src_archived",
			title: "Archived",
			sourceType: "markdown",
			rawPath: uploadPath,
			wikiPages: [],
			tags: [],
			contentHash: "hash",
			status: "indexed",
			source: { origin: "user_upload" },
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		});
		expect(() => deleteL2NotebookItem(root, uploadPath)).toThrow("已归档");

		const notePath = "raw/notes/note.md";
		writeText(join(root, notePath), serializeNoteFile({
			note_id: "note_test",
			title: "Note",
			tags: [],
			record_date: "2026-01-01",
			status: "outdated",
			source_id: "l2src_missing",
			created: "2026-01-01T00:00:00.000Z",
			updated: "2026-01-01T00:00:00.000Z",
		}, "body"));
		expect(() => deleteL2NotebookItem(root, notePath)).toThrow("可能仍被知识库引用");
	});

	it("rejects nested raw paths", () => {
		expect(() => deleteL2NotebookItem(tempRoot(), "raw/uploads/subdir/file.md")).toThrow("Invalid raw path");
	});
});
