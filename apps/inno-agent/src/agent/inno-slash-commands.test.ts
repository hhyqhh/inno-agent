import { describe, expect, it } from "vitest";
import { expandInnoSlashCommand, INNO_SLASH_COMMAND_NAMES } from "./inno-extension.js";

describe("expandInnoSlashCommand", () => {
	it("returns null for non-command text", () => {
		expect(expandInnoSlashCommand("hello")).toBeNull();
		expect(expandInnoSlashCommand("")).toBeNull();
	});

	it("returns null for commands Inno does not own (skills, plugin commands)", () => {
		expect(expandInnoSlashCommand("/skill:ppt-creation make slides")).toBeNull();
		expect(expandInnoSlashCommand("/todos")).toBeNull();
		expect(expandInnoSlashCommand("/model")).toBeNull();
	});

	it("expands /recall with a query into an l3_recall instruction", () => {
		const expanded = expandInnoSlashCommand("/recall 链式法则我上次卡在哪？");
		expect(expanded).toContain("l3_recall");
		expect(expanded).toContain("链式法则我上次卡在哪？");
	});

	it("expands a bare /recall into a default review request", () => {
		const expanded = expandInnoSlashCommand("/recall");
		expect(expanded).toContain("l3_recall");
		expect(expanded).not.toBeNull();
	});

	it("expands /remember with a fact into an L1 write instruction", () => {
		const expanded = expandInnoSlashCommand("/remember 我更喜欢用例子学概念");
		expect(expanded).toContain("学习者画像");
		expect(expanded).toContain("我更喜欢用例子学概念");
	});

	it("expands /wiki with a query into an l2_query instruction", () => {
		const expanded = expandInnoSlashCommand("/wiki 贝叶斯定理的笔记在哪？");
		expect(expanded).toContain("l2_query");
		expect(expanded).toContain("贝叶斯定理的笔记在哪？");
	});

	it("expands a bare /wiki into an index overview request", () => {
		const expanded = expandInnoSlashCommand("/wiki");
		expect(expanded).toContain("l2_query");
		expect(expanded).toContain("索引");
	});

	it("expands /skill-create into the guided generation workflow with user input", () => {
		const expanded = expandInnoSlashCommand("/skill-create hybrid 把我的论文精读流程沉淀下来");
		expect(expanded).toContain("skill_trace_extract");
		expect(expanded).toContain("skill_generator_save");
		expect(expanded).toContain("confirmed=true");
		expect(expanded).toContain("把我的论文精读流程沉淀下来");
	});

	it("trims extra whitespace around args", () => {
		const expanded = expandInnoSlashCommand("/recall   微积分  ");
		expect(expanded).toContain("微积分");
		expect(expanded).not.toContain("  微积分");
	});

	it("registers exactly the expandable commands", () => {
		expect([...INNO_SLASH_COMMAND_NAMES].sort()).toEqual(["recall", "remember", "skill-create", "wiki"]);
	});
});
