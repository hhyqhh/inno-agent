import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	createCustomNoteTemplate,
	deleteCustomNoteTemplate,
	duplicateNoteTemplate,
	listNoteTemplates,
	resolveNoteTemplateContent,
	updateCustomNoteTemplate,
} from "./note-templates.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("custom note templates", () => {
	it("creates, updates, duplicates, resolves, and deletes templates", () => {
		const root = mkdtempSync(join(tmpdir(), "inno-note-templates-"));
		roots.push(root);
		const codeDir = join(root, "code");
		const dataDir = join(root, "data");
		mkdirSync(join(codeDir, "note-templates"), { recursive: true });
		writeFileSync(join(codeDir, "note-templates", "blank.md"), "---\nlabel: Blank\nhidden: true\n---\n# New note\n", "utf8");

		const created = createCustomNoteTemplate(codeDir, dataDir, {
			id: "weekly-review",
			label: "Weekly review",
			tags: ["review"],
			body: "# Weekly review\n\n## Wins\n",
		});
		expect(created.source).toBe("custom");
		expect(listNoteTemplates(codeDir, dataDir).map((item) => item.id)).toEqual(["blank", "weekly-review"]);

		const updated = updateCustomNoteTemplate(codeDir, dataDir, created.id, {
			...created,
			label: "Weekly retrospective",
			body: "# Weekly retrospective\n",
		});
		expect(updated.label).toBe("Weekly retrospective");
		expect(resolveNoteTemplateContent(codeDir, dataDir, { templateId: created.id }).body).toContain("retrospective");

		const duplicate = duplicateNoteTemplate(codeDir, dataDir, created.id, "weekly-review-copy");
		expect(duplicate.editable).toBe(true);
		deleteCustomNoteTemplate(codeDir, dataDir, created.id);
		expect(listNoteTemplates(codeDir, dataDir).map((item) => item.id)).toEqual(["blank", "weekly-review-copy"]);
	});

	it("rejects unsafe template ids", () => {
		const root = mkdtempSync(join(tmpdir(), "inno-note-templates-"));
		roots.push(root);
		expect(() => createCustomNoteTemplate(root, root, { id: "../escape", label: "Bad", body: "# Bad" }))
			.toThrow("模板 ID");
	});
});
