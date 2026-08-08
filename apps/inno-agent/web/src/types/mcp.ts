/** MCP (Model Context Protocol) types mirroring the backend overview payload. */

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

export type McpServerRuntimeStatus =
	| "connected"
	| "cached"
	| "failed"
	| "needs-auth"
	| "not-connected"
	| "disabled";

export interface McpServerStatus {
	name: string;
	status: McpServerRuntimeStatus;
	toolCount: number;
	resourceCount?: number;
	failedAgoSeconds?: number;
	disabled: boolean;
}

export interface McpStatusSnapshot {
	version: number;
	servers: McpServerStatus[];
	totalTools: number;
	totalResources: number;
	connectedCount: number;
	disabledCount: number;
}

export type McpSourceKind = "managed" | "global-shared" | "agents" | "project" | "project-pi";

export interface McpServerView {
	name: string;
	definition: McpServerEntry;
	transport: "stdio" | "http" | "socket";
	source: { path: string; kind: McpSourceKind; editable: boolean };
	status?: McpServerStatus;
}

export interface McpOverview {
	enabled: boolean;
	adapterLoaded: boolean;
	configPath: string;
	configError?: string;
	servers: McpServerView[];
	status: McpStatusSnapshot | null;
}
