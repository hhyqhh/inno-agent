/**
 * Guided provider presets for the "add model" wizard, in the spirit of
 * cc-switch's preset catalog. Each preset pre-fills the OpenAI-compatible
 * endpoint, links to the console where the user gets an API key, and carries
 * brand metadata (icon asset + glyph fallback + color) used across the settings UI.
 */

export interface ProviderPreset {
	/** Default provider id written into config.json */
	id: string;
	/** Display name */
	name: string;
	/** One-line description shown on the picker card */
	description: string;
	/** Brand color used for the icon tile */
	brandColor: string;
	/** Optional local brand icon. The glyph remains the fallback for custom/unknown providers. */
	iconSrc?: string;
	/** Short glyph rendered inside the icon tile (letter mark) */
	glyph: string;
	/** Pre-filled API base URL (OpenAI-compatible unless api says otherwise) */
	baseUrl: string;
	api: string;
	/** Console page where the user creates/copies an API key */
	consoleUrl: string;
	/** API documentation page */
	docsUrl: string;
	/** Optional hint shown under the model field (e.g. endpoint-id note) */
	modelHint?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
	{
		id: "deepseek",
		name: "DeepSeek",
		description: "深度求索 · deepseek-chat / reasoner",
		brandColor: "#4D6BFE",
		iconSrc: "/provider-icons/deepseek.png",
		glyph: "DS",
		baseUrl: "https://api.deepseek.com/v1",
		api: "openai-completions",
		consoleUrl: "https://platform.deepseek.com/api_keys",
		docsUrl: "https://api-docs.deepseek.com/zh-cn/",
	},
	{
		id: "kimi",
		name: "Kimi",
		description: "月之暗面 · kimi-k2 系列",
		brandColor: "#6366F1",
		iconSrc: "/provider-icons/kimi-rounded.png",
		glyph: "K",
		baseUrl: "https://api.moonshot.cn/v1",
		api: "openai-completions",
		consoleUrl: "https://platform.moonshot.cn/console/api-keys",
		docsUrl: "https://platform.moonshot.cn/docs",
	},
	{
		id: "minimax",
		name: "MiniMax",
		description: "MiniMax-M2 系列",
		brandColor: "#FF6B6B",
		iconSrc: "/provider-icons/minimax-user-icon.png",
		glyph: "MM",
		baseUrl: "https://api.minimaxi.com/v1",
		api: "openai-completions",
		consoleUrl: "https://platform.minimaxi.com/user-center/basic-information/interface-key",
		docsUrl: "https://platform.minimaxi.com/document",
	},
	{
		id: "volcengine",
		name: "火山引擎",
		description: "字节跳动 · 豆包 Doubao",
		brandColor: "#F5582E",
		iconSrc: "/provider-icons/volcengine-icon.svg",
		glyph: "火",
		baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
		api: "openai-completions",
		consoleUrl: "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey",
		docsUrl: "https://www.volcengine.com/docs/82379",
		modelHint: "模型 ID 填推理接入点 ID（ep-xxx）或模型名称",
	},
	{
		id: "xiaomimimo",
		name: "小米 MiMo",
		description: "小米 · mimo 系列",
		brandColor: "#FF6900",
		iconSrc: "/provider-icons/xiaomi-mi.png",
		glyph: "Mi",
		baseUrl: "https://api.xiaomimimo.com/v1",
		api: "openai-completions",
		consoleUrl: "https://platform.xiaomimimo.com",
		docsUrl: "https://platform.xiaomimimo.com",
	},
	{
		id: "bailian",
		name: "阿里百炼",
		description: "阿里云 · 通义千问 Qwen",
		brandColor: "#624AFF",
		iconSrc: "/provider-icons/bailian.svg",
		glyph: "百",
		baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
		api: "openai-completions",
		consoleUrl: "https://bailian.console.aliyun.com/#/api-key",
		docsUrl: "https://help.aliyun.com/zh/model-studio/",
	},
	{
		id: "custom",
		name: "自定义",
		description: "任意 OpenAI / Anthropic 兼容端点",
		brandColor: "#8A8F98",
		glyph: "+",
		baseUrl: "",
		api: "openai-completions",
		consoleUrl: "",
		docsUrl: "",
	},
];

/** Look up a preset by provider id (used to brand existing providers). */
export function findPreset(providerId: string): ProviderPreset | undefined {
	const lower = providerId.toLowerCase();
	return PROVIDER_PRESETS.find((p) => p.id !== "custom" && (p.id === lower || lower.includes(p.id)));
}
