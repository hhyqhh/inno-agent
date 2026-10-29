import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { InnoConfig } from "../../config.js";
import type { RuntimePaths } from "../../runtime.js";
import { saveConfig } from "../../config.js";
import { handleSettingsRoutes } from "./settings.js";

vi.mock("../../agent/pi-runner.js", () => ({ getSessionIfInitialized: () => null }));
vi.mock("../../config.js", async (original) => ({
	...await original<typeof import("../../config.js")>(),
	saveConfig: vi.fn((_path, config) => config),
}));

describe("theme settings", () => {
	it("persists and returns the system preference without replacing other UI settings", async () => {
		let config = { providers: {}, ui: { theme: "light", closeBehavior: "hide", mathSingleDollar: true } } as InnoConfig;
		const ctx = { paths: { configPath: "/test/config.json" } as RuntimePaths, getConfig: () => config, setConfig: (next: InnoConfig) => { config = next; }, reloadFeishuChannel: vi.fn(), scheduleSkillsReload: vi.fn(), invalidateContentSource: vi.fn() };
		const end = vi.fn(), writeHead = vi.fn();
		const res = { end, writeHead } as unknown as ServerResponse;
		const req = Readable.from([Buffer.from(JSON.stringify({ theme: "system" }))]) as IncomingMessage;
		req.headers = {};
		expect(await handleSettingsRoutes(req, res, "PUT", "/api/settings/theme", ctx)).toBe(true);
		expect(writeHead).toHaveBeenCalledWith(200, expect.anything());
		expect(config.ui).toEqual({ theme: "system", closeBehavior: "hide", mathSingleDollar: true });
		expect(saveConfig).toHaveBeenCalledOnce();
		expect(JSON.parse(end.mock.calls[0][0]).ui.theme).toBe("system");
	});
});
