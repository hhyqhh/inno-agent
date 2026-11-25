import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { InnoConfig } from "../config.js";
import { closeL2Memory } from "../memory/l2/l2-memory.js";
import { closeL3Memory } from "../memory/l3/l3-tools.js";
import { resolveRuntimePaths } from "../runtime.js";
import {
	createInnoExtension,
	expandInnoSlashCommand,
	INNO_SLASH_COMMAND_NAMES,
	INNO_WEB_SAFE_COMMAND_NAMES,
	isCompactNowCommand,
} from "./inno-extension.js";
import { loadSmartCompactExtension } from "./smart-compact-extension.js";

const tempDirs: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const dir of tempDirs.splice(0)) {
		closeL2Memory(join(dir, "inno", "data", "l2"));
		closeL3Memory(join(dir, "inno", "data", "l3"));
		rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

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

	it("treats manual compaction as an action rather than prompt expansion", () => {
		expect(expandInnoSlashCommand("/compact-now")).toBeNull();
		expect(INNO_WEB_SAFE_COMMAND_NAMES.has("compact-now")).toBe(true);
		expect([...INNO_WEB_SAFE_COMMAND_NAMES].sort()).toEqual(["compact-now", "recall", "remember", "skill-create", "wiki"]);
	});

	it("recognizes only the bare compact-now command", () => {
		expect(isCompactNowCommand("/compact-now")).toBe(true);
		expect(isCompactNowCommand("  /compact-now\n")).toBe(true);
		expect(isCompactNowCommand("/compact-now please")).toBe(false);
		expect(isCompactNowCommand("/compact-now-extra")).toBe(false);
		expect(isCompactNowCommand("hello /compact-now")).toBe(false);
	});
});

describe("compact-now extension command", () => {
	function smartConfig(smartCompactEnabled: boolean): InnoConfig {
		return {
			defaultProvider: "test",
			defaultModel: "test-model",
			providers: {},
			memory: { l1Enabled: false, l2Enabled: false, l3Enabled: false },
			plugins: {
				smartCompact: { enabled: smartCompactEnabled },
				webAccess: { enabled: false },
				computerUse: { enabled: false },
				permissionSystem: { enabled: false },
				subagents: { enabled: false },
			},
		} as InnoConfig;
	}

	function setup(config: InnoConfig) {
		const root = mkdtempSync(join(tmpdir(), "inno-compact-command-"));
		tempDirs.push(root);
		vi.stubEnv("HOME", root);
		const paths = resolveRuntimePaths({
			home: join(root, "inno"),
			dataDir: join(root, "inno", "data"),
			workspaceDir: join(root, "workspace"),
		});
		const pi = {
			registerProvider: vi.fn(),
			registerTool: vi.fn(),
			registerCommand: vi.fn(),
			registerShortcut: vi.fn(),
			sendUserMessage: vi.fn(),
			on: vi.fn(),
		} as unknown as ExtensionAPI;
		return { config, paths, pi };
	}

	function compactHandler(pi: ExtensionAPI) {
		const call = (pi.registerCommand as any).mock.calls.find(([name]: [string]) => name === "compact-now");
		expect(call).toBeDefined();
		return call[1].handler as (args: string, ctx: any) => Promise<void>;
	}

	it("dispatches Smart Compact Fast when the real plugin is loaded", async () => {
		const config = smartConfig(true);
		const { paths, pi } = setup(config);
		await loadSmartCompactExtension(config);
		await createInnoExtension({ current: config }, paths)(pi);
		const ctx = { hasUI: true, compact: vi.fn(), ui: { notify: vi.fn() } };
		await compactHandler(pi)("", ctx);
		expect(pi.sendUserMessage).toHaveBeenCalledWith("/smart-compact fast", { expandPromptTemplates: true });
		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("falls back to native compaction when Smart Compact is disabled", async () => {
		const config = smartConfig(false);
		const { paths, pi } = setup(config);
		await loadSmartCompactExtension(config);
		await createInnoExtension({ current: config }, paths)(pi);
		const ctx = { hasUI: true, compact: vi.fn(), ui: { notify: vi.fn() } };
		await compactHandler(pi)("", ctx);
		expect(ctx.compact).toHaveBeenCalledOnce();
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
	});

	it("rejects arguments without starting either compaction path", async () => {
		const config = smartConfig(false);
		const { paths, pi } = setup(config);
		await loadSmartCompactExtension(config);
		await createInnoExtension({ current: config }, paths)(pi);
		const ctx = { hasUI: true, compact: vi.fn(), ui: { notify: vi.fn() } };
		await compactHandler(pi)("please", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith("用法: /compact-now", "warning");
		expect(ctx.compact).not.toHaveBeenCalled();
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
	});
});
