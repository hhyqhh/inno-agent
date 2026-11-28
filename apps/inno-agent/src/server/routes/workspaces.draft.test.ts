import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { handleWorkspacesRoutes, type WorkspacesRouteContext } from "./workspaces.js";

const mocks = vi.hoisted(() => ({ completePromptOnce: vi.fn(), getLoadedSkills: vi.fn() }));
vi.mock("../../agent/pi-runner.js", () => mocks);

describe("workspace draft recommendations", () => {
	it("can recommend a matching uninstalled library skill from beyond the former catalog cutoff", async () => {
		const local = { name: "local-lesson", description: "数学教案" };
		const library = { name: "k12-lesson-planning", description: "数学备课与练习", installed: false };
		const localAlternative = { name: "class-exam-review", description: "数学试卷讲评" };
		const libraryAlternative = { name: "math-tutor", description: "数学辅导", installed: false };
		const earlierLibrarySkills = Array.from({ length: 201 }, (_, index) => ({
			name: `library-skill-${index}`, description: "图片处理", installed: false,
		}));
		mocks.getLoadedSkills.mockReturnValue({ skills: [local, localAlternative] });
		mocks.completePromptOnce.mockResolvedValue(JSON.stringify({
			name: "数学备课", purpose: "设计课堂练习", skillNames: [local.name, library.name, "not-in-catalog"], linkedWorkspaceIds: [],
		}));
		const context = {
			workspaceRegistry: { listWorkspacesAsync: async () => [] },
			listSkillLibrary: async () => [...earlierLibrarySkills, { ...local, installed: true }, library, libraryAlternative],
		} as unknown as WorkspacesRouteContext;
		const req = Readable.from([Buffer.from(JSON.stringify({ description: "数学备课" }))]) as unknown as IncomingMessage;
		req.headers = {};
		const res = { writeHead: vi.fn(), end: vi.fn() };

		expect(await handleWorkspacesRoutes(req, res as unknown as ServerResponse, "POST", "/api/workspaces/draft", context)).toBe(true);
		expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
		const [prompt] = mocks.completePromptOnce.mock.calls[0];
		const { skills } = JSON.parse(prompt.split("\n").at(-1));
		expect(skills).toEqual([{ name: library.name, description: library.description }, local, localAlternative,
			{ name: libraryAlternative.name, description: libraryAlternative.description }]);
		expect(JSON.parse(res.end.mock.calls[0][0])).toEqual({
			name: "数学备课", purpose: "设计课堂练习", skillNames: [local.name], linkedWorkspaceIds: [], librarySkills: [library],
			alternativeSkills: [{ ...localAlternative, installed: true }, libraryAlternative],
		});
	});
});
