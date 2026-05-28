/**
 * L2 Wiki Summarizer — uses the agent's configured model via PI SDK
 * to generate structured wiki summaries from extracted content.
 */

import { complete } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

const SUMMARIZE_PROMPT = `你是一个知识库管理助手。请为以下资料生成结构化的 Wiki 摘要页。

资料标题：{title}

资料内容：
---
{content}
---

请严格按以下格式输出纯 Markdown（不要加代码块标记）：

## 摘要

用 1-3 段简洁的文字总结这份资料的核心内容。

## 关键概念

列出资料中的关键概念、技术、人物或项目，每个用 [[双链]] 格式标注：
- [[概念名]]: 一句话说明

## 要点

用要点列表列出 3-8 个最重要的知识点或结论。`;

const MAX_CONTENT_LENGTH = 50000;

/**
 * Call the agent's configured LLM to generate a structured wiki summary.
 * Returns the generated markdown body, or null on failure.
 */
export async function summarizeContent(
	model: Model<any>,
	modelRegistry: ModelRegistry,
	title: string,
	content: string,
): Promise<string | null> {
	const truncated =
		content.length > MAX_CONTENT_LENGTH
			? content.slice(0, MAX_CONTENT_LENGTH) + "\n\n...(内容已截断)"
			: content;

	const prompt = SUMMARIZE_PROMPT.replace("{title}", title).replace("{content}", truncated);

	try {
		const auth = await modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) {
			console.error("[L2 summarizer] Failed to resolve API key");
			return null;
		}

		const response = await complete(
			model,
			{
				messages: [
					{
						role: "user" as const,
						content: [{ type: "text" as const, text: prompt }],
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				maxTokens: 4096,
			},
		);

		if (response.stopReason === "error") {
			console.error(`[L2 summarizer] LLM error: ${response.errorMessage ?? "unknown"}`);
			return null;
		}

		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n")
			.trim();

		return text || null;
	} catch (err) {
		console.error(`[L2 summarizer] Failed: ${err instanceof Error ? err.message : String(err)}`);
		return null;
	}
}
