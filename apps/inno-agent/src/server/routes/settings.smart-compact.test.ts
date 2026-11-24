import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InnoConfig } from "../../config.js";
import { saveConfig } from "../../config.js";
import type { RuntimePaths } from "../../runtime.js";
import { getSmartCompactSettingsPath, SMART_COMPACT_PRESETS } from "../../agent/smart-compact-extension.js";
import { handleSettingsRoutes } from "./settings.js";

vi.mock("../../agent/pi-runner.js", () => ({
	getSessionIfInitialized: () => null,
	getAvailableModels: vi.fn(() => []),
	refreshConfiguredProviders: vi.fn(),
	switchModel: vi.fn(),
	syncConfig: vi.fn(),
}));
vi.mock("../../config.js", async (original) => ({
	...await original<typeof import("../../config.js")>(),
	saveConfig: vi.fn((_path, config) => config),
}));

describe("Smart Compact settings routes", () => {
	let home: string;
	let config: InnoConfig;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "inno-smart-compact-route-"));
		vi.stubEnv("HOME", home);
		config = {
			defaultProvider: "test",
			defaultModel: "test-model",
			providers: {},
			plugins: { smartCompact: { enabled: true } },
		} as InnoConfig;
		vi.mocked(saveConfig).mockClear();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(home, { recursive: true, force: true });
	});

	async function request(body: unknown): Promise<{ status: number; payload: any }> {
		const req = Readable.from([Buffer.from(JSON.stringify(body))]) as IncomingMessage;
		req.headers = {};
		let status = 0;
		let responseBody = "";
		const res = {
			writeHead: vi.fn((code: number) => { status = code; }),
			end: vi.fn((chunk?: string) => { responseBody = chunk ?? ""; }),
		} as unknown as ServerResponse;
		const ctx = {
			paths: { configPath: join(home, "config.json") } as RuntimePaths,
			getConfig: () => config,
			setConfig: (next: InnoConfig) => { config = next; },
			reloadFeishuChannel: vi.fn(),
			scheduleSkillsReload: vi.fn(),
			invalidateContentSource: vi.fn(),
		};
		expect(await handleSettingsRoutes(req, res, "PUT", "/api/settings/smart-compact", ctx)).toBe(true);
		return { status, payload: responseBody ? JSON.parse(responseBody) : {} };
	}

	it("persists the enable switch in Inno config and returns restartable desired state", async () => {
		const result = await request({ enabled: false });
		expect(result.status).toBe(200);
		expect(config.plugins?.smartCompact?.enabled).toBe(false);
		expect(result.payload.smartCompact).toMatchObject({ enabled: false, preset: "300k" });
		expect(saveConfig).toHaveBeenCalledOnce();
	});

	it("writes a preset to the real global file without touching unrelated settings", async () => {
		const path = getSmartCompactSettingsPath();
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify({
			retry: { provider: { timeoutMs: 456 } },
			smartCompact: { requireApproval: false, customOption: "keep" },
		}));
		const result = await request({ preset: "150k" });
		expect(result.status).toBe(200);
		expect(result.payload.smartCompact).toMatchObject({ enabled: true, preset: "150k" });
		const saved = JSON.parse(readFileSync(path, "utf8"));
		expect(saved.retry).toEqual({ provider: { timeoutMs: 456 } });
		expect(saved.smartCompact).toMatchObject({ ...SMART_COMPACT_PRESETS["150k"], requireApproval: false, customOption: "keep" });
		expect(saveConfig).not.toHaveBeenCalled();
	});

	it.each([
		[{ preset: "900k" }, "preset must be one of"],
		[{ enabled: "yes" }, "enabled must be a boolean"],
		[{}, "Provide enabled"],
	])("rejects invalid payload %j without writing either file", async (body, message) => {
		const result = await request(body);
		expect(result.status).toBe(400);
		expect(result.payload.error).toContain(message);
		expect(saveConfig).not.toHaveBeenCalled();
	});

	it("returns a server error and preserves corrupt global JSON", async () => {
		const path = getSmartCompactSettingsPath();
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, "{ broken");
		const result = await request({ preset: "500k" });
		expect(result.status).toBe(500);
		expect(readFileSync(path, "utf8")).toBe("{ broken");
		expect(saveConfig).not.toHaveBeenCalled();
	});
});
