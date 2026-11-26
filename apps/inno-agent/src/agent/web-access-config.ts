/**
 * Managed default for pi-web-access's config file (`web-search.json`).
 *
 * pi-web-access reads its config from `$PI_CODING_AGENT_DIR/web-search.json`,
 * which runtime.ts points at inno's configDir. The integration policy
 * encoded here is COEXISTENCE with inno's built-in Tavily `web_search`:
 *
 * 1. Renamed, not disabled: pi-web-access's own search tool would silently
 *    override inno's `web_search` at the PI tool registry (last registration
 *    wins, no error). The managed default renames it to `web_research` via
 *    `toolNames` so both stay registered — inno's tool keeps quick Tavily
 *    search (advanced depth, news/finance topics, settings-UI key card),
 *    `web_research` adds multi-provider / multi-query research, and
 *    `source_check` adds claim verification with passage citations.
 * 2. No browser curator: the "summary-review" workflow opens an interactive
 *    browser window, which makes no sense for a server deployment and is
 *    surprising in the CLI. Force `workflow: "none"`.
 *
 * The file is only written when absent — user edits (provider keys, a
 * different default provider) are never clobbered. One exception: a file
 * that exactly matches the previous managed default (search disabled) is
 * upgraded to the new coexistence default, since it was never user-edited.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../logger.js";

export const WEB_ACCESS_CONFIG_FILE = "web-search.json";

/** Renamed search tool — avoids the silent last-wins collision with inno's Tavily web_search. */
export const WEB_RESEARCH_TOOL_NAME = "web_research";

const MANAGED_DEFAULT = {
	tools: {
		webSearch: { enabled: true },
		sourceCheck: { enabled: true },
	},
	toolNames: {
		webSearch: WEB_RESEARCH_TOOL_NAME,
	},
	workflow: "none",
};

/** The first shipped managed default (search disabled). Auto-upgraded on boot. */
const LEGACY_MANAGED_DEFAULT = {
	tools: {
		webSearch: { enabled: false },
		sourceCheck: { enabled: false },
	},
	workflow: "none",
};

function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (Array.isArray(a) || Array.isArray(b)) return false;
	const keysA = Object.keys(a);
	const keysB = Object.keys(b);
	if (keysA.length !== keysB.length) return false;
	return keysA.every((k) =>
		deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
	);
}

export function readWebAccessConfig(configDir: string): Record<string, unknown> {
	const configPath = join(configDir, WEB_ACCESS_CONFIG_FILE);
	try {
		const raw: unknown = JSON.parse(readFileSync(configPath, "utf-8"));
		if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
	} catch {
		// Missing or unparsable — treated as empty by pi-web-access too.
	}
	return {};
}

