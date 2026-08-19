import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	deleteNoteHistory,
	listNoteVersions,
	readNoteVersion,
	recordNoteVersion,
} from "./note-history-service.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("note history", () => {
	it("records, reads, deduplicates, and deletes snapshots", () => {
		const root = mkdtempSync(join(tmpdir(), "inno-note-history-"));
		roots.push(root);
		const base = {
			noteId: "note_1234",
			title: "First note",
			tags: ["test"],
			recordDate: "2026-08-19",
			content: "Initial content",
		} as const;

		const created = recordNoteVersion(root, { ...base, tags: [...base.tags], reason: "created" });
		const duplicate = recordNoteVersion(root, { ...base, tags: [...base.tags], reason: "manual" });
		expect(duplicate.versionId).toBe(created.versionId);

		const saved = recordNoteVersion(root, {
			...base,
			tags: [...base.tags],
			content: "Updated content",
			reason: "manual",
		});
		expect(listNoteVersions(root, base.noteId).map((item) => item.versionId)).toEqual([
			saved.versionId,
			created.versionId,
		]);
		expect(readNoteVersion(root, base.noteId, saved.versionId).content).toBe("Updated content");

		deleteNoteHistory(root, base.noteId);
		expect(listNoteVersions(root, base.noteId)).toEqual([]);
	});

	it("rejects unsafe identifiers", () => {
		const root = mkdtempSync(join(tmpdir(), "inno-note-history-"));
		roots.push(root);
		expect(() => listNoteVersions(root, "../escape")).toThrow("Invalid note id");
		expect(() => readNoteVersion(root, "note_safe", "../escape")).toThrow("Invalid version id");
	});
});
