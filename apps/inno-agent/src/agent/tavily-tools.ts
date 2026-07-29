/**
 * Web search tool — wraps the Tavily Search API (@tavily/core) as the agent's
 * default internet search capability. Reads the API key live from configHolder
 * (`config.tavily.apiKey`) so settings changes take effect without a restart.
 * Unconfigured → the tool returns a "not configured" hint.
 */

import { tavily, type TavilySearchResponse } from "@tavily/core";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ConfigHolder } from "./inno-extension.js";
import { logger } from "../logger.js";

/** Upper bound for a single search request (seconds, Tavily API timeout). */
const REQUEST_TIMEOUT_S = 60;
const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS_LIMIT = 10;

function resolveApiKey(holder: ConfigHolder): string | undefined {
	const key = holder.current.tavily?.apiKey?.trim();
	return key || undefined;
}

/** Format a Tavily search response into agent-readable markdown text. */
function formatResults(resp: TavilySearchResponse): string {
	const parts: string[] = [];
	if (resp.answer?.trim()) {
		parts.push(`## 摘要\n\n${resp.answer.trim()}`);
	}
	const results = resp.results ?? [];
	if (results.length > 0) {
		const lines = results.map((r, i) => {
			const published = r.publishedDate ? ` (${r.publishedDate})` : "";
			return `${i + 1}. [${r.title}](${r.url})${published}\n   ${r.content}`;
		});
		parts.push(`## 搜索结果\n\n${lines.join("\n\n")}`);
	}
	return parts.join("\n\n") || "未找到相关结果。";
}

export function createTavilyTools(configHolder: ConfigHolder): ToolDefinition[] {
	const tool = defineTool({
		name: "web_search",
		label: "联网搜索 (Tavily)",
		description:
			"通过 Tavily 搜索引擎联网检索最新信息，返回结果标题、URL、内容摘要和可选的综合答案。" +
			"当用户的问题涉及时事、最新资讯、超出知识截止日期的事实，或明确要求联网查询时使用。" +
			"优先用用户的语言构造 query；复杂或时效性强的查询可将 searchDepth 设为 advanced。",
		parameters: Type.Object({
			query: Type.String({ description: "搜索查询词" }),
			searchDepth: Type.Optional(
				Type.Union([Type.Literal("basic"), Type.Literal("advanced")], {
					description: "检索深度：basic 快速（默认），advanced 更全但更慢更贵",
				}),
			),
			maxResults: Type.Optional(
				Type.Number({ description: `返回结果条数（1-${MAX_RESULTS_LIMIT}，默认 ${DEFAULT_MAX_RESULTS}）` }),
			),
			topic: Type.Optional(
				Type.Union([Type.Literal("general"), Type.Literal("news"), Type.Literal("finance")], {
					description: "搜索主题：general（默认）/ news / finance",
				}),
			),
			includeAnswer: Type.Optional(
				Type.Boolean({ description: "是否返回 Tavily 综合摘要答案（默认 true）" }),
			),
		}),
		async execute(_toolCallId, params) {
			const typed = params as {
				query: string;
				searchDepth?: "basic" | "advanced";
				maxResults?: number;
				topic?: "general" | "news" | "finance";
				includeAnswer?: boolean;
			};
			const query = String(typed.query ?? "").trim();
			if (!query) {
				return {
					content: [{ type: "text" as const, text: "请提供 query（搜索查询词）。" }],
					details: { error: "missing_query" } as Record<string, unknown>,
				};
			}

			const apiKey = resolveApiKey(configHolder);
			if (!apiKey) {
				return {
					content: [{
						type: "text" as const,
						text: "尚未配置 Tavily API Key。请在设置面板的「联网搜索 (Tavily)」卡片填入 API Key 后重试。",
					}],
					details: { error: "tavily_not_configured" } as Record<string, unknown>,
				};
			}

			const maxResults = Math.min(
				Math.max(Math.floor(typed.maxResults ?? DEFAULT_MAX_RESULTS), 1),
				MAX_RESULTS_LIMIT,
			);

			try {
				const client = tavily({ apiKey });
				const resp = await client.search(query, {
					searchDepth: typed.searchDepth ?? "basic",
					topic: typed.topic ?? "general",
					maxResults,
					includeAnswer: typed.includeAnswer ?? true,
					timeout: REQUEST_TIMEOUT_S,
				});

				return {
					content: [{ type: "text" as const, text: formatResults(resp) }],
					details: {
						query: resp.query,
						responseTime: resp.responseTime,
						resultCount: resp.results?.length ?? 0,
						results: (resp.results ?? []).map((r) => ({
							title: r.title,
							url: r.url,
							score: r.score,
						})),
					} as Record<string, unknown>,
				};
			} catch (err) {
				logger.warn({ err, query }, "web_search: tavily search failed");
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: `联网搜索失败：${msg}` }],
					details: { error: "search_failed", query, message: msg } as Record<string, unknown>,
				};
			}
		},
	});

	return [tool];
}
