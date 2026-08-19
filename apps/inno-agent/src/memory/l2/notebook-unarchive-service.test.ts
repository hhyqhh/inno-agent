import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readText, writeText } from "../../storage/file-store.js";
import { archiveL2Source } from "./l2-archive-service.js";
import { runL2Lint } from "./l2-lint.js";
import type { L2Memory } from "./l2-memory.js";
import { readManifest } from "./manifest-store.js";
import { parseNoteFrontmatter, serializeNoteFile } from "./note-frontmatter.js";
import { unarchiveL2NotebookItem } from "./notebook-unarchive-service.js";
import { archiveL2Note } from "./notes-service.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "inno-unarchive-"));
	roots.push(root);
	mkdirSync(join(root, "raw", "uploads"), { recursive: true });
	return root;
}

function fakeMemory(): L2Memory {
	return {
		indexPageByPath: vi.fn().mockResolvedValue(undefined),
		removePage: vi.fn().mockResolvedValue(undefined),
	} as unknown as L2Memory;
}

describe("unarchiveL2NotebookItem", () => {
	it("backs up generated pages and leaves the raw source available", async () => {
		const root = tempRoot();
		const rawPath = "raw/uploads/source.md";
		writeText(join(root, rawPath), "Content about [[Recoverable concept]].");
		const memory = fakeMemory();
		const archived = await archiveL2Source(root, {
			title: "Recoverable source",
			source: { kind: "existing", rawPath, sourceType: "markdown" },
			dedupeBy: "rawPath",
		}, { memory });

		const result = await unarchiveL2NotebookItem(root, rawPath, { memory });
		expect(result.status).toBe("uploaded");
		expect(readManifest(root)).toEqual([]);
		expect(existsSync(join(root, rawPath))).toBe(true);
		expect(result.removedWikiPages).toContain(archived.wikiPagePath);
		expect(result.backupPaths.some((path) => existsSync(join(root, path)))).toBe(true);
		for (const linkedPath of archived.linkedPages) {
			const linked = readText(join(root, linkedPath));
			expect(linked).toContain("status: outdated");
			expect(linked).toContain("wiki/orphans/");
		}
		expect(memory.removePage).toHaveBeenCalledWith(archived.wikiPagePath);
		expect(runL2Lint(root).errors).toBe(0);
	});

	it("returns an archived note to draft without losing its body", async () => {
		const root = tempRoot();
		mkdirSync(join(root, "raw", "notes"), { recursive: true });
		const rawPath = "raw/notes/note.md";
		writeText(join(root, rawPath), serializeNoteFile({
			note_id: "note_unarchive",
			title: "Note to restore",
			tags: [],
			record_date: "2026-01-01",
			status: "draft",
			created: "2026-01-01T00:00:00.000Z",
			updated: "2026-01-01T00:00:00.000Z",
		}, "Body with [[Restored concept]]."));
		const memory = fakeMemory();
		await archiveL2Note(root, rawPath, { memory });

		const result = await unarchiveL2NotebookItem(root, rawPath, { memory });
		const parsed = parseNoteFrontmatter(readText(join(root, rawPath)));
		expect(result.status).toBe("draft");
		expect(parsed.frontmatter?.status).toBe("draft");
		expect(parsed.frontmatter?.source_id).toBeUndefined();
		expect(parsed.body).toContain("Body with [[Restored concept]].");
		expect(readManifest(root)).toEqual([]);
		expect(runL2Lint(root).errors).toBe(0);
	});
});
