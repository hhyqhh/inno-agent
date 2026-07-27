/**
 * L2 Wiki Summarizer — uses the agent's configured model via PI SDK
 * to generate structured wiki summaries from extracted content.
 */

import { logger } from "../../logger.js";
import { complete } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { normalizeMarkdownForMilkdown } from "./markdown-normalizer.js";

const SUMMARIZE_PROMPT = `你是一个知识库管理助手。请为以下资料生成结构化的 Wiki 摘要页。

资料标题：{title}

资料内容：
---
{content}
---

请严格按以下格式输出 Milkdown/Crepe 兼容的纯 Markdown（不要加代码块标记）：
- 不要输出 YAML frontmatter。
- 不要把整篇内容包在三反引号 markdown 代码块里。
- 不要使用 HTML/MDX、自定义组件、脚注或复杂表格。
- 优先使用标题、段落、无序列表、有序列表、普通链接和行内代码。
- 如需代码示例，只使用标准三反引号代码块。

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
	signal?: AbortSignal,
): Promise<string | null> {
	signal?.throwIfAborted();
	const truncated =
		content.length > MAX_CONTENT_LENGTH
			? content.slice(0, MAX_CONTENT_LENGTH) + "\n\n...(内容已截断)"
			: content;

	const prompt = SUMMARIZE_PROMPT.replace("{title}", title).replace("{content}", truncated);

	try {
		const auth = await modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) {
			logger.error("[L2 summarizer] Failed to resolve API key");
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
				signal,
			},
		);

		if (response.stopReason === "error") {
			logger.error({ errorMessage: response.errorMessage }, `[L2 summarizer] LLM error: ${response.errorMessage ?? "unknown"}`);
			return null;
		}

		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n")
			.trim();

		return text ? normalizeMarkdownForMilkdown(text) : null;
	} catch (err) {
		if (signal?.aborted) throw err;
		logger.warn({ err }, "[L2 summarizer] Failed");
		return null;
	}
}
