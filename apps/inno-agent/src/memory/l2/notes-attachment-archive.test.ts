import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { listNoteAttachments, uploadNoteAttachment } from "./note-attachments-service.js";
import { archiveL2Note, createL2Note, readNoteContent } from "./notes-service.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("note attachment archival", () => {
	it("includes text attachments in the archived source and marks them indexed", async () => {
		const root = mkdtempSync(join(tmpdir(), "inno-note-attachment-archive-"));
		roots.push(root);
		const created = createL2Note(root, root, {
			title: "Attachment note",
			content: "# Attachment note\n\nMain body.",
		});
		uploadNoteAttachment(root, created.rawPath, {
			fileName: "evidence.txt",
			mimeType: "text/plain",
			dataBase64: Buffer.from("Attachment evidence").toString("base64"),
		});

		const result = await archiveL2Note(root, created.rawPath, {});
		expect(result.status).toBe("indexed");
		expect(listNoteAttachments(root, created.rawPath)[0]?.status).toBe("indexed");
		const sourcePage = join(root, result.wikiPagePath);
		expect(existsSync(sourcePage)).toBe(true);
		expect(readFileSync(sourcePage, "utf8")).toContain("Attachment evidence");

		uploadNoteAttachment(root, created.rawPath, {
			fileName: "follow-up.txt",
			mimeType: "text/plain",
			dataBase64: Buffer.from("New evidence").toString("base64"),
		});
		expect(readNoteContent(root, created.rawPath).status).toBe("outdated");
	});
});
