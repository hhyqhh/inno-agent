import type { InnoConfig } from "../config.js";
import { logger } from "../logger.js";

const NO_PROXY_KEYS = ["NO_PROXY", "no_proxy"] as const;

export function applyProviderProxyBypass(config: InnoConfig): void {
	const hosts = Object.values(config.providers)
		.filter((provider) => provider.bypassProxy === true)
		.map((provider) => parseHostname(provider.baseUrl))
		.filter((host): host is string => Boolean(host));

	if (hosts.length === 0) return;

	const current = splitNoProxy(process.env.NO_PROXY ?? process.env.no_proxy ?? "");
	const merged = new Set(current);
	const added: string[] = [];
	for (const host of hosts) {
		if (!merged.has(host)) {
			merged.add(host);
			added.push(host);
		}
	}

	if (added.length === 0) return;

	const next = Array.from(merged).join(",");
	for (const key of NO_PROXY_KEYS) {
		process.env[key] = next;
	}
	logger.info({ hosts: added }, "[inno] provider proxy bypass applied");
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
