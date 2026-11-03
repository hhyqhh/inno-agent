import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { inspectGeneratedSkill, saveGeneratedSkill, validateSkillDocument } from "./store.js";

let root = "";
afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = "";
});

function document(name: string, body = "Follow the reusable procedure."): string {
	return `---\nname: ${name}\ndescription: Use when a repeatable report workflow is required.\n---\n\n# Procedure\n\n${body}\n`;
}

function save(operation: "create" | "revise" = "create") {
	return saveGeneratedSkill({
		rootDir: root, name: "weekly-report", content: document("weekly-report"), method: operation === "create" ? "guided" : "evolution",
		operation, confirmed: true, evidence: ["trace.jsonl [S02]"], changeSummary: "Initial reusable workflow",
		now: new Date("2026-01-02T03:04:05.000Z"),
	});
}

describe("generated skill store", () => {
	it("validates frontmatter, matching names and a nonempty procedure", () => {
		expect(validateSkillDocument(document("weekly-report"), "weekly-report")).toContain("# Procedure");
		expect(() => validateSkillDocument(document("other"), "weekly-report")).toThrow("完全一致");
		expect(() => validateSkillDocument("---\nname: x\n---\n", "x")).toThrow("description");
		expect(() => validateSkillDocument("---\nname: x\ndescription: test\n---\n", "x")).toThrow("正文");
	});

	it("requires explicit confirmation before creating a skill", () => {
		root = mkdtempSync(join(tmpdir(), "inno-skill-store-"));
		expect(() => saveGeneratedSkill({
			rootDir: root, name: "weekly-report", content: document("weekly-report"), method: "guided", operation: "create", confirmed: false,
		})).toThrow("明确确认");
		expect(existsSync(join(root, "weekly-report", "SKILL.md"))).toBe(false);
	});

	it("creates a validated skill with provenance and lists it through inspection", () => {
		root = mkdtempSync(join(tmpdir(), "inno-skill-store-"));
		const result = save();
		expect(result.version).toBe(1);
		expect(result.metadata.evidence).toEqual(["trace.jsonl [S02]"]);
		expect(inspectGeneratedSkill(root, "weekly-report")).toMatchObject({
			name: "weekly-report", metadata: { version: 1, method: "guided" },
		});
		expect(() => save()).toThrow("已存在");
	});

	it("backs up the old document before a confirmed evolution", () => {
		root = mkdtempSync(join(tmpdir(), "inno-skill-store-"));
		save();
		writeFileSync(join(root, "weekly-report", "SKILL.md"), document("weekly-report", "Original procedure."), "utf-8");
		const result = save("revise");
		expect(result.version).toBe(2);
		expect(result.backupPath && readFileSync(result.backupPath, "utf-8")).toContain("Original procedure.");
		expect(readFileSync(result.filePath, "utf-8")).toContain("Follow the reusable procedure.");
		expect(inspectGeneratedSkill(root, "weekly-report")?.metadata).toMatchObject({ version: 2, method: "evolution" });
	});

	it("fails closed when a skill directory symlinks outside the root", () => {
		root = mkdtempSync(join(tmpdir(), "inno-skill-store-"));
		const outside = mkdtempSync(join(tmpdir(), "inno-skill-outside-"));
		try {
			mkdirSync(join(root, "linked"));
			writeFileSync(join(outside, "SKILL.md"), document("linked"), "utf-8");
			rmSync(join(root, "linked"), { recursive: true });
			symlinkSync(outside, join(root, "linked"), "dir");
			expect(() => saveGeneratedSkill({
				rootDir: root, name: "linked", content: document("linked"), method: "evolution", operation: "revise", confirmed: true,
			})).toThrow("安全边界");
			expect(readFileSync(join(outside, "SKILL.md"), "utf-8")).toBe(document("linked"));
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});
});
