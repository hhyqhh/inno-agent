#!/usr/bin/env node

import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { installFetchLogger } from "./utils/fetch-logger.js";
import { main, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import { createInnoExtension, type ConfigHolder } from "./agent/inno-extension.js";
import { ensureDir } from "./storage/file-store.js";
import { applyRuntimeEnvironment, parseRuntimeArgs, resolveRuntimePaths } from "./runtime.js";
import { logger } from "./logger.js";

// Set process title
process.title = "inno";

// Disable undici timeouts for long streaming responses
setGlobalDispatcher(new EnvHttpProxyAgent({ bodyTimeout: 0, headersTimeout: 0 }));
installFetchLogger();

const parsed = parseRuntimeArgs(process.argv.slice(2));
const paths = resolveRuntimePaths(parsed.options);
applyRuntimeEnvironment(paths);

// Load config
const config = loadConfig(paths.configPath);

// Ensure data directories exist
ensureDir(paths.learnerDataDir);
ensureDir(paths.sessionDir);
ensureDir(paths.skillsDir);
ensureDir(paths.workspaceDir);

// Create the extension factory
const innoExtension = createInnoExtension({ current: config }, paths);

// Build extension factories list (conditionally include sandbox)
const extensionFactories: ExtensionFactory[] = [innoExtension];

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
		logger.warn({ err }, "[inno] Failed to load pi-sandbox");
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
