import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { normalizeConfig } from "../config.js";
import { resolveRuntimePaths } from "../runtime.js";
import { proposeWorkspaceDraft } from "../workspace/workspace-draft.js";
import { completePromptOnce, initSession } from "./pi-runner.js";

it.each([
	{ baseUrl: "https://api.deepseek.com/v1", defaultThinking: true },
	{ baseUrl: "https://gateway.example.invalid/v1", defaultThinking: false },
])("generates a workspace draft through $baseUrl", async ({ baseUrl, defaultThinking }) => {
	const home = await mkdtemp(join(tmpdir(), "inno-draft-"));
	const paths = resolveRuntimePaths({
		home, configDir: join(home, "config"), dataDir: join(home, "data"),
		skillsDir: join(home, "skills"), workspaceDir: join(home, "workspace"),
	});
	await mkdir(paths.configDir);
	vi.stubEnv("PI_CODING_AGENT_DIR", paths.configDir);
	const fetchStub = vi.fn(async (_input: unknown, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body));
		const thinking = defaultThinking && body.thinking?.type !== "disabled";
		const delta = thinking
			? { reasoning_content: "Thinking reached the output limit" }
			: { content: JSON.stringify({ name: "备课", purpose: "准备教案" }) };
		const chunk = { choices: [{ index: 0, delta, finish_reason: thinking ? "length" : "stop" }] };
		return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
			headers: { "Content-Type": "text/event-stream" },
		});
	});
	vi.stubGlobal("fetch", fetchStub);
	let session: Awaited<ReturnType<typeof initSession>> | undefined;
	try {
		session = await initSession(normalizeConfig({
			providers: {
				fixture: {
					baseUrl,
					apiKey: "fixture-key",
					models: [{ id: "deepseek-flash", name: "DeepSeek Flash", reasoning: false,
						input: ["text"], contextWindow: 128_000, maxTokens: 8192 }],
				},
			},
			plugins: { smartCompact: { enabled: false } },
		}), paths);
		expect(session.model?.reasoning).toBe(false);

		const draft = await proposeWorkspaceDraft("备课与教案编写", [], [], completePromptOnce);

		expect(draft).toMatchObject({ name: "备课", purpose: "准备教案" });
		expect(fetchStub).toHaveBeenCalledOnce();
		const payload = JSON.parse(String(fetchStub.mock.calls[0]?.[1]?.body));
		if (defaultThinking) {
			expect(payload).toMatchObject({ max_tokens: 2048, thinking: { type: "disabled" } });
		} else {
			expect(payload).not.toHaveProperty("thinking");
		}
		expect(session.model?.reasoning).toBe(false);
	} finally {
		session?.dispose();
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		await rm(home, { recursive: true, force: true });
	}
});
