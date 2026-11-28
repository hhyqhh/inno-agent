import { expect, it, vi } from "vitest";
import { listWorkspaces, updateWorkspace } from "../api/workspaces.js";
import { workspacesStore } from "./workspaces-store.js";

vi.mock("../api/workspaces.js", () => ({
	listWorkspaces: vi.fn(),
	updateWorkspace: vi.fn(),
}));

it("keeps list metadata when saving a workspace configuration", async () => {
	const workspace = {
		id: "lesson-plan",
		name: "Lesson plan",
		relPath: "lesson-plan",
		createdAt: "2026-11-28T00:00:00Z",
		updatedAt: "2026-11-28T00:00:00Z",
		isTemp: false,
	};
	const listMetadata = { sessionIds: ["lesson.jsonl"], privateSkillNames: ["make-rubric"] };
	const changes = { name: "Math lesson plan", skillNames: [] };
	const saved = { ...workspace, ...changes, updatedAt: "2026-11-28T01:00:00Z" };
	vi.mocked(listWorkspaces).mockResolvedValue([{ ...workspace, ...listMetadata, skillNames: ["lesson"] }]);
	vi.mocked(updateWorkspace).mockResolvedValue(saved);

	await workspacesStore.load();
	await workspacesStore.update(workspace.id, changes);

	expect(updateWorkspace).toHaveBeenCalledWith(workspace.id, changes);
	expect(workspacesStore.getById(workspace.id)).toEqual({ ...saved, ...listMetadata });
});
