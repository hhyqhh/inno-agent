export interface InnoModelInfo {
	id: string;
	name: string;
	provider: string;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
	baseUrl?: string;
}

export interface InnoProviderModel {
	id: string;
	name: string;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
}

export interface InnoProviderSettings {
	baseUrl: string;
	apiKey: string; // masked
	api?: string;
	models: InnoProviderModel[];
}

export interface UpsertProviderRequest {
	providerId: string;
	baseUrl: string;
	apiKey: string;
	api: string;
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
	ui?: { theme: string };
}
