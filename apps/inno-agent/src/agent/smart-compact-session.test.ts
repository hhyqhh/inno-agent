import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSessionEvent,
	type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InnoConfig } from "../config.js";
import { compactSessionManually } from "./pi-runner.js";
import { getSmartCompactSettingsPath, loadSmartCompactExtension } from "./smart-compact-extension.js";

const roots: string[] = [];

afterEach(() => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("Smart Compact through a real headless AgentSession", () => {
	it("forces manual Fast compaction below the automatic threshold without an approval UI", async () => {
		const root = mkdtempSync(join(tmpdir(), "inno-smart-compact-session-"));
		roots.push(root);
		vi.stubEnv("HOME", root);
		const configDir = join(root, "config");
		const workspaceDir = join(root, "workspace");
		mkdirSync(configDir, { recursive: true });
		mkdirSync(workspaceDir, { recursive: true });
		const config = { plugins: { smartCompact: { enabled: true } } } as InnoConfig;
		const extension = await loadSmartCompactExtension(config);
		expect(extension).not.toBeNull();
		// Keep the fixture small while still leaving Pi enough history to compact.
		const settingsPath = getSmartCompactSettingsPath();
		const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
		settings.compaction = { enabled: true, reserveTokens: 1_000, keepRecentTokens: 100 };
		settings.smartCompact.profiles = {
			aggressive: {
				summaryBudgetTokens: 256,
				keepRecentTokens: 1_000,
				minChunkTokens: 100,
				maxChunkTokens: 500,
				singlePassMaxTokens: 1_000,
				batchMaxTokens: 1_000,
			},
		};
		writeFileSync(settingsPath, JSON.stringify(settings));
		writeFileSync(join(configDir, "settings.json"), JSON.stringify({
			compaction: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 100 },
		}));
		const settingsManager = SettingsManager.create(workspaceDir, configDir);

		const provider = fauxProvider({
			provider: `faux-smart-compact-${Date.now()}`,
			models: [{ id: "faux-smart-compact", contextWindow: 25_000, maxTokens: 4_096 }],
		});
		const credentials = new InMemoryCredentialStore();
		await credentials.modify(provider.models[0].provider, async () => ({ type: "api_key", key: "faux-test-key" }));
		const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
		const providerExtension: ExtensionFactory = (pi) => { pi.registerProvider(provider.provider); };
		const resourceLoader = new DefaultResourceLoader({
			cwd: workspaceDir,
			agentDir: configDir,
			settingsManager,
			extensionFactories: [providerExtension, extension!],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt: "You are a deterministic compaction test model.",
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: workspaceDir,
			agentDir: configDir,
			model: provider.models[0],
			thinkingLevel: "off",
			modelRuntime,
			resourceLoader,
			sessionManager: SessionManager.inMemory(workspaceDir),
			settingsManager,
			noTools: "builtin",
		});
		try {
			expect(session.model?.contextWindow).toBe(25_000);
			await session.bindExtensions({ onError: (error) => { throw error; } });
			const facts = [
				"The launch date is 2026-11-23.",
				"The release owner is the learning team.",
				"The release checklist requires a full test run.",
				"The documentation must mention the manual compaction command.",
				...Array.from({ length: 8 }, (_, index) => `Release note ${index + 1} must remain traceable.`),
			];
			provider.setResponses(facts.map((fact, index) =>
				fauxAssistantMessage(`${fact} ${`Release context ${index + 1}. `.repeat(120)}`),
			));
			for (const fact of facts) await session.prompt(`Record this project fact: ${fact}`);
			const messagesBefore = session.messages.length;

			const summaryResponse = () => {
				// Smart Compact may use synthesis and verification calls. Keep this
				// deterministic provider available for all of them without a live API.
				provider.appendResponses([summaryResponse]);
				return fauxAssistantMessage([
					"## Goal",
					"Prepare the project release.",
					"## Decisions",
					"Launch date: 2026-11-23. Release owner: the learning team.",
					"## Open work",
					"None.",
				].join("\n"));
			};
			provider.setResponses([summaryResponse]);
			const events: AgentSessionEvent[] = [];
			const result = await compactSessionManually(session, true, (event) => events.push(event));

			expect(result).toBeDefined();
			expect(events.some((event) => event.type === "compaction_start" && event.reason === "manual")).toBe(true);
			expect(events.some((event) => event.type === "compaction_end" && event.reason === "manual" && event.result)).toBe(true);
			expect(result?.summary).toContain("## Goal");
			expect(session.messages.length).toBeLessThan(messagesBefore);
			expect(JSON.stringify(session.messages)).toContain("Release note");
		} finally {
			session.dispose();
		}
	}, 30_000);
});
