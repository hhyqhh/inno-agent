import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	WEB_ACCESS_CONFIG_FILE,
	WEB_ACCESS_PROVIDERS,
	getWebAccessSettingsView,
	readWebAccessConfig,
	updateWebAccessSettings,
} from "./web-access-config.js";

describe("web-access settings: keenable", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "inno-web-access-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("lists keenable as a key provider whose key is optional", () => {
		const spec = WEB_ACCESS_PROVIDERS.find((p) => p.id === "keenable");
		expect(spec).toEqual({ id: "keenable", kind: "key", field: "keenableApiKey", keyOptional: true });
		const others = getWebAccessSettingsView(dir).providers.filter((p) => p.id !== "keenable");
		expect(others.every((p) => p.keyOptional === false)).toBe(true);
	});

	it("does not change the default provider", () => {
		writeFileSync(join(dir, WEB_ACCESS_CONFIG_FILE), JSON.stringify({ tavilyApiKey: "tvly-1234" }));
		const view = getWebAccessSettingsView(dir);
		expect(view.defaultProvider).toBe("auto");
		const keenable = view.providers.find((p) => p.id === "keenable");
		expect(keenable).toMatchObject({ configured: false, maskedValue: "", keyOptional: true });
	});

	it("stores, masks and clears keenableApiKey without touching other keys", () => {
		writeFileSync(join(dir, WEB_ACCESS_CONFIG_FILE), JSON.stringify({ tavilyApiKey: "tvly-1234" }));
		let view = updateWebAccessSettings(dir, { values: { keenable: "kn-secret-9876" } });
		expect(readWebAccessConfig(dir)).toEqual({ tavilyApiKey: "tvly-1234", keenableApiKey: "kn-secret-9876" });
		expect(view.providers.find((p) => p.id === "keenable")).toMatchObject({ configured: true, maskedValue: "****9876" });

		// A masked echo keeps the stored key.
		updateWebAccessSettings(dir, { values: { keenable: "****9876" } });
		expect(readWebAccessConfig(dir).keenableApiKey).toBe("kn-secret-9876");

		view = updateWebAccessSettings(dir, { values: { keenable: "" } });
		expect(readWebAccessConfig(dir)).toEqual({ tavilyApiKey: "tvly-1234" });
		expect(view.providers.find((p) => p.id === "keenable")?.configured).toBe(false);
	});

	it("can be picked as the default provider without a key", () => {
		const view = updateWebAccessSettings(dir, { provider: "keenable" });
		expect(view.defaultProvider).toBe("keenable");
		expect(readWebAccessConfig(dir)).toEqual({ provider: "keenable" });
	});
});
