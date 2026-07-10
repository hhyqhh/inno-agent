/**
 * Sync Inno provider config to PI's standard models.json so that
 * subagent child processes (which are plain `pi` CLI invocations)
 * can use the same providers as the parent agent.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { InnoConfig } from "../config.js";
import { logger } from "../logger.js";

const INNO_MANAGED_MARKER = "__inno_managed";

function getAgentDir(): string {
	const configured = process.env.PI_CODING_AGENT_DIR;
	if (configured === "~") return homedir();
	if (configured?.startsWith("~/")) return join(homedir(), configured.slice(2));
	return configured || join(homedir(), ".pi", "agent");
}

interface PiModelsJson {
	[INNO_MANAGED_MARKER]?: boolean;
	providers: Record<string, {
		baseUrl?: string;
		apiKey?: string;
		api?: string;
		headers?: Record<string, string>;
		authHeader?: boolean;
		models?: Array<{
			id: string;
			name?: string;
			reasoning?: boolean;
			contextWindow?: number;
			maxTokens?: number;
		}>;
	}>;
}

interface PiSettingsJson {
	[key: string]: unknown;
	defaultProvider?: string;
	defaultModel?: string;
}

/**
 * Write Inno's configured providers into `~/.pi/agent/models.json`
 * and set default provider/model in `~/.pi/agent/settings.json`.
 *
 * Only overwrites provider entries that came from Inno — leaves
 * any manually-added providers untouched.
 */
export function syncProvidersForSubagents(config: InnoConfig): void {
	const agentDir = getAgentDir();
	mkdirSync(agentDir, { recursive: true });

	// --- models.json ---
	const modelsPath = join(agentDir, "models.json");
	let existing: PiModelsJson = { providers: {} };
	if (existsSync(modelsPath)) {
		try {
			existing = JSON.parse(readFileSync(modelsPath, "utf-8")) as PiModelsJson;
			if (!existing.providers) existing.providers = {};
		} catch (err) {
			logger.warn({ err }, "Failed to parse existing models.json, starting fresh");
			existing = { providers: {} };
		}
	}

	for (const [providerId, providerConfig] of Object.entries(config.providers)) {
		existing.providers[providerId] = {
			baseUrl: providerConfig.baseUrl,
			apiKey: providerConfig.apiKey,
			api: providerConfig.api,
			headers: providerConfig.headers,
			authHeader: providerConfig.authHeader,
			models: providerConfig.models.map((m) => ({
				id: m.id,
				name: m.name,
				reasoning: m.reasoning,
				contextWindow: m.contextWindow,
				maxTokens: m.maxTokens,
			})),
		};
	}

	existing[INNO_MANAGED_MARKER] = true;
	writeFileSync(modelsPath, `${JSON.stringify(existing, null, 2)}\n`, "utf-8");

	// --- settings.json (merge defaultProvider/defaultModel only) ---
	const settingsPath = join(agentDir, "settings.json");
	let settings: PiSettingsJson = {};
	if (existsSync(settingsPath)) {
		try {
			settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as PiSettingsJson;
		} catch (err) {
			logger.warn({ err }, "Failed to parse existing settings.json, starting fresh");
			settings = {};
		}
	}

	settings.defaultProvider = config.defaultProvider;
	settings.defaultModel = config.defaultModel;
	writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");

	const providerCount = Object.keys(existing.providers).length;
	logger.info({ providerCount, agentDir }, "Subagent providers synced");
}
