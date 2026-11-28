import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { InnoConfig } from "../config.js";
import { closeL2Memory } from "../memory/l2/l2-memory.js";
import { resolveRuntimePaths } from "../runtime.js";
import { WorkspaceRegistry } from "../workspace/workspace-registry.js";
import { buildLinkedWorkspaceSkillsSection, createInnoExtension, formatLinkedWorkspacesSection } from "./inno-extension.js";

function writeSkill(workspaceDir: string, name: string, description: string): void {
	const dir = join(workspaceDir, ".skills", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
		"utf-8",
	);
}

describe("linked workspace prompt context", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "inno-linked-ctx-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("formats read-only linked workspace instructions with paths and purposes", () => {
		const section = formatLinkedWorkspacesSection([
			{ id: "ws-bank", name: "题库", purpose: "历年真题", absDir: "/tmp/ws-bank" },
			{ id: "ws-tpl", name: "模板", absDir: "/tmp/ws-tpl" },
		]);
		expect(section).toContain("# 关联工作区（只读参考）");
		expect(section).toContain("只读工具");
		expect(section).toContain("禁止向关联工作区写入或修改文件");
		expect(section).toContain("/tmp/ws-bank");
		expect(section).toContain("历年真题");
		expect(section).toContain("/tmp/ws-tpl");
		expect(formatLinkedWorkspacesSection([])).toBe("");
	});

	it("loads private skills from linked workspaces while letting active workspace win on collisions", async () => {
		const linkedA = join(root, "linked-a");
		const linkedB = join(root, "linked-b");
		writeSkill(linkedA, "shared-skill", "From linked A (should be skipped because active has it)");
		writeSkill(linkedA, "bank-search", "Search question bank");
		writeSkill(linkedB, "bank-search", "Duplicate from linked B (should be skipped)");
		writeSkill(linkedB, "rubric-gen", "Generate grading rubric");

		const section = await buildLinkedWorkspaceSkillsSection(
			[
				{ id: "a", name: "A", absDir: linkedA },
				{ id: "empty", name: "Empty", absDir: join(root, "no-skills") },
				{ id: "b", name: "B", absDir: linkedB },
			],
			new Set(["shared-skill"]),
		);

		expect(section).toContain("# 关联工作区私有技能（只读参考）");
		expect(section).toContain("bank-search");
		expect(section).toContain("Search question bank");
		expect(section).toContain("rubric-gen");
		expect(section).not.toContain("shared-skill");
		expect(section).not.toContain("Duplicate from linked B");
	});

	it("blocks unconfined execution in a linked session while allowing reads and local writes", async () => {
		const paths = resolveRuntimePaths({ home: root, dataDir: join(root, "data"), workspaceDir: join(root, "workspaces") });
		const registry = new WorkspaceRegistry(paths.workspaceDir, paths.dataDir);
		registry.ensureBootstrapped();
		const reference = registry.createWorkspace({ name: "Reference" });
		const current = registry.createWorkspace({ name: "Current", linkedWorkspaceIds: [reference.id] });
		let sessionId = "linked.jsonl";
		registry.bindSession(sessionId, current.id);
		registry.bindSession("unlinked.jsonl", reference.id);
		const config = {
			providers: {},
			memory: { l2: { enabled: false }, l3: { enabled: false } },
			plugins: { todo: { enabled: false }, webAccess: { enabled: false }, permissionSystem: { enabled: false } },
		} as unknown as InnoConfig;
		type ToolHandler = (event: { toolName: string; input: Record<string, unknown> }) => Promise<{ block: boolean } | undefined>;
		const handlers: ToolHandler[] = [];
		const pi = {
			on: (event: string, handler: ToolHandler) => { if (event === "tool_call") handlers.push(handler); },
			registerTool: vi.fn(),
			registerCommand: vi.fn(),
			registerShortcut: vi.fn(),
		} as unknown as ExtensionAPI;
		const call = async (toolName: string, input: Record<string, unknown>) => {
			for (const handler of handlers) {
				const result = await handler({ toolName, input });
				if (result?.block) return result;
			}
		};
		try {
			await createInnoExtension({ current: config }, paths, undefined, {
				workspaceRegistry: registry, getCurrentSessionId: () => sessionId,
			})(pi);
			const target = join(registry.resolveWorkspaceDir(reference.id)!, "notes.md");
			expect(await call("bash", { command: "pwd" })).toMatchObject({ block: true });
			expect(await call("subagent", {})).toMatchObject({ block: true });
			expect(await call("write", { path: target })).toMatchObject({ block: true });
			expect(await call("read", { path: target })).toBeUndefined();
			expect(await call("write", { path: "notes.md" })).toBeUndefined();
			sessionId = "unlinked.jsonl";
			expect(await call("bash", { command: "pwd" })).toBeUndefined();
		} finally {
			closeL2Memory(join(paths.dataDir, "l2"));
		}
	});
});
