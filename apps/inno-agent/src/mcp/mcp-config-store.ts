/**
 * Managed MCP config store.
 *
 * Inno manages one canonical MCP config file — `<configDir>/mcp.json` — which
 * the pi-mcp-adapter extension is pointed at via `createMcpAdapter({
 * configPath })`. The adapter additionally merges the standard shared MCP
 * locations; this store reads those too (read-only) so the UI can show the
 * full effective server list with a source label, while only entries in the
 * managed file are editable.
 *
 * Merge order follows the adapter's documented precedence (lowest first):
 *   1. ~/.config/mcp/mcp.json        (user-global shared)
 *   2. ~/.agents/mcp.json            (user-global tool-agnostic)
 *   3. ~/.agents/mcp/mcp.json        (user-global tool-agnostic)
 *   4. <configDir>/mcp.json          (managed — the adapter's "Pi global" layer)
 *   5. <workspaceDir>/.mcp.json      (project shared)
 *   6. <workspaceDir>/.pi/mcp.json   (project Pi override, highest)
 * Later sources override earlier ones by server name.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { RuntimePaths } from "../runtime.js";
import { getManagedMcpConfigPath, getMcpStatusSnapshot, isMcpAdapterLoaded } from "../agent/mcp-extension.js";
import type { McpServerStatus, McpStatusSnapshot } from "../agent/mcp-extension.js";
import type { InnoConfig } from "../config.js";
import { logger } from "../logger.js";

const mcpLogger = logger.child({ module: "mcp" });

/**
 * Permissive mirror of the adapter's ServerEntry. Unknown fields are preserved
 * on write (index signature) so hand-edited configs don't lose adapter options
 * the UI doesn't model yet.
 */
export interface McpServerEntry {
	command?: string;
	args?: string[];
	socket?: string;
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
	auth?: "oauth" | "bearer" | false;
	bearerToken?: string;
	bearerTokenEnv?: string;
	lifecycle?: "keep-alive" | "lazy" | "lazy-keep-alive" | "eager";
	idleTimeout?: number;
	requestTimeoutMs?: number;
	exposeResources?: boolean;
	directTools?: boolean | string[];
	includeTools?: string[];
	excludeTools?: string[];
	approveTools?: boolean | string[];
	debug?: boolean;
	disabled?: boolean;
	[extra: string]: unknown;
}

export interface McpConfigFile {
	mcpServers: Record<string, McpServerEntry>;
	settings?: Record<string, unknown>;
	imports?: string[];
	[extra: string]: unknown;
}

export type McpSourceKind =
	| "managed"
	| "global-shared"
	| "agents"
	| "project"
	| "project-pi";

export interface McpServerView {
	name: string;
	definition: McpServerEntry;
	transport: "stdio" | "http" | "socket";
	source: { path: string; kind: McpSourceKind; editable: boolean };
	/** Live runtime status from the adapter's event bus, when available. */
	status?: McpServerStatus;
}

export interface McpOverview {
	enabled: boolean;
	adapterLoaded: boolean;
	configPath: string;
	/** Set when the managed file exists but cannot be parsed. */
	configError?: string;
	servers: McpServerView[];
	status: McpStatusSnapshot | null;
}

const EMPTY_CONFIG: McpConfigFile = { mcpServers: {} };

/** Read + parse an MCP config file. Returns empty config when missing. */
function readConfigFile(path: string): McpConfigFile {
	if (!existsSync(path)) return structuredClone(EMPTY_CONFIG);
	const raw = readFileSync(path, "utf-8");
	if (!raw.trim()) return structuredClone(EMPTY_CONFIG);
	const parsed = JSON.parse(raw) as McpConfigFile;
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("top-level value must be an object");
	}
	if (parsed.mcpServers === undefined) parsed.mcpServers = {};
	if (typeof parsed.mcpServers !== "object" || parsed.mcpServers === null || Array.isArray(parsed.mcpServers)) {
		throw new Error("mcpServers must be an object");
	}
	return parsed;
}

