export interface InnoModelInfo {
	id: string;
	name: string;
	provider: string;
	reasoning: boolean;
	input: Array<"text" | "image">;
	contextWindow: number;
	maxTokens: number;
	baseUrl?: string;
}

export interface InnoProviderModel {
	id: string;
	name: string;
	reasoning: boolean;
	input: Array<"text" | "image">;
	contextWindow: number;
	maxTokens: number;
}

export interface InnoProviderSettings {
	baseUrl: string;
	apiKey: string; // masked
	api?: string;
	headers?: Record<string, string>;
	authHeader?: boolean;
	bypassProxy?: boolean;
	models: InnoProviderModel[];
}

export interface UpsertProviderRequest {
	providerId: string;
	baseUrl: string;
	apiKey: string;
	api: string;
	headers?: Record<string, string>;
	authHeader?: boolean;
	bypassProxy?: boolean;
	models: InnoProviderModel[];
	makeDefault?: boolean;
	preserveApiKey?: boolean;
}

export interface PersonalChannelConfig {
	enabled: boolean;
	personalOnly?: boolean;
	allowedUserIds?: string[];
}

export interface PersonalBridgeChannelConfig extends PersonalChannelConfig {
	mode: "bridge";
	sidecarBaseUrl: string;
}

export interface PersonalILinkChannelConfig extends PersonalChannelConfig {
	mode?: "ilink";
}

export interface ChannelsSettingsPayload {
	feishu?: {
		appId: string;
		appSecret?: string;
	};
	channels?: {
		feishu?: PersonalChannelConfig;
		qq?: PersonalBridgeChannelConfig;
		wechat?: PersonalILinkChannelConfig | PersonalBridgeChannelConfig;
	};
	bridge?: {
		token: string;
	};
}

export type WindowCloseBehavior = "ask" | "hide" | "quit";

export interface InnoSettings {
	defaultProvider: string;
	defaultModel: string;
	configuredModels?: InnoModelInfo[];
	availableModels?: InnoModelInfo[];
	providers: Record<string, InnoProviderSettings>;
	server?: { port: number };
	feishu?: { appId: string; appSecret: string }; // appSecret masked
	channels?: {
		feishu?: PersonalChannelConfig;
		qq?: PersonalBridgeChannelConfig;
		wechat?: PersonalILinkChannelConfig | PersonalBridgeChannelConfig;
		wecom?: { enabled: boolean };
	};
	bridge?: { token: string }; // masked
	github?: { token: string }; // masked
	ocrApi?: {
		token: string; // masked
		model?: string;
		baseUrl?: string;
	};
	tavily?: {
		apiKey: string; // masked
	};
	contentHub?: {
		type: "github" | "bundle";
		owner: string;
		repo: string;
		ref: string;
		skillsPath: string;
		presetsPath: string;
		baseUrl: string;
		token: string; // masked
	};
	memory?: { l1Enabled: boolean; l2Enabled: boolean; l3Enabled: boolean };
	simpleMode?: { enabled: boolean };
	smartInput?: SmartInputSettings;
	mcp?: { enabled: boolean };
	ui?: { theme: string; closeBehavior: WindowCloseBehavior; mathSingleDollar: boolean };
}

/* ---------- Web research (pi-web-access: web_research / source_check / fetch_content) ---------- */

export type WebAccessProviderKind = "key" | "url" | "none";

export interface WebAccessProvider {
	id: string;
	kind: WebAccessProviderKind;
	configured: boolean;
	maskedValue: string; // "****abcd", empty when unconfigured or kind === "none"
}

/** Served by GET /api/settings/web-access (backed by <configDir>/web-search.json). */
export interface WebAccessSettings {
	defaultProvider: string;
	providers: WebAccessProvider[];
}

export interface WebAccessSettingsPayload {
	provider?: string;
	/** Per-provider credential/URL updates; "****…" keeps existing, "" clears. */
	values?: Record<string, string>;
}

/** One literal keyword → allowed file formats with optional exclusions. */
export interface SmartInputRule {
	id: string;
	/** Built-in rules keep stable ids and win keyword resolution over generic user rules. */
	isPreset: boolean;
	keyword: string;
	/** Allowed extensions when `allExtensions` is false. */
	extensions: string[];
	/** Accept every file format before applying `excludeExtensions`. */
	allExtensions: boolean;
	/** Extensions rejected after the allow-list/all-formats check. */
	excludeExtensions: string[];
	enabled: boolean;
}

export interface SmartInputSettings {
	enabled: boolean;
	allowDrag: boolean;
	allowRightClick: boolean;
	allowAgentCommands: boolean;
	rules: SmartInputRule[];
}
