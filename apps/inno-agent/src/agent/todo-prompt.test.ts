import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { InnoConfig } from "../config.js";
import { closeL2Memory } from "../memory/l2/l2-memory.js";
import { closeL3Memory } from "../memory/l3/l3-tools.js";
import { resolveRuntimePaths } from "../runtime.js";
import { createInnoExtension } from "./inno-extension.js";
import { TODO_PROMPT_HINT } from "./system-prompt.js";

const tempDirs: string[] = [];

function createTempPaths() {
	const dir = mkdtempSync(join(tmpdir(), "inno-todo-prompt-"));
	tempDirs.push(dir);
	return resolveRuntimePaths({
		home: dir,
		dataDir: join(dir, "data"),
		workspaceDir: join(dir, "workspace"),
	});
}

function createFakePi() {
	const handlers = new Map<string, Array<(event: any, ctx: any) => Promise<any> | any>>();
	const registeredTools: Array<{ name: string; promptGuidelines?: string[] }> = [];
	const pi = {
		registerProvider: vi.fn(),
		registerTool: vi.fn((tool: { name: string; promptGuidelines?: string[] }) => {
			registeredTools.push(tool);
		}),
		registerCommand: vi.fn(),
		registerShortcut: vi.fn(),
		on: vi.fn((event: string, handler: (event: any, ctx: any) => Promise<any> | any) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		}),
	} as unknown as ExtensionAPI;
	return { pi, handlers, registeredTools };
}

function makeConfig(todoEnabled?: boolean): InnoConfig {
	return {
		defaultProvider: "test",
		defaultModel: "test-model",
		providers: {},
		memory: { l1: { enabled: false }, l3: { enabled: false } },
		plugins: {
			todo: todoEnabled === undefined ? {} : { enabled: todoEnabled },
			webAccess: { enabled: false },
			computerUse: { enabled: false },
			permissionSystem: { enabled: false },
			subagents: { enabled: false },
		},
	} as unknown as InnoConfig;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop()!;
		closeL2Memory(join(dir, "data", "l2"));
		closeL3Memory(join(dir, "data", "l3"));
		rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

describe("todo prompt instructions in inno-extension", () => {
	it("injects TODO_PROMPT_HINT and preserves rpiv-todo guidelines when todo plugin is enabled", async () => {
		const paths = createTempPaths();
		const { pi, handlers, registeredTools } = createFakePi();
		const factory = createInnoExtension({ current: makeConfig(true) }, paths);
		await factory(pi);

		const todoTool = registeredTools.find((tool) => tool.name === "todo");
		expect(todoTool).toBeDefined();
		expect(todoTool?.promptGuidelines?.some((g) => g.includes("in_progress"))).toBe(true);

		const beforeStartHandlers = handlers.get("before_agent_start") ?? [];
		expect(beforeStartHandlers.length).toBeGreaterThan(0);

		const baseSystemPrompt = "<rules>\n- rpiv-todo guideline sentinel\n</rules>";
		const result = await beforeStartHandlers[0](
			{ type: "before_agent_start", prompt: "执行多步任务", systemPrompt: baseSystemPrompt },
			{ sessionManager: { getSessionFile: () => undefined } },
		);

		expect(result?.systemPrompt).toContain(TODO_PROMPT_HINT.trim());
		expect(result?.systemPrompt).toContain("in_progress");
		expect(result?.systemPrompt).toContain("completed");
		expect(result?.systemPrompt).toContain("最终回复用户前，核对 todo 清单");
		expect(result?.systemPrompt).toContain("等待用户确认/补充/回答的任务，不得误标为 completed");
		expect(result?.systemPrompt).toContain(baseSystemPrompt);
	});

	it("omits TODO_PROMPT_HINT and skips registering todo tool when plugins.todo.enabled is false", async () => {
		const paths = createTempPaths();
		const { pi, handlers, registeredTools } = createFakePi();
		const factory = createInnoExtension({ current: makeConfig(false) }, paths);
		await factory(pi);

		expect(registeredTools.find((tool) => tool.name === "todo")).toBeUndefined();

		const beforeStartHandlers = handlers.get("before_agent_start") ?? [];
		const result = await beforeStartHandlers[0](
			{ type: "before_agent_start", prompt: "执行多步任务", systemPrompt: "<rules></rules>" },
			{ sessionManager: { getSessionFile: () => undefined } },
		);

		expect(result?.systemPrompt).not.toContain(TODO_PROMPT_HINT.trim());
	});
});