/** Read the managed config, tolerating absence; throws on corrupt JSON. */
export function readManagedMcpConfig(paths: RuntimePaths): McpConfigFile {
	return readConfigFile(getManagedMcpConfigPath(paths));
}

/** Atomic write (tmp + rename) of the managed config. */
export function writeManagedMcpConfig(paths: RuntimePaths, config: McpConfigFile): void {
	const configPath = getManagedMcpConfigPath(paths);
	mkdirSync(dirname(configPath), { recursive: true });
	const tmp = `${configPath}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
	renameSync(tmp, configPath);
}

const SERVER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const LIFECYCLES = new Set(["keep-alive", "lazy", "lazy-keep-alive", "eager"]);

/**
 * Validate a server entry for upsert. Returns an error message, or null when
 * valid. Only the fields the UI writes are strictly checked; the adapter
 * remains the final authority on the rest.
 */
export function validateServerEntry(name: string, entry: McpServerEntry): string | null {
	if (!SERVER_NAME_RE.test(name)) {
		return "Server name must start with a letter or digit and contain only letters, digits, '.', '_' or '-' (max 64 chars)";
	}
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
		return "Server definition must be an object";
	}
	const transports = [entry.command, entry.url, entry.socket].filter((v) => typeof v === "string" && v.trim());
	if (transports.length !== 1) {
		return "Exactly one transport is required: command (stdio), url (HTTP) or socket";
	}
	if (entry.command !== undefined) {
		if (typeof entry.command !== "string" || !entry.command.trim()) return "command must be a non-empty string";
		if (entry.args !== undefined && (!Array.isArray(entry.args) || entry.args.some((a) => typeof a !== "string"))) {
			return "args must be an array of strings";
		}
		if (entry.env !== undefined && !isStringRecord(entry.env)) return "env must be an object of string values";
		if (entry.cwd !== undefined && typeof entry.cwd !== "string") return "cwd must be a string";
	}
	if (entry.url !== undefined) {
		if (typeof entry.url !== "string") return "url must be a string";
		// Allow ${VAR} interpolation templates — skip URL parsing when present.
		if (!entry.url.includes("${") && !entry.url.includes("$env:")) {
			try {
				const u = new URL(entry.url);
				if (u.protocol !== "http:" && u.protocol !== "https:") return "url must use http(s)";
			} catch {
				return "url is not a valid URL";
			}
		}
		if (entry.headers !== undefined && !isStringRecord(entry.headers)) return "headers must be an object of string values";
	}
	if (entry.socket !== undefined && typeof entry.socket !== "string") return "socket must be a string";
	if (entry.lifecycle !== undefined && !LIFECYCLES.has(entry.lifecycle)) {
		return `lifecycle must be one of ${[...LIFECYCLES].join(", ")}`;
	}
	if (entry.disabled !== undefined && typeof entry.disabled !== "boolean") return "disabled must be a boolean";
	if (entry.directTools !== undefined && typeof entry.directTools !== "boolean"
		&& !(Array.isArray(entry.directTools) && entry.directTools.every((t) => typeof t === "string"))) {
		return "directTools must be a boolean or an array of tool names";
	}
	if (entry.idleTimeout !== undefined && (typeof entry.idleTimeout !== "number" || entry.idleTimeout < 0)) {
		return "idleTimeout must be a non-negative number (minutes)";
	}
	if (entry.requestTimeoutMs !== undefined && (typeof entry.requestTimeoutMs !== "number" || entry.requestTimeoutMs <= 0)) {
		return "requestTimeoutMs must be a positive number";
	}
	return null;
}

function isStringRecord(v: unknown): v is Record<string, string> {
	return typeof v === "object" && v !== null && !Array.isArray(v)
		&& Object.values(v).every((x) => typeof x === "string");
}

/** Add or replace a server in the managed config. Throws on validation errors. */
export function upsertManagedServer(paths: RuntimePaths, name: string, entry: McpServerEntry): McpConfigFile {
	const error = validateServerEntry(name, entry);
	if (error) throw new Error(error);
	const config = readManagedMcpConfig(paths);
	config.mcpServers[name] = entry;
	writeManagedMcpConfig(paths, config);
	return config;
}

/** Remove a server from the managed config. Returns false when it didn't exist. */
export function deleteManagedServer(paths: RuntimePaths, name: string): boolean {
	const config = readManagedMcpConfig(paths);
	if (!(name in config.mcpServers)) return false;
	delete config.mcpServers[name];
	writeManagedMcpConfig(paths, config);
	return true;
}

/**
 * Enable/disable a managed server. Enabling strips the `disabled` key (so a
 * higher-precedence layer can't keep it off); disabling sets it to `true`.
 * Returns false when the server isn't in the managed config.
 */
export function setManagedServerDisabled(paths: RuntimePaths, name: string, disabled: boolean): boolean {
	const config = readManagedMcpConfig(paths);
	const entry = config.mcpServers[name];
	if (!entry) return false;
	if (disabled) entry.disabled = true;
	else delete entry.disabled;
	writeManagedMcpConfig(paths, config);
	return true;
}

interface DiscoveredSource {
	path: string;
	kind: McpSourceKind;
	editable: boolean;
}

/** Standard MCP config locations the adapter merges, lowest precedence first. */
function listConfigSources(paths: RuntimePaths): DiscoveredSource[] {
	const home = homedir();
	return [
		{ path: join(home, ".config", "mcp", "mcp.json"), kind: "global-shared", editable: false },
		{ path: join(home, ".agents", "mcp.json"), kind: "agents", editable: false },
		{ path: join(home, ".agents", "mcp", "mcp.json"), kind: "agents", editable: false },
		{ path: getManagedMcpConfigPath(paths), kind: "managed", editable: true },
		{ path: join(paths.workspaceDir, ".mcp.json"), kind: "project", editable: false },
		{ path: join(paths.workspaceDir, ".pi", "mcp.json"), kind: "project-pi", editable: false },
	];
}

function transportOf(entry: McpServerEntry): McpServerView["transport"] {
	if (typeof entry.url === "string" && entry.url.trim()) return "http";
	if (typeof entry.socket === "string" && entry.socket.trim()) return "socket";
	return "stdio";
}

/**
 * Assemble the full picture for `GET /api/mcp`: effective server list merged
 * across all config sources (later sources win by name) plus the adapter's
 * live status snapshot.
 */
export function getMcpOverview(config: InnoConfig, paths: RuntimePaths): McpOverview {
	const byName = new Map<string, McpServerView>();
	let configError: string | undefined;

	for (const source of listConfigSources(paths)) {
		if (!existsSync(source.path)) continue;
		let file: McpConfigFile;
		try {
			file = readConfigFile(source.path);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			mcpLogger.warn({ err, path: source.path }, "failed to parse MCP config file");
			if (source.kind === "managed") configError = message;
			continue;
		}
		for (const [name, definition] of Object.entries(file.mcpServers)) {
			if (typeof definition !== "object" || definition === null || Array.isArray(definition)) continue;
			byName.set(name, {
				name,
				definition,
				transport: transportOf(definition),
				source: { path: source.path, kind: source.kind, editable: source.editable },
			});
		}
	}

	const status = getMcpStatusSnapshot();
	if (status) {
		for (const serverStatus of status.servers) {
			const view = byName.get(serverStatus.name);
			if (view) view.status = serverStatus;
		}
	}

	return {
		enabled: config.mcp?.enabled === true,
		adapterLoaded: isMcpAdapterLoaded(),
		configPath: getManagedMcpConfigPath(paths),
		...(configError ? { configError } : {}),
		servers: [...byName.values()],
		status,
	};
}
