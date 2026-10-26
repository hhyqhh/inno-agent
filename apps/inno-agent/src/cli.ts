#!/usr/bin/env node

import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { installFetchLogger } from "./utils/fetch-logger.js";
import { main, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { isCodemodeEnabled, loadConfig } from "./config.js";
import { applyProviderProxyBypass } from "./utils/proxy-bypass.js";
import { createInnoExtension } from "./agent/inno-extension.js";
import { createMcpStatusExtension, loadMcpAdapterExtension } from "./agent/mcp-extension.js";
import { syncCodemodeDefaultTools } from "./agent/pi-runner.js";
import { ensureDir } from "./storage/file-store.js";
import { seedManagedMcpConfig } from "./mcp/mcp-config-store.js";
import { applyRuntimeEnvironment, parseRuntimeArgs, resolveRuntimePaths } from "./runtime.js";
import { installProcessFallbacks } from "./utils/process-fallback.js";
import { logger } from "./logger.js";

// Set process title
process.title = "inno";

// Last-resort handlers: log fatal-level and exit cleanly on stray
// exceptions/rejections instead of dying silently mid-session.
installProcessFallbacks();

// Disable undici timeouts for long streaming responses
// bodyTimeout: 15 min safety net for LLM provider requests. Provider-level
// timeout (retry.provider.timeoutMs, default 10 min) should fire first; this
// ensures a hung connection can't live longer than 15 minutes even if the
// provider timeout fails to abort.
setGlobalDispatcher(new EnvHttpProxyAgent({ bodyTimeout: 900_000, headersTimeout: 0 }));
installFetchLogger();

const parsed = parseRuntimeArgs(process.argv.slice(2));
const paths = resolveRuntimePaths(parsed.options);
await applyRuntimeEnvironment(paths);

// Load config
const config = loadConfig(paths.configPath);
applyProviderProxyBypass(config);

// First-run MCP template: seeds <configDir>/mcp-adapter.json with a disabled
// reference server when the file doesn't exist yet. No-op afterwards.
seedManagedMcpConfig(paths);

// Codemode activation: in CLI mode main() auto-registers the built-in
// codemode extension; the settings.json defaultTools entry decides whether
// the tool starts active. Kept in sync with plugins.codemode.enabled.
syncCodemodeDefaultTools(paths.configDir, isCodemodeEnabled(config));

// Ensure data directories exist
ensureDir(paths.learnerDataDir);
ensureDir(paths.sessionDir);
ensureDir(paths.skillsDir);
ensureDir(paths.workspaceDir);

// Create the extension factory
const innoExtension = createInnoExtension({ current: config }, paths);

// Build extension factories list (conditionally include sandbox)
const extensionFactories: ExtensionFactory[] = [innoExtension];

// MCP: status bridge is always on (no-op without the adapter); the adapter
// itself only when `mcp.enabled` is set in config. In the CLI the adapter's
// full TUI surface (`/mcp` panel, OAuth dialogs) is available.
extensionFactories.push(createMcpStatusExtension());
const mcpAdapter = await loadMcpAdapterExtension(config, paths);
if (mcpAdapter) extensionFactories.push(mcpAdapter);

if (parsed.options.sandbox) {
	try {
		const { createJiti } = await import("jiti/static");
		const jiti = createJiti(import.meta.url, {
			moduleCache: false,
			alias: {
				"@mariozechner/pi-coding-agent": "@earendil-works/pi-coding-agent",
				"@mariozechner/pi-tui": "@earendil-works/pi-tui",
			},
		});
		const mod = await jiti.import("pi-sandbox", { default: true });
		const sandboxExtension = mod as ExtensionFactory;
		if (typeof sandboxExtension === "function") {
			extensionFactories.push(sandboxExtension);
			logger.info("[inno] Sandbox extension loaded");
		}
	} catch (err) {
		// pi-sandbox ships TS source only and is loaded via jiti — a version
		// bump can break loading; it is pinned in package.json for that reason.
		logger.warn({ err }, "[inno] Failed to load pi-sandbox (TS-source package loaded via jiti; check that the pinned version in package.json was not changed)");
	}
}

const hasCliModel = parsed.rest.some((arg) => arg === "--model" || arg.startsWith("--model="));
const hasCliProvider = parsed.rest.some((arg) => arg === "--provider" || arg.startsWith("--provider="));
const modelArgs = hasCliModel
	? parsed.rest
	: hasCliProvider
		? [...parsed.rest, "--model", config.defaultModel]
		: [...parsed.rest, "--model", `${config.defaultProvider}/${config.defaultModel}`];

// Run PI's main with our extension injected
main([...modelArgs, "--no-skills", "--skill", paths.skillsDir], {
	extensionFactories,
});
