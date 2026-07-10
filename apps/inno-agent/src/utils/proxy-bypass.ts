import type { InnoConfig } from "../config.js";
import { logger } from "../logger.js";

const NO_PROXY_KEYS = ["NO_PROXY", "no_proxy"] as const;
let managedHosts = new Set<string>();

export function applyProviderProxyBypass(config: InnoConfig): void {
	const hosts = Object.values(config.providers)
		.filter((provider) => provider.bypassProxy === true)
		.map((provider) => parseHostname(provider.baseUrl))
		.filter((host): host is string => Boolean(host));

	const current = splitNoProxy(process.env.NO_PROXY ?? process.env.no_proxy ?? "");
	const previousManagedHosts = managedHosts;
	const merged = new Set(current.filter((host) => !managedHosts.has(host)));
	const nextManagedHosts = new Set<string>();
	for (const host of hosts) {
		if (!merged.has(host)) {
			merged.add(host);
			nextManagedHosts.add(host);
		}
	}
	managedHosts = nextManagedHosts;
	const added = Array.from(nextManagedHosts).filter((host) => !previousManagedHosts.has(host));
	const removed = Array.from(previousManagedHosts).filter((host) => !nextManagedHosts.has(host));

	const next = Array.from(merged).join(",");
	for (const key of NO_PROXY_KEYS) {
		process.env[key] = next;
	}
	if (added.length > 0 || removed.length > 0) {
		logger.info({ added, removed }, "[inno] provider proxy bypass updated");
	}
}

function parseHostname(baseUrl: string): string | undefined {
	try {
		return new URL(baseUrl).hostname;
	} catch {
		return undefined;
	}
}

function splitNoProxy(value: string): string[] {
	return value
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
}
