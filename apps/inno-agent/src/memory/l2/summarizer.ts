/**
 * L2 Wiki Summarizer — uses the agent's configured model via PI SDK
 * to generate structured wiki summaries from extracted content.
 */

import { logger } from "../../logger.js";
import { complete } from "@earendil-works/pi-ai/compat";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { splitStructuralChunks } from "./structural-chunker.js";
import { normalizeEvidenceTextForQuoteMatching } from "./evidence-index.js";
import {
	evidenceMarkersMatch,
	MAX_EVIDENCE_MARKER,
	stripEvidenceMarkers,
} from "./evidence-markers.js";

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
const MAX_MODEL_CHUNKS = 8;

const CHUNK_SUMMARY_PROMPT = `你是一个知识库管理助手。下面是一份长资料的第 {part}/{total} 部分。

资料标题：{title}

资料片段：
---
{content}
---

请输出紧凑 Markdown，保留本片段的关键事实、实体、概念、数字、结论与矛盾。不要假设这是完整资料。`;

const REDUCE_SUMMARY_PROMPT = `你是一个知识库管理助手。请把同一份长资料的分块分析合并为一份完整 Wiki 摘要。

资料标题：{title}

分块分析：
---
{content}
---

请去重但不要遗漏只在单个分块出现的事实，严格输出以下 Markdown 结构：

## 摘要

## 关键概念

- [[概念名]]: 一句话说明

## 要点`;

const GROUNDED_SUMMARIZE_PROMPT = `你是一个知识库管理助手。请阅读下面的资料，生成一篇带**内联引用**的结构化 Wiki 摘要。

资料标题：{title}

资料内容：
---
{content}
---

要求：
1. 输出 Markdown 正文，包含三个部分：\`## 摘要\`（1-3 段）、\`## 关键概念\`（每个概念用 [[双链]] 标注）、\`## 要点\`（3-8 条）。
2. 在摘要和要点中，**每个来自资料原文的事实性论断之后**，紧跟一个内联引用标记，形如 \`[1]\`、\`[2]\`、\`[3]\`…。标记从 1 开始连续递增，同一处事实只用一个标记。关键概念的一行说明如来自原文也可加标记。
3. 正文之后，单独输出一个 \`\`\`json 代码块，内容是 {"citations":[{"marker":1,"quote":"原文原句"},…]}。
4. 每个 quote 必须是资料中**连续、逐字出现**的一段原文，不超过 500 字，不要改写、不要概括，且必须能在原文中唯一找到。
5. marker 编号必须与正文中的 [n] 标记一一对应，不要有遗漏或多余。

只输出正文和 json 代码块，不要任何其它解释。`;

export interface GroundedCitation {
	marker: number;
	quote: string;
}

export interface GroundedSummary {
	body: string;
	citations: GroundedCitation[] | null;
}

const MAX_QUOTE_CODE_POINTS = 500;

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number"
		&& Number.isSafeInteger(value)
		&& value >= 1
		&& value <= MAX_EVIDENCE_MARKER;
}

function isValidGroundedQuote(value: unknown): value is string {
	if (typeof value !== "string") return false;
	let codePoints = 0;
	for (const _codePoint of value) {
		codePoints += 1;
		if (codePoints > MAX_QUOTE_CODE_POINTS) return false;
	}
	return value.trim().length > 0;
}

function parseGroundedCitations(raw: unknown): GroundedCitation[] | null {
	if (!Array.isArray(raw)) return null;
	const citations: GroundedCitation[] = [];
	const seen = new Set<number>();
	const seenQuotes = new Set<string>();
	for (const entry of raw) {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
		const record = entry as Record<string, unknown>;
		if (!isPositiveInteger(record.marker) || !isValidGroundedQuote(record.quote)) return null;
		if (seen.has(record.marker)) return null;
		const normalizedQuote = normalizeEvidenceTextForQuoteMatching(record.quote);
		if (seenQuotes.has(normalizedQuote)) return null;
		seen.add(record.marker);
		seenQuotes.add(normalizedQuote);
		citations.push({ marker: record.marker, quote: record.quote as string });
	}
	return citations;
}

