import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isSmartCompactEnabled, type InnoConfig } from "../config.js";
import {
	getSmartCompactSettingsPath,
	getSmartCompactSettingsView,
	isSmartCompactLoaded,
	isSmartCompactPreset,
	isSmartCompactRuntimeSupported,
	loadSmartCompactExtension,
	SMART_COMPACT_DEFAULTS,
	SMART_COMPACT_PRESETS,
	syncSmartCompactDefaults,
	updateSmartCompactPreset,
} from "./smart-compact-extension.js";

function readSettings(): Record<string, any> {
	return JSON.parse(readFileSync(getSmartCompactSettingsPath(), "utf-8"));
}

function writeSettings(settings: unknown): void {
	const path = getSmartCompactSettingsPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(settings));
}

const enabledConfig = { plugins: { smartCompact: { enabled: true } } } as InnoConfig;

describe("Smart Compact settings", () => {
	let home: string;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "inno-smart-compact-"));
		vi.stubEnv("HOME", home);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(home, { recursive: true, force: true });
	});

	it("seeds 300K-oriented defaults in the plugin's real global settings path", () => {
		writeSettings({ retry: { provider: { timeoutMs: 123 } } });
		syncSmartCompactDefaults();
		expect(getSmartCompactSettingsPath()).toBe(join(home, ".pi", "agent", "settings.json"));
		const settings = readSettings();
		expect(settings.retry).toEqual({ provider: { timeoutMs: 123 } });
		expect(settings.smartCompact).toEqual(SMART_COMPACT_DEFAULTS);
		expect(settings.smartCompact.maxContextTokens * settings.smartCompact.minContextPercent / 100).toBe(297_000);
		expect(settings.smartCompact.maxContextTokens * settings.smartCompact.prepareContextPercent / 100).toBe(264_000);
		// Headless /compact-now is explicit user approval; agent tools remain off.
		expect(settings.smartCompact.requireApproval).toBe(false);
		expect(settings.smartCompact.agentToolAccess).toBe("disabled");
	});

	it("preserves every user override and only fills missing keys", () => {
		writeSettings({
			smartCompact: { minContextPercent: 70, artifactOffloadEnabled: false },
			compaction: { keepRecentTokens: 4567 },
		});
		syncSmartCompactDefaults();
		const settings = readSettings();
		expect(settings.smartCompact.minContextPercent).toBe(70);
		expect(settings.smartCompact.artifactOffloadEnabled).toBe(false);
		expect(settings.smartCompact.maxContextTokens).toBe(330_000);
		expect(settings.compaction).toEqual({ keepRecentTokens: 4567 });
	});

	it("does not rewrite a non-object smartCompact user value", () => {
		writeSettings({ smartCompact: false });
		syncSmartCompactDefaults();
		expect(readSettings()).toEqual({ smartCompact: false });
	});

	it("leaves a corrupt global settings file untouched", () => {
		const path = getSmartCompactSettingsPath();
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, "{ broken");
		syncSmartCompactDefaults();
		expect(readFileSync(path, "utf8")).toBe("{ broken");
	});

	it("creates the parent directory for a first-time Pi user", () => {
		expect(existsSync(dirname(getSmartCompactSettingsPath()))).toBe(false);
		syncSmartCompactDefaults();
		expect(readSettings().smartCompact).toEqual(SMART_COMPACT_DEFAULTS);
	});

	it("reports preset state without creating or changing the global file", () => {
		expect(getSmartCompactSettingsView(enabledConfig)).toMatchObject({
			enabled: true,
			preset: "300k",
			settingsError: false,
		});
		expect(existsSync(getSmartCompactSettingsPath())).toBe(false);
		writeSettings({ smartCompact: { ...SMART_COMPACT_PRESETS["150k"], minContextPercent: 75 } });
		expect(getSmartCompactSettingsView(enabledConfig).preset).toBe("custom");
	});

	it("applies threshold presets while preserving unrelated user settings", () => {
		writeSettings({
			retry: { provider: { timeoutMs: 123 } },
			smartCompact: { ...SMART_COMPACT_PRESETS["300k"], requireApproval: false, customOption: "keep" },
		});
		updateSmartCompactPreset("150k");
		let settings = readSettings();
		expect(settings.retry).toEqual({ provider: { timeoutMs: 123 } });
		expect(settings.smartCompact).toMatchObject({
			...SMART_COMPACT_PRESETS["150k"],
			requireApproval: false,
			customOption: "keep",
		});
		expect(settings.smartCompact.maxContextTokens * settings.smartCompact.minContextPercent / 100).toBe(153_000);
		updateSmartCompactPreset("500k");
		settings = readSettings();
		expect(settings.smartCompact).toMatchObject(SMART_COMPACT_PRESETS["500k"]);
		expect(settings.smartCompact.customOption).toBe("keep");
		expect(settings.smartCompact.maxContextTokens * settings.smartCompact.minContextPercent / 100).toBe(504_000);
	});

	it("rejects invalid preset names and never repairs corrupt global JSON", () => {
		expect(isSmartCompactPreset("150k")).toBe(true);
		expect(isSmartCompactPreset("custom")).toBe(false);
		expect(isSmartCompactPreset("__proto__")).toBe(false);
		const path = getSmartCompactSettingsPath();
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, "{ broken");
		expect(getSmartCompactSettingsView(enabledConfig)).toMatchObject({ preset: "custom", settingsError: true });
		expect(() => updateSmartCompactPreset("150k")).toThrow("invalid JSON");
		expect(readFileSync(path, "utf8")).toBe("{ broken");
	});
});

describe("Smart Compact loading", () => {
	let home: string;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "inno-smart-compact-load-"));
		vi.stubEnv("HOME", home);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(home, { recursive: true, force: true });
	});

	it("loads the real compiled extension and reports it available", async () => {
		const extension = await loadSmartCompactExtension(enabledConfig);
		expect(typeof extension).toBe("function");
		expect(isSmartCompactLoaded()).toBe(true);
		expect(existsSync(getSmartCompactSettingsPath())).toBe(true);
	});

	it("skips loading and settings writes when explicitly disabled", async () => {
		const extension = await loadSmartCompactExtension({ plugins: { smartCompact: { enabled: false } } } as InnoConfig);
		expect(extension).toBeNull();
		expect(isSmartCompactLoaded()).toBe(false);
		expect(existsSync(getSmartCompactSettingsPath())).toBe(false);
	});

	it("uses an explicit opt-out while defaulting to enabled", () => {
		expect(isSmartCompactEnabled({} as InnoConfig)).toBe(true);
		expect(isSmartCompactEnabled(enabledConfig)).toBe(true);
		expect(isSmartCompactEnabled({ plugins: { smartCompact: { enabled: false } } } as InnoConfig)).toBe(false);
	});

	it("gates the plugin to its supported Node runtime", () => {
		expect(isSmartCompactRuntimeSupported("22.19.0")).toBe(true);
		expect(isSmartCompactRuntimeSupported("23.0.0")).toBe(true);
		expect(isSmartCompactRuntimeSupported("22.18.9")).toBe(false);
		expect(isSmartCompactRuntimeSupported("20.19.0")).toBe(false);
	});
});
