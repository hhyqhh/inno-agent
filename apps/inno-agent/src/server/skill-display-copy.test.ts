import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillDisplayCopyService } from "./skill-display-copy.js";

const roots: string[] = [];
function cachePath(): string {
	const root = mkdtempSync(join(tmpdir(), "skill-display-copy-"));
	roots.push(root);
	return join(root, "cache.json");
}

afterEach(() => {
	while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

const generated = [{
	id: "new-skill",
	displayName: { zh: "新技能", en: "New Skill" },
	description: { zh: "用简单的方式完成新任务。", en: "Complete a new task in a simple way." },
}];

describe("SkillDisplayCopyService", () => {
	it("generates missing copy and retains it when the source description changes", async () => {
		const file = cachePath();
		const complete = vi.fn().mockResolvedValue(JSON.stringify(generated));
		const service = new SkillDisplayCopyService(file, complete);

		const first = await service.getCopies([{ name: "new-skill", description: "Original description" }]);
		expect(first["new-skill"].displayName.zh).toBe("新技能");

		const second = await service.getCopies([{ name: "new-skill", description: "Updated upstream description" }]);
		expect(second).toEqual(first);
		expect(complete).toHaveBeenCalledTimes(1);

		const reloaded = new SkillDisplayCopyService(file, complete);
		expect(await reloaded.getCopies([{ name: "new-skill", description: "Another description" }])).toEqual(first);
		expect(complete).toHaveBeenCalledTimes(1);
	});

	it("accepts fenced JSON and ignores malformed or unsolicited entries", async () => {
		const complete = vi.fn().mockResolvedValue(`\`\`\`json\n${JSON.stringify([
			...generated,
			{ id: "unknown", displayName: { zh: "未知", en: "Unknown" }, description: { zh: "未知", en: "Unknown" } },
			{ id: "broken", displayName: { zh: "", en: "Broken" }, description: { zh: "无效", en: "Invalid" } },
		])}\n\`\`\``);
		const service = new SkillDisplayCopyService(cachePath(), complete);
		const copies = await service.getCopies([
			{ name: "new-skill", description: "Description" },
			{ name: "broken", description: "Description" },
		]);
		expect(Object.keys(copies)).toEqual(["new-skill"]);
	});

	it("serializes concurrent requests and reuses the first generated result", async () => {
		let release!: (value: string) => void;
		const complete = vi.fn().mockReturnValue(new Promise<string>((resolve) => { release = resolve; }));
		const service = new SkillDisplayCopyService(cachePath(), complete);
		const first = service.getCopies([{ name: "new-skill", description: "First" }]);
		const second = service.getCopies([{ name: "new-skill", description: "Second" }]);
		await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
		release(JSON.stringify(generated));
		expect(await first).toEqual(await second);
		expect(complete).toHaveBeenCalledTimes(1);
	});
});
