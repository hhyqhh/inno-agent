import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { isSmartCompactEnabled, type InnoConfig } from "../config.js";
import { writeJson } from "../storage/file-store.js";
import { logger } from "../logger.js";

/**
 * Managed defaults for the bundled pi-smart-compact extension.
 *
 * With a large native model window these start cleanup around 264K tokens and
 * request compaction at the next idle boundary around 297K. Smaller windows
 * use the same percentages of their real window. Existing user settings always
 * win; disabling the plugin only skips loading it and never rewrites this block.
 * Unlike Inno's other PI settings, this block lives in ~/.pi/agent/settings.json
 * because that is the only configuration file the plugin reads.
 */
export const SMART_COMPACT_PRESETS = {
	"150k": { maxContextTokens: 170_000, minContextPercent: 90, prepareContextPercent: 80 },
	"300k": { maxContextTokens: 330_000, minContextPercent: 90, prepareContextPercent: 80 },
	"500k": { maxContextTokens: 560_000, minContextPercent: 90, prepareContextPercent: 80 },
} as const;

export type SmartCompactPreset = keyof typeof SMART_COMPACT_PRESETS;

export const SMART_COMPACT_DEFAULTS = {
	autoTrigger: true,
	autoTriggerStrategy: "settled",
	...SMART_COMPACT_PRESETS["300k"],
	contextHygieneEnabled: true,
	contextPressureOnly: true,
	artifactOffloadEnabled: true,
	zeroCallEnabled: true,
	// /compact-now is the user's explicit authorization. Headless sessions have
	// no result-approval UI, so leaving this enabled cancels every Web request.
	// Agent tools stay disabled, so this cannot authorize plugin memory writes.
	requireApproval: false,
	agentToolAccess: "disabled",
} as const;

type SettingsRecord = Record<string, unknown>;

interface SmartCompactFile {
	settings: SettingsRecord;
	smartCompact: SettingsRecord;
}

export interface SmartCompactSettingsView {
	enabled: boolean;
	preset: SmartCompactPreset | "custom";
	runtimeSupported: boolean;
	settingsError: boolean;
}

let smartCompactLoaded = false;

/**
 * Smart Compact intentionally reads only Pi's global settings file; it does
 * not honor PI_CODING_AGENT_DIR. Keep this path resolution identical to the
 * plugin (including HOME overrides used by isolated tests). Other PI settings
 * remain in Inno's own configDir.
 */
export function getSmartCompactSettingsPath(): string {
	const home = process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || homedir();
	return join(home, ".pi", "agent", "settings.json");
}

/** Read the shared Pi file without ever replacing malformed user content. */
function readSmartCompactFile(): SmartCompactFile | null {
	const settingsPath = getSmartCompactSettingsPath();
	if (!existsSync(settingsPath)) return { settings: {}, smartCompact: {} };
	try {
		const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf-8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
		const settings = parsed as SettingsRecord;
		const existing = settings.smartCompact;
		if (existing !== undefined && (typeof existing !== "object" || existing === null || Array.isArray(existing))) return null;
		return { settings, smartCompact: (existing ?? {}) as SettingsRecord };
	} catch {
		return null;
	}
}

export function isSmartCompactPreset(value: unknown): value is SmartCompactPreset {
	return typeof value === "string" && Object.prototype.hasOwnProperty.call(SMART_COMPACT_PRESETS, value);
}

/** Effective state for the settings UI; reading it never writes the global file. */
export function getSmartCompactSettingsView(config: InnoConfig): SmartCompactSettingsView {
	const file = readSmartCompactFile();
	const current = { ...SMART_COMPACT_DEFAULTS, ...file?.smartCompact };
	const preset = (Object.keys(SMART_COMPACT_PRESETS) as SmartCompactPreset[]).find((candidate) => {
		const values = SMART_COMPACT_PRESETS[candidate];
		return current.maxContextTokens === values.maxContextTokens &&
			current.minContextPercent === values.minContextPercent &&
			current.prepareContextPercent === values.prepareContextPercent;
	}) ?? "custom";
	return {
		enabled: isSmartCompactEnabled(config),
		preset: file === null ? "custom" : preset,
		runtimeSupported: isSmartCompactRuntimeSupported(),
		settingsError: file === null,
	};
}

/** Update only the three preset-owned keys, preserving all other Pi settings. */
export function updateSmartCompactPreset(preset: SmartCompactPreset): void {
	const file = readSmartCompactFile();
	if (!file) throw new Error(`Cannot update Smart Compact: invalid JSON in ${getSmartCompactSettingsPath()}`);
	file.settings.smartCompact = { ...file.smartCompact, ...SMART_COMPACT_PRESETS[preset] };
	writeJson(getSmartCompactSettingsPath(), file.settings);
}

/** Smart Compact upstream requires Node 22.19+; older Inno runtimes keep native compaction. */
export function isSmartCompactRuntimeSupported(version = process.versions.node): boolean {
	const [major, minor] = version.split(".").map(Number);
	return Number.isFinite(major) && Number.isFinite(minor) && (major > 22 || major === 22 && minor >= 19);
}

/** Whether the optional extension loaded successfully during this boot. */
export function isSmartCompactLoaded(): boolean {
	return smartCompactLoaded;
}

/** Fill missing Smart Compact keys without clobbering unrelated PI settings. */
export function syncSmartCompactDefaults(): void {
	const settingsPath = getSmartCompactSettingsPath();
	const file = readSmartCompactFile();
	if (!file) {
		// This is the user's global Pi file, not an Inno-owned file. Never
		// replace unrelated settings just to recover a malformed JSON document.
		logger.warn({ settingsPath }, "Invalid PI or Smart Compact settings; leaving the global file unchanged");
		return;
	}
	const { settings, smartCompact: current } = file;
	let changed = false;
	for (const [key, value] of Object.entries(SMART_COMPACT_DEFAULTS)) {
		if (current[key] === undefined) {
			current[key] = value;
			changed = true;
		}
	}
	if (!changed) return;
	settings.smartCompact = current;
	writeJson(settingsPath, settings);
}

/**
 * Load the bundled extension in both CLI and SDK/server mode. The package ships
 * compiled ESM, so unlike the TS-only plugins it does not need jiti. A broken
 * optional extension must not prevent the agent from booting: native Pi
 * compaction remains available when loading fails.
 */
export async function loadSmartCompactExtension(
	config: InnoConfig,
): Promise<ExtensionFactory | null> {
	if (!isSmartCompactEnabled(config)) {
		smartCompactLoaded = false;
		return null;
	}
	if (!isSmartCompactRuntimeSupported()) {
		smartCompactLoaded = false;
		logger.warn({ node: process.versions.node }, "pi-smart-compact requires Node 22.19+; using Pi native compaction");
		return null;
	}
	try {
		syncSmartCompactDefaults();
		const mod = await import("pi-smart-compact");
		if (typeof mod.default !== "function") throw new TypeError("pi-smart-compact has no default extension factory");
		smartCompactLoaded = true;
		return mod.default as ExtensionFactory;
	} catch (err) {
		smartCompactLoaded = false;
		logger.warn({ err }, "Failed to load pi-smart-compact; falling back to Pi native compaction");
		return null;
	}
}
