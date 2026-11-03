import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { L3Memory } from "../memory/l3/l3-tools.js";
import { createSkillGeneratorTools } from "./tools.js";

let root = "";
afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = "";
});

function setup(overrides?: { searchLexical?: ReturnType<typeof vi.fn>; isL3Enabled?: () => boolean; onSkillsChanged?: () => void }) {
	root = mkdtempSync(join(tmpdir(), "inno-skill-tools-"));
	const sessionDir = join(root, "sessions");
	const workspaceDir = join(root, "workspace");
	const skillsDir = join(root, "skills");
	const tools = createSkillGeneratorTools({
		dataDir: root,
		sessionDir,
		skillsDir,
		getWorkspaceDir: () => workspaceDir,
		l3Memory: { searchLexical: overrides?.searchLexical ?? vi.fn() } as unknown as L3Memory,
		isL3Enabled: overrides?.isL3Enabled ?? (() => true),
		onSkillsChanged: overrides?.onSkillsChanged,
	});
	return { tools, sessionDir, workspaceDir, skillsDir };
}

function execute(tool: ReturnType<typeof createSkillGeneratorTools>[number], params: unknown, sessionFile?: string) {
	return tool.execute("test-call", params, undefined, undefined, {
		sessionManager: { getSessionFile: () => sessionFile },
	} as never);
}

describe("skill generator tools", () => {
	it("exposes the inspect, trace and confirmed-save primitives", async () => {
		const { tools } = setup();
		expect(tools.map((tool) => tool.name)).toEqual(["skill_generator_inspect", "skill_trace_extract", "skill_generator_save"]);
		const result = await execute(tools[0], {});
		expect(result.details).toMatchObject({ methods: ["guided", "trace", "evolution", "hybrid"] });
	});

	it("does not write a skill without explicit user confirmation", async () => {
		const { tools, skillsDir } = setup();
		const result = await execute(tools[2], {
			name: "weekly-report", method: "guided", confirmed: false,
			content: "---\nname: weekly-report\ndescription: test\n---\n\nDo the work.",
		});
		expect(result.details).toMatchObject({ saved: false, confirmationRequired: true });
		expect(existsSync(join(skillsDir, "weekly-report", "SKILL.md"))).toBe(false);
	});

	it("respects the L3 privacy gate for historical trace search", async () => {
		const searchLexical = vi.fn();
		const { tools } = setup({ searchLexical, isL3Enabled: () => false });
		const result = await execute(tools[1], { query: "weekly report" });
		expect(result.details).toMatchObject({ disabled: true });
		expect(searchLexical).not.toHaveBeenCalled();
	});

	it("extracts the active branch of the current session with tool evidence", async () => {
		const { tools, sessionDir } = setup();
		const { mkdirSync } = await import("node:fs");
		mkdirSync(sessionDir, { recursive: true });
		const sessionFile = join(sessionDir, "demo.jsonl");
		const entries = [
			{ id: "u1", type: "message", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "演示如何生成周报" }] } },
			{ id: "a1", parentId: "u1", type: "message", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "call1", name: "read", arguments: { path: "data.csv" } }], stopReason: "toolUse" } },
			{ id: "t1", parentId: "a1", type: "message", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "toolResult", toolCallId: "call1", toolName: "read", content: [{ type: "text", text: "csv rows" }], isError: false } },
			{ id: "a2", parentId: "t1", type: "message", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "assistant", content: [{ type: "text", text: "已完成周报" }], stopReason: "stop" } },
		];
		writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf-8");

		const result = await execute(tools[1], {}, sessionFile);
		expect(result.details).toMatchObject({ traces: [{ sessionId: "demo.jsonl", signals: { toolCalls: 1, hasCompletion: true } }] });
		const text = result.content[0];
		if (text?.type !== "text") throw new Error("Expected text result");
		expect(text.text).toContain("tool read success");
		expect(text.text).toContain("csv rows");
	});

	it("saves a confirmed workspace skill and schedules a reload", async () => {
		const onSkillsChanged = vi.fn();
		const { tools, workspaceDir } = setup({ onSkillsChanged });
		const result = await execute(tools[2], {
			name: "weekly-report", method: "guided", scope: "workspace", confirmed: true,
			content: "---\nname: weekly-report\ndescription: Build a weekly report from verified rows.\n---\n\n1. Read rows.\n2. Summarize and check totals.",
		});
		expect(result.details).toMatchObject({ saved: true, scope: "workspace", version: 1 });
		expect(readFileSync(join(workspaceDir, ".skills", "weekly-report", "SKILL.md"), "utf-8")).toContain("check totals");
		expect(onSkillsChanged).toHaveBeenCalledOnce();
	});
});
