import { describe, expect, it, vi } from "vitest";
import { proposeWorkspaceDraft, readWorkspaceConfiguration } from "./workspace-draft.js";

describe("workspace configuration", () => {
	it("preserves omitted fields and explicit empty lists", () => {
		expect(readWorkspaceConfiguration({ name: "New name" })).toEqual({});
		expect(readWorkspaceConfiguration({ linkedWorkspaceIds: [], skillNames: [" lesson ", "lesson"] }))
			.toEqual({ linkedWorkspaceIds: [], skillNames: ["lesson"] });
	});

	it("rejects malformed configuration fields", () => {
		expect(() => readWorkspaceConfiguration({ purpose: 123 })).toThrow(/purpose/);
		expect(() => readWorkspaceConfiguration({ linkedWorkspaceIds: ["lesson", null] })).toThrow(/linkedWorkspaceIds/);
	});

	it("builds a draft and discards references absent from the candidate data", async () => {
		const complete = vi.fn(async () => JSON.stringify({
			name: "备课", purpose: "准备课堂练习", skillNames: ["lesson", "missing", "lesson"], linkedWorkspaceIds: ["bank", "unknown"],
		}));
		await expect(proposeWorkspaceDraft("数学备课", [{ name: "lesson", description: "教案" }],
			[{ id: "bank", name: "题库" }], complete)).resolves.toEqual({
			name: "备课", purpose: "准备课堂练习", skillNames: ["lesson"], linkedWorkspaceIds: ["bank"], alternativeSkills: [],
		});
		expect(complete).toHaveBeenCalledOnce();
	});

	it("sends at most twenty matching descriptions and prioritizes skill-name matches", async () => {
		const catalog = Array.from({ length: 25 }, (_, index) => ({ name: `tool-${index}`, description: "Plan a lesson" }));
		const best = { name: "lesson-planner", description: "Create teaching materials" };
		const complete = vi.fn(async (_prompt: string) => JSON.stringify({
			name: "Class",
			purpose: "",
			skillNames: [best.name],
			alternativeSkillNames: ["tool-9", "tool-1"],
		}));

		const draft = await proposeWorkspaceDraft("lesson", [...catalog, best], [], complete);
		const { skills } = JSON.parse(complete.mock.calls[0][0].split("\n").at(-1)!);
		expect(skills).toHaveLength(20);
		expect(skills[0]).toEqual(best);
		expect(draft.skillNames).toEqual([best.name]);
		expect(draft.alternativeSkills.map(({ name }) => name)).toEqual(["tool-9", "tool-1", "tool-0", "tool-2", "tool-3", "tool-4"]);
	});

	it("extracts JSON wrapped in thinking tags or surrounding prose", async () => {
		const complete = vi.fn(async () => "<think>Analyze skills...</think>\n好的，这是为您生成的配置：\n```json\n{\"name\":\"备课\",\"purpose\":\"教案\",\"skillNames\":[\"lesson\"],\"alternativeSkillNames\":[\"quiz\"],\"linkedWorkspaceIds\":[]}\n```\n希望有帮助。");
		const draft = await proposeWorkspaceDraft(
			"数学备课",
			[{ name: "lesson", description: "教案" }, { name: "quiz", description: "随堂测验" }],
			[],
			complete,
		);
		expect(draft.name).toBe("备课");
		expect(draft.skillNames).toEqual(["lesson"]);
		expect(draft.alternativeSkills).toEqual([{ name: "quiz", description: "随堂测验" }]);
	});

	it("retries once on empty response and tolerates omitted purpose", async () => {
		const complete = vi.fn()
			.mockResolvedValueOnce("")
			.mockResolvedValueOnce(JSON.stringify({ name: "数学备课", skillNames: ["lesson"] }));
		const draft = await proposeWorkspaceDraft("数学备课", [{ name: "lesson", description: "教案" }], [], complete);
		expect(complete).toHaveBeenCalledTimes(2);
		expect(draft).toEqual({
			name: "数学备课", purpose: "", skillNames: ["lesson"], linkedWorkspaceIds: [], alternativeSkills: [],
		});
	});

	it("sends only names when a large catalog has no lexical match", async () => {
		const catalog = Array.from({ length: 25 }, (_, index) => ({ name: `tool-${index}`, description: "Plan a lesson" }));
		const complete = vi.fn(async (_prompt: string) => JSON.stringify({ name: "备课", purpose: "" }));

		const draft = await proposeWorkspaceDraft("数学备课", catalog, [], complete);
		const { skills } = JSON.parse(complete.mock.calls[0][0].split("\n").at(-1)!);
		expect(skills).toEqual(catalog.map(({ name }) => ({ name })));
		expect(draft.alternativeSkills).toEqual([]);
	});
});
