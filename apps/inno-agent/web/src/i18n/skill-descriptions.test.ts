import { describe, expect, it } from "vitest";
import { getFriendlySkillDescription, getFriendlySkillName } from "./skill-descriptions.js";

describe("friendly skill descriptions", () => {
	it("returns polished copy instead of requiring the raw skill description", () => {
		expect(getFriendlySkillDescription("docx", "zh-CN")).toBe("创建、读取和编辑 Word 文档，轻松处理报告与正式文稿。");
		expect(getFriendlySkillDescription("docx", "en")).toBe("Create, read, and edit Word documents for reports and other formal writing.");
	});

	it("localizes display names without changing custom skill identifiers", () => {
		expect(getFriendlySkillName("docx", "zh-CN")).toBe("Word 文档");
		expect(getFriendlySkillName("docx", "en")).toBe("Word Documents");
		expect(getFriendlySkillName("my-private-skill", "zh-CN")).toBe("my-private-skill");
	});

	it("uses background AI copy for new skills without replacing existing polish", () => {
		const generated = {
			displayName: { zh: "新技能", en: "New Skill" },
			description: { zh: "帮助完成新任务。", en: "Help complete a new task." },
		};
		expect(getFriendlySkillName("my-private-skill", "zh-CN", generated)).toBe("新技能");
		expect(getFriendlySkillDescription("my-private-skill", "en", generated)).toBe("Help complete a new task.");
		expect(getFriendlySkillName("docx", "zh-CN", generated)).toBe("Word 文档");
	});

	it("follows Chinese locale variants and defaults other locales to English", () => {
		expect(getFriendlySkillDescription("pdf", "zh-Hans")).toContain("PDF");
		expect(getFriendlySkillDescription("pdf", "en-US")).toContain("Read, create, and review PDFs");
	});

	it("does not invent an introduction for an unknown custom skill", () => {
		expect(getFriendlySkillDescription("my-private-skill", "zh-CN")).toBe("");
	});
});
