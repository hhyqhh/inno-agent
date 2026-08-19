import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeText } from "../../storage/file-store.js";
import { polishNoteContent } from "./note-polish-service.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("polishNoteContent", () => {
	it("classifies a template and normalizes the polished Markdown", async () => {
		const root = mkdtempSync(join(tmpdir(), "inno-note-polish-"));
		roots.push(root);
		writeText(join(root, "note-templates", "meeting.md"), [
			"---",
			"label: 会议纪要",
			"description: 会议记录",
			"---",
			"# 会议纪要",
			"",
			"## 决策",
		].join("\n"));
		const runPrompt = vi.fn()
			.mockResolvedValueOnce("meeting")
			.mockResolvedValueOnce("```markdown\n# 周会\n\n## 决策\n\n继续拆分 PR。\n```");

		const result = await polishNoteContent(root, {
			title: "周会",
			tags: ["会议"],
			content: "今天决定继续拆分 PR。",
		}, runPrompt);

		expect(result).toEqual({
			content: "# 周会\n\n## 决策\n\n继续拆分 PR。\n",
			templateId: "meeting",
			templateLabel: "会议纪要",
		});
		expect(runPrompt).toHaveBeenCalledTimes(2);
	});

	it("rejects an empty model response", async () => {
		const root = mkdtempSync(join(tmpdir(), "inno-note-polish-"));
		roots.push(root);
		await expect(polishNoteContent(root, { title: "笔记", tags: [], content: "正文" }, async () => ""))
			.rejects.toThrow("did not return polished content");
	});
});
