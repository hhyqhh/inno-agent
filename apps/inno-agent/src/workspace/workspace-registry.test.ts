import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceRegistry } from "./workspace-registry.js";

describe("WorkspaceRegistry linked workspaces", () => {
	let root: string;
	let registry: WorkspaceRegistry;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "inno-ws-links-"));
		registry = new WorkspaceRegistry(join(root, "workspaces"), join(root, "data"));
		registry.ensureBootstrapped();
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("resolves linked workspace directories and related session IDs for a session", async () => {
		const bank = registry.createWorkspace({ name: "题库", purpose: "历年真题与例题" });
		const templates = registry.createWorkspace({ name: "模板" });
		const unrelated = registry.createWorkspace({ name: "无关空间" });
		const main = registry.createWorkspace({
			name: "数学备课",
			purpose: "准备课堂练习",
			linkedWorkspaceIds: [bank.id, templates.id],
		});

		registry.bindSession("s-active.jsonl", main.id);
		registry.bindSession("s-main-old.jsonl", main.id);
		registry.bindSession("s-bank.jsonl", bank.id);
		registry.bindSession("s-unrelated.jsonl", unrelated.id);

		const ctx = await registry.getSessionWorkspaceContext("s-active.jsonl");
		expect(ctx).toBeDefined();
		expect(ctx!.workspace.id).toBe(main.id);
		expect(ctx!.linkedWorkspaces.map((w) => ({ id: w.id, name: w.name, purpose: w.purpose }))).toEqual([
			{ id: bank.id, name: "题库", purpose: "历年真题与例题" },
			{ id: templates.id, name: "模板", purpose: undefined },
		]);
		expect(ctx!.linkedWorkspaces[0].absDir).toBe(registry.resolveWorkspaceDir(bank.id));
		expect(new Set(ctx!.relatedSessionIds)).toEqual(new Set(["s-main-old.jsonl", "s-bank.jsonl"]));
	});

	it("cleans dangling linkedWorkspaceIds when a referenced workspace is deleted", async () => {
		const bank = registry.createWorkspace({ name: "题库" });
		const templates = registry.createWorkspace({ name: "模板" });
		const main = registry.createWorkspace({
			name: "数学备课",
			linkedWorkspaceIds: [bank.id, templates.id],
		});
		registry.bindSession("s-active.jsonl", main.id);

		expect(registry.deleteWorkspace(bank.id)).toBe(true);

		const updated = registry.getWorkspace(main.id);
		expect(updated?.linkedWorkspaceIds).toEqual([templates.id]);

		const ctx = await registry.getSessionWorkspaceContext("s-active.jsonl");
		expect(ctx?.linkedWorkspaces.map((w) => w.id)).toEqual([templates.id]);
	});
});
