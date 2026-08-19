import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createNoteTools } from "./note-tools.js";
import { listL2Notes, readNoteContent } from "../memory/l2/notes-service.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function execute(tool: ReturnType<typeof createNoteTools>[number], params: unknown) {
	return (tool.execute as (...args: any[]) => Promise<any>)("call-1", params, undefined, undefined, {});
}

describe("note tools", () => {
	it("saves an explicitly requested conversation as an editable note", async () => {
		const root = mkdtempSync(join(tmpdir(), "inno-note-tools-"));
		roots.push(root);
		const tool = createNoteTools(root, root, () => true, () => "session-123")
			.find((candidate) => candidate.name === "note_create_from_conversation")!;
		const result = await execute(tool, {
			mode: "summary",
			title: "PR 拆分讨论",
			tags: ["Git"],
			content: "# PR 拆分讨论\n\n按功能拆分。",
		});
		const path = result.details.rawPath as string;
		const note = readNoteContent(root, path);
		expect(note.sourceSessionId).toBe("session-123");
		expect(note.captureMode).toBe("summary");
		expect(note.content).toContain("按功能拆分");
	});

	it("reads all selected note paths and rejects unknown paths", async () => {
		const root = mkdtempSync(join(tmpdir(), "inno-note-tools-"));
		roots.push(root);
		const create = createNoteTools(root, root).find((candidate) => candidate.name === "note_create_from_conversation")!;
		await execute(create, { mode: "transcript", title: "A", content: "# A\n\nAlpha" });
		const path = listL2Notes(root).notes[0].rawPath;
		const readMany = createNoteTools(root, root).find((candidate) => candidate.name === "note_read_many")!;
		const result = await execute(readMany, { rawPaths: [path, "raw/notes/missing.md"] });
		expect(result.details.loaded).toBe(1);
		expect(result.details.failed).toEqual(["raw/notes/missing.md"]);
		expect(result.content[0].text).toContain("Alpha");
	});
});
