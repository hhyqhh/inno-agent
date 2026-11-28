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
			name: "备课", purpose: "准备课堂练习", skillNames: ["lesson"], linkedWorkspaceIds: ["bank"],
		});
		expect(complete).toHaveBeenCalledOnce();
	});
});