/**
 * Parse the grounded summarizer output: a markdown body followed by a fenced
 * ```json block containing a `citations` array. Returns null when the body or
 * the citations block cannot be recovered.
 */
export function parseGroundedSummary(text: string | null): GroundedSummary | null {
	if (!text) return null;
	const trimmed = text.trim();
	const fence = /^([\s\S]*?)\n```json[ \t]*\n([\s\S]*?)\n```[ \t]*$/iu.exec(trimmed);
	if (!fence) return null;

	const body = fence[1].trim();
	if (!body) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(fence[2].trim()) as unknown;
	} catch {
		return null;
	}
	const record = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
		? (parsed as Record<string, unknown>)
		: null;
	if (!record) return null;
	const citations = parseGroundedCitations(record.citations);
	if (!citations || !evidenceMarkersMatch(body, citations.map((citation) => citation.marker))) return null;
	return { body, citations };
}

async function completeSummary(
	model: Model<any>,
	modelRegistry: ModelRegistry,
	prompt: string,
	maxTokens: number,
): Promise<string | null> {
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
			{ apiKey: auth.apiKey, headers: auth.headers, maxTokens },
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
		return text || null;
	} catch (err) {
		logger.warn({ err }, "[L2 summarizer] Failed");
		return null;
	}
}

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
	if (content.length <= MAX_CONTENT_LENGTH) {
		const prompt = SUMMARIZE_PROMPT.replace("{title}", title).replace("{content}", content);
		return completeSummary(model, modelRegistry, prompt, 4096);
	}

	const chunks = splitStructuralChunks(content);
	if (chunks.length > MAX_MODEL_CHUNKS) {
		logger.warn(
			{ chunks: chunks.length, characters: content.length },
			"[L2 summarizer] source exceeds bounded model chunk count; preserving full extracted content as fallback",
		);
		return null;
	}

	const summaries: string[] = [];
	for (let index = 0; index < chunks.length; index += 1) {
		const prompt = CHUNK_SUMMARY_PROMPT
			.replace("{part}", String(index + 1))
			.replace("{total}", String(chunks.length))
			.replace("{title}", title)
			.replace("{content}", chunks[index]);
		const summary = await completeSummary(model, modelRegistry, prompt, 1200);
		if (!summary) return null;
		summaries.push(`### 分块 ${index + 1}/${chunks.length}\n\n${summary}`);
	}

	const reducePrompt = REDUCE_SUMMARY_PROMPT
		.replace("{title}", title)
		.replace("{content}", summaries.join("\n\n"));
	return completeSummary(model, modelRegistry, reducePrompt, 4096);
}

/**
 * Generate a summary whose body carries inline `[n]` citation markers, plus a
 * list of grounded citations mapping each marker to a verbatim source quote.
 *
 * Returns `citations: null` when the model output cannot be parsed, or when the
 * source is long enough to require the chunked path (which does not emit inline
 * markers). `body` is null only when the model call failed entirely, matching
 * the plain `summarizeContent` contract.
 */
export async function summarizeContentGrounded(
	model: Model<any>,
	modelRegistry: ModelRegistry,
	title: string,
	content: string,
): Promise<{ body: string | null; citations: GroundedCitation[] | null }> {
	if (content.length > MAX_CONTENT_LENGTH) {
		const body = await summarizeContent(model, modelRegistry, title, content);
		return { body: body === null ? null : stripEvidenceMarkers(body), citations: null };
	}

	const prompt = GROUNDED_SUMMARIZE_PROMPT.replace("{title}", title).replace("{content}", content);
	const raw = await completeSummary(model, modelRegistry, prompt, 8192);
	const parsed = parseGroundedSummary(raw);
	if (parsed) return { body: parsed.body, citations: parsed.citations };

	// Fall back to a plain summary so a malformed grounded output never loses
	// the note itself; the caller can then leave the page without inline cites.
	const body = await summarizeContent(model, modelRegistry, title, content);
	return { body: body === null ? null : stripEvidenceMarkers(body), citations: null };
}
