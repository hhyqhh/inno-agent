import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getSkillTree: vi.fn(),
	getSkillFile: vi.fn(),
	inlineSkillHtml: vi.fn(),
	deleteSkill: vi.fn(),
}));

vi.mock("../api/skills.js", () => ({
	getSkillTree: mocks.getSkillTree,
	getSkillFile: mocks.getSkillFile,
	inlineSkillHtml: mocks.inlineSkillHtml,
	deleteSkill: mocks.deleteSkill,
	listSkills: vi.fn(),
	reloadSkills: vi.fn(),
	updateSkill: vi.fn(),
	uploadSkill: vi.fn(),
	saveSkillFile: vi.fn(),
	listSkillLibrary: vi.fn(),
	importSkillFromLibrary: vi.fn(),
}));

import { SkillsStoreImpl } from "./skills-store.js";
import type { WorkspaceFileDetail, WorkspaceTreeNode } from "../types/workspace.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function node(path: string): WorkspaceTreeNode {
	return { name: path.split("/").at(-1) ?? path, path, type: "file" };
}

function file(path: string): WorkspaceFileDetail {
	return {
		path,
		name: path.split("/").at(-1) ?? path,
		kind: "text",
		mimeType: "text/plain",
		size: 1,
		updatedAt: "2026-01-01T00:00:00.000Z",
		content: path,
	};
}

function skill(name: string) {
	return {
		name,
		description: "",
		enabled: true,
		loaded: true,
		filePath: `/skills/${name}`,
		size: 0,
		updatedAt: "2026-01-01T00:00:00.000Z",
		diagnostics: [],
	};
}

describe("SkillsStore request ownership", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.inlineSkillHtml.mockImplementation(async (_name: string, content: string) => content);
	});

	it("does not let a stale tree failure clear a newer skill selection", async () => {
		const stale = deferred<{ children: WorkspaceTreeNode[] }>();
		mocks.getSkillTree.mockImplementation((name: string) => name === "old-skill" ? stale.promise : Promise.resolve({ children: [node("new.md")] }));
		const store = new SkillsStoreImpl();

		const oldRequest = store.selectSkill("old-skill");
		await Promise.resolve();
		await store.selectSkill("new-skill");
		expect(store.skillTree?.[0]?.path).toBe("new.md");

		stale.reject(new Error("old request failed"));
		await oldRequest;
		expect(store.selectedSkill).toBe("new-skill");
		expect(store.skillTree?.[0]?.path).toBe("new.md");
	});

	it("does not let a stale file response overwrite the latest selection", async () => {
		const stale = deferred<WorkspaceFileDetail>();
		mocks.getSkillFile.mockImplementation((_name: string, path: string) => path === "old.md" ? stale.promise : Promise.resolve(file("new.md")));
		const store = new SkillsStoreImpl();
		store.selectedSkill = "skill";

		const oldRequest = store.selectFile("old.md");
		await Promise.resolve();
		await store.selectFile("new.md");
		expect(store.currentFile?.path).toBe("new.md");

		stale.resolve(file("old.md"));
		await oldRequest;
		expect(store.currentFile?.path).toBe("new.md");
	});

	it("cancels pending requests when removing the selected skill", async () => {
		const stale = deferred<{ children: WorkspaceTreeNode[] }>();
		mocks.getSkillTree.mockReturnValue(stale.promise);
		const store = new SkillsStoreImpl();
		store.skills = [skill("skill")];

		const request = store.selectSkill("skill");
		await Promise.resolve();
		await store.remove("skill");
		expect(store.isLoadingTree).toBe(false);

		stale.resolve({ children: [node("stale.md")] });
		await request;
		expect(store.selectedSkill).toBeNull();
		expect(store.skillTree).toBeNull();
	});
});