function writeWebAccessConfig(configDir: string, config: Record<string, unknown>): void {
	const configPath = join(configDir, WEB_ACCESS_CONFIG_FILE);
	writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

/**
 * Write the managed default config if the user has no web-search.json yet,
 * or upgrade a file that exactly matches the legacy managed default.
 */
export function ensureWebAccessConfig(configDir: string): void {
	const configPath = join(configDir, WEB_ACCESS_CONFIG_FILE);
	try {
		if (!existsSync(configPath)) {
			writeWebAccessConfig(configDir, MANAGED_DEFAULT as unknown as Record<string, unknown>);
			logger.info({ configPath }, "wrote managed pi-web-access default config");
			return;
		}
		if (deepEqual(readWebAccessConfig(configDir), LEGACY_MANAGED_DEFAULT)) {
			writeWebAccessConfig(configDir, MANAGED_DEFAULT as unknown as Record<string, unknown>);
			logger.info({ configPath }, "upgraded legacy pi-web-access default config (search now enabled as web_research)");
		}
	} catch (err) {
		// Non-fatal: pi-web-access still loads with its own defaults; without
		// the rename its web_search would override inno's Tavily tool.
		logger.warn({ err, configPath }, "failed to write pi-web-access default config");
	}
}

// ---------------------------------------------------------------------------
// Provider settings surface for the web UI (/api/settings/web-access).
// ---------------------------------------------------------------------------

export type WebAccessProviderKind = "key" | "url" | "none";

export interface WebAccessProviderSpec {
	id: string;
	kind: WebAccessProviderKind;
	/** web-search.json field holding the credential (e.g. "tavilyApiKey") or base URL. */
	field?: string;
	/** The provider also works without the credential (the key only raises limits). */
	keyOptional?: boolean;
}

/**
 * Curated provider list exposed in the settings UI. pi-web-access supports
 * ~25 providers; these cover the common key-based ones plus SearXNG
 * (self-hosted, URL instead of key), DuckDuckGo (keyless fallback) and
 * Keenable (explicit-only in pi-web-access: never picked by "auto", works
 * without a key, an optional key raises the limits).
 * Providers not listed here remain configurable by editing web-search.json.
 */
export const WEB_ACCESS_PROVIDERS: readonly WebAccessProviderSpec[] = [
	{ id: "tavily", kind: "key", field: "tavilyApiKey" },
	{ id: "brave", kind: "key", field: "braveApiKey" },
	{ id: "exa", kind: "key", field: "exaApiKey" },
	{ id: "perplexity", kind: "key", field: "perplexityApiKey" },
	{ id: "kagi", kind: "key", field: "kagiApiKey" },
	{ id: "jina", kind: "key", field: "jinaApiKey" },
	{ id: "firecrawl", kind: "key", field: "firecrawlApiKey" },
	{ id: "gemini", kind: "key", field: "geminiApiKey" },
	{ id: "bocha", kind: "key", field: "bochaApiKey" },
	{ id: "serper", kind: "key", field: "serperApiKey" },
	{ id: "valyu", kind: "key", field: "valyuApiKey" },
	{ id: "keenable", kind: "key", field: "keenableApiKey", keyOptional: true },
	{ id: "searxng", kind: "url", field: "searxngBaseUrl" },
	{ id: "duckduckgo", kind: "none" },
];

function maskSecret(value: string | undefined): string {
	return value ? `****${value.slice(-4)}` : "";
}

export interface WebAccessProviderView {
	id: string;
	kind: WebAccessProviderKind;
	configured: boolean;
	/** Masked credential/URL ("****abcd"); empty when unconfigured or kind === "none". */
	maskedValue: string;
	/** True when the provider also works without a credential. */
	keyOptional: boolean;
}

export interface WebAccessSettingsView {
	defaultProvider: string;
	providers: WebAccessProviderView[];
}

export function getWebAccessSettingsView(configDir: string): WebAccessSettingsView {
	const raw = readWebAccessConfig(configDir);
	const defaultProvider = typeof raw.provider === "string" && raw.provider.trim() ? raw.provider.trim() : "auto";
	return {
		defaultProvider,
		providers: WEB_ACCESS_PROVIDERS.map((spec) => {
			const value = spec.field && typeof raw[spec.field] === "string" ? (raw[spec.field] as string) : "";
			return {
				id: spec.id,
				kind: spec.kind,
				configured: Boolean(value),
				maskedValue: spec.kind === "none" ? "" : maskSecret(value),
				keyOptional: spec.keyOptional === true,
			};
		}),
	};
}

export interface WebAccessSettingsUpdate {
	/** Default provider id ("auto", "duckduckgo", "tavily", ...). Empty string resets to auto. */
	provider?: string;
	/** Per-provider credential/URL updates keyed by provider id. A masked value
	 *  (starts with "****") keeps the existing one; empty string clears it. */
	values?: Record<string, string>;
}

/** Merge-apply a settings update; preserves every unrelated key in the file. */
export function updateWebAccessSettings(configDir: string, update: WebAccessSettingsUpdate): WebAccessSettingsView {
	const raw = readWebAccessConfig(configDir);

	if (typeof update.provider === "string") {
		const provider = update.provider.trim();
		if (provider && provider !== "auto") raw.provider = provider;
		else delete raw.provider;
	}

	for (const spec of WEB_ACCESS_PROVIDERS) {
		if (!spec.field) continue;
		const incoming = update.values?.[spec.id];
		if (typeof incoming !== "string") continue;
		const trimmed = incoming.trim();
		if (trimmed.startsWith("****")) continue; // masked → keep existing
		if (trimmed) raw[spec.field] = trimmed;
		else delete raw[spec.field];
	}

	writeWebAccessConfig(configDir, raw);
	return getWebAccessSettingsView(configDir);
}

/**
 * Build jiti aliases that pin `@earendil-works/pi-ai` (and its `./compat`
 * subpath) to the copy in inno-agent's own dependency tree.
 *
 * Why: this monorepo's root node_modules hoists pi-ai 0.75.x (pinned by
 * pi-web-ui, used by the web frontend and showcase app), while the backend
 * runs on pi-ai 0.84.x. pi-web-access is hoisted to the root, so its bare
 * `@earendil-works/pi-ai/compat` import would resolve to the 0.75.x copy —
 * whose exports map has no `./compat` — and fail to load. jiti's alias does
 * literal path mapping (it does not consult the target package's exports
 * map), so both the package root and the `./compat` subpath are aliased to
 * their resolved dist files.
 *
 * Walks up from the extension module so it works from both `src/` (tsx) and
 * compiled `dist/`. Returns undefined when no suitable copy is found; the
 * caller then loads without aliases and lets the import fail loudly.
 */
export function resolvePiAiJitiAliases(fromModuleUrl: string): Record<string, string> | undefined {
	let dir = dirname(fileURLToPath(fromModuleUrl));
	for (;;) {
		const pkgDir = join(dir, "node_modules", "@earendil-works", "pi-ai");
		try {
			const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8")) as {
				exports?: Record<string, { import?: unknown }>;
			};
			const compat = pkg.exports?.["./compat"]?.import;
			const main = pkg.exports?.["."]?.import;
			if (typeof compat === "string" && typeof main === "string") {
				return {
					"@earendil-works/pi-ai/compat": join(pkgDir, compat),
					"@earendil-works/pi-ai": join(pkgDir, main),
				};
			}
		} catch {
			// No pi-ai here — keep walking up.
		}
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}
