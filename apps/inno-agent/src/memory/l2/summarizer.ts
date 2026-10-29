/**
 * L2 Wiki Summarizer — uses the agent's configured model via PI SDK
 * to generate structured wiki summaries from extracted content.
 */

import { logger } from "../../logger.js";
import { completeWikiLlm as complete } from "./wiki-llm-compat.js";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { splitSourceIntoSemanticChunks } from "./structural-chunker.js";
import { computeWikiSourceBudget } from "./wiki-generator.js";
import { fileExists, readJson, writeJson } from "../../storage/file-store.js";
import { buildWikiLanguageDirective } from "./wiki-output-language.js";
import { isWikiLlmResponseAccepted, withWikiLlmPayloadAlignment } from "./wiki-llm-compat.js";

export function buildAnalysisSystemPrompt(purpose: string, schema: string, index: string): string {
	return [
		"Prepare a structured evidence review for the L2 page-writing stage.",
		"Think through the source internally, then return only the useful final analysis. Preserve distinctions that affect page routing or links.",
		buildWikiLanguageDirective(),
		"Use all of the following headings, in this order:",
		"## Key Entities",
		"List named people, organizations, products, datasets, tools, and similar subjects. For every item give its type, whether it is central or peripheral, its role here, and whether the current index appears to contain the same page.",
		"## Key Concepts",
		"List important theories, methods, techniques, phenomena, or abstractions. Give a short source-grounded definition, why it matters here, and any likely existing-page match.",
		"## Main Arguments & Findings",
		"State the source's main claims, results, limits, evaluations, and recommendations. Attach each item to the exact subject it concerns, cite the supporting evidence, and rate the evidence strength. Never transfer a claim between subjects merely because they share terms.",
		"## Connections to Existing Wiki",
		"Name supported relationships to existing pages and say whether the source confirms, extends, qualifies, or disputes them.",
		"## Contradictions & Tensions",
		"Record conflicts with the index, internal tensions, caveats, ambiguous identities, and evidence gaps. Keep unresolved uncertainty visible.",
		"## Recommendations",
		"Recommend pages to create or update, with the schema type and destination when known. State what deserves emphasis and what should be de-emphasized, plus useful open questions. Use extra schema types only when the source genuinely contains that kind of material; never invent goals, habits, decisions, or reflections.",
		"Use folder context only as a categorization hint, never as evidence for a factual claim.",
		"",
		schema ? `## Available schema\n${schema}` : "",
		purpose ? `## Wiki purpose\n${purpose}` : "",
		index ? `## Existing page index\n${index}` : "",
	].filter(Boolean).join("\n");
}

const LONG_SOURCE_CHUNK_MIN = 12_000;
const LONG_SOURCE_CHUNK_MAX = 60_000;
const LONG_SOURCE_DIGEST_MAX = 15_000;
const LONG_SOURCE_CHUNK_ANALYSIS_MAX = 40_000;

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.max(minimum, Math.min(maximum, value));
}

function trimLongText(text: string, maximum: number): string {
	return text.length <= maximum ? text : `${text.slice(0, maximum).trimEnd()}\n\n[...trimmed for prompt budget...]`;
}

function extractMarkedSection(raw: string, heading: string): string {
	const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(?:^|\\n)##\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, "i").exec(raw)?.[1]?.trim() ?? "";
}

export function hashLongSourceText(text: string): string {
	let hash = 0xcbf29ce484222325n;
	const prime = 0x100000001b3n;
	for (let index = 0; index < text.length; index += 1) {
		hash ^= BigInt(text.charCodeAt(index));
		hash = BigInt.asUintN(64, hash * prime);
	}
	return hash.toString(16).padStart(16, "0");
}

export function buildChunkSystemPrompt(purpose: string, schema: string, index: string): string {
	return [
		"Analyze the current main segment of a long source for the L2 wiki.",
		"The digest and overlap are context only. New findings must be supported by the main segment; do not promote a fact that appears only in overlap.",
		"Keep subject names and page identities stable against the index and the previous digest. Return the final result, never hidden reasoning.",
		buildWikiLanguageDirective(),
		"Return exactly the following two headings, in this order:",
		"## Chunk Analysis",
		"Summarize supported entities (including new or updated ones), concepts, schema-typed candidates, claims/findings, evidence, contradictions, and open questions introduced or clarified by this segment.",
		"## Updated Global Digest",
		"Update the compact whole-document digest while retaining earlier supported facts. Keep these categories: summary, entities, concepts, schema candidates, claims, evidence strength, contradictions, open questions, and cross-segment relations.",
		"Schema labels do not authorize invented user-authored state; only record a type when the source supports it.",
		"The stable project context below is background only:",
		purpose ? `## Purpose\n${purpose}` : "",
		schema ? `## Schema\n${schema}` : "",
		index ? `## Existing page index\n${trimLongText(index, 40_000)}` : "",
	].filter(Boolean).join("\n");
}

export function buildChunkUserPrompt(
	sourceIdentity: string,
	chunk: ReturnType<typeof splitSourceIntoSemanticChunks>[number],
	globalDigest: string,
	folderContext?: string,
	): string {
	return [
		`source = ${sourceIdentity}`,
		folderContext ? `folder_hint = ${folderContext}` : "",
		`segment = ${chunk.index}/${chunk.total}`,
		chunk.headingPath ? `heading_path = ${chunk.headingPath}` : "",
		"## Current Global Digest",
		globalDigest || "(No prior digest yet.)",
		chunk.overlapBefore ? "## Previous Overlap Context\n" + chunk.overlapBefore : "",
		"## MAIN CHUNK TO ANALYZE",
		chunk.main,
		"Return only the two requested sections. Do not repeat overlap-only facts unless the main segment supports them.",
	].filter(Boolean).join("\n");
}

async function completeSummary(
	model: Model<any>,
	modelRegistry: ModelRegistry,
	systemPrompt: string,
	userPrompt: string,
	maxTokens: number,
	signal?: AbortSignal,
): Promise<string> {
	try {
		const auth = await modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) {
			throw new Error("Failed to resolve API key");
		}

		const response = await complete(
			model,
			{
				systemPrompt,
				messages: [
					{
						role: "user" as const,
						content: [{ type: "text" as const, text: userPrompt }],
						timestamp: Date.now(),
					},
				],
			},
			withWikiLlmPayloadAlignment({
				apiKey: auth.apiKey,
				headers: auth.headers,
				maxTokens,
				temperature: 0.1,
				reasoning: "off",
				timeoutMs: 600_000,
				signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(600_000)]) : AbortSignal.timeout(600_000),
			}),
		);

		if (!isWikiLlmResponseAccepted(response)) {
			throw new Error(response.errorMessage ?? "LLM request failed");
		}

		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		return text;
	} catch (err) {
		logger.warn({ err }, "[L2 summarizer] Failed");
		throw err instanceof Error ? err : new Error(String(err));
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
	wikiContext = "（知识库为空）",
	options?: {
		checkpointPath?: string;
		sourceIdentity?: string;
		purpose?: string;
		schema?: string;
		index?: string;
		overview?: string;
			folderContext?: string;
			signal?: AbortSignal;
	},
): Promise<{ analysis: string; sourceContext: string; chunked: boolean } | null> {
	const purpose = options?.purpose ?? "";
	const schema = options?.schema ?? "";
	const index = options?.index ?? wikiContext;
	const overview = options?.overview ?? "";
	const maxContextSize = (model as { contextWindow?: number }).contextWindow;
	// Budget the source against the stable wiki context supplied to
	// autoIngestImpl, including the overview even though Stage 1 does not print it.
	const stableContextLength = purpose.length + schema.length + index.length + overview.length;
	const sourceBudget = computeWikiSourceBudget(maxContextSize, stableContextLength);
	if (content.length <= sourceBudget) {
		const systemPrompt = buildAnalysisSystemPrompt(purpose, schema, index);
		const userPrompt = `Analyze this source for the L2 page plan.\n\nsource = ${options?.sourceIdentity ?? title}${options?.folderContext ? `\nfolder_hint = ${options.folderContext}` : ""}\n\n## Source material\n${content}`;
		const analysis = await completeSummary(model, modelRegistry, systemPrompt, userPrompt, 4096, options?.signal);
		return { analysis, sourceContext: content, chunked: false };
	}

	const targetChars = clamp(Math.floor(sourceBudget * 0.55), LONG_SOURCE_CHUNK_MIN, LONG_SOURCE_CHUNK_MAX);
	const overlapChars = clamp(Math.floor(targetChars * 0.08), 800, 3_000);
	const chunks = splitSourceIntoSemanticChunks(content, targetChars, overlapChars);
	if (chunks.length <= 1) {
		const systemPrompt = buildAnalysisSystemPrompt(purpose, schema, index);
		const userPrompt = `Analyze this source for the L2 page plan.\n\nsource = ${options?.sourceIdentity ?? title}${options?.folderContext ? `\nfolder_hint = ${options.folderContext}` : ""}\n\n## Source material\n${content}`;
		const analysis = await completeSummary(model, modelRegistry, systemPrompt, userPrompt, 4096, options?.signal);
		return { analysis, sourceContext: content, chunked: false };
	}
	type Checkpoint = {
		version: 1; sourceIdentity: string; sourceHash: string; sourceLength: number; sourceBudget: number; targetChars: number;
		overlapChars: number; chunkTotal: number; completedThrough: number; globalDigest: string; analyses: string[]; updatedAt?: number;
	};
	const identity = options?.sourceIdentity ?? title;
	const sourceHash = hashLongSourceText(content);
	const emptyCheckpoint: Checkpoint = {
		version: 1, sourceIdentity: identity, sourceHash, sourceLength: content.length, sourceBudget, targetChars, overlapChars,
		chunkTotal: chunks.length, completedThrough: 0, globalDigest: "", analyses: [],
	};
	let checkpoint = emptyCheckpoint;
	if (options?.checkpointPath && fileExists(options.checkpointPath)) {
		const candidate = readJson<Checkpoint | null>(options.checkpointPath, null);
		if (candidate?.version === 1 && candidate.sourceIdentity === identity && candidate.sourceHash === sourceHash && candidate.sourceLength === content.length
			&& candidate.sourceBudget === sourceBudget && candidate.targetChars === targetChars && candidate.overlapChars === overlapChars
			&& candidate.chunkTotal === chunks.length && candidate.completedThrough >= 0 && candidate.completedThrough <= chunks.length
			&& Array.isArray(candidate.analyses) && candidate.analyses.length === candidate.completedThrough) checkpoint = candidate;
	}
	let globalDigest = checkpoint.globalDigest;
	const analyses = [...checkpoint.analyses];
	const chunkSystemPrompt = buildChunkSystemPrompt(purpose, schema, index);
	for (const chunk of chunks) {
		if (chunk.index <= checkpoint.completedThrough) continue;
		const raw = await completeSummary(
			model,
			modelRegistry,
			chunkSystemPrompt,
			buildChunkUserPrompt(identity, chunk, trimLongText(globalDigest, LONG_SOURCE_DIGEST_MAX), options?.folderContext),
			4096,
			options?.signal,
		);
		const chunkAnalysis = extractMarkedSection(raw, "Chunk Analysis") || raw.trim();
		const nextDigest = extractMarkedSection(raw, "Updated Global Digest");
		analyses.push(`## Chunk ${chunk.index}/${chunk.total}${chunk.headingPath ? ` — ${chunk.headingPath}` : ""}\n${trimLongText(chunkAnalysis, LONG_SOURCE_CHUNK_ANALYSIS_MAX)}`);
		globalDigest = trimLongText(nextDigest || [globalDigest, chunkAnalysis].filter(Boolean).join("\n\n"), LONG_SOURCE_DIGEST_MAX);
		checkpoint = { ...checkpoint, completedThrough: chunk.index, globalDigest, analyses: [...analyses], updatedAt: Date.now() };
		if (options?.checkpointPath) writeJson(options.checkpointPath, checkpoint);
	}
	const analysis = [
		"# Consolidated Long-Document Analysis", "", "## Final Global Digest", globalDigest || "(No digest produced.)", "",
		"## Per-Chunk Analyses", analyses.join("\n\n"),
	].join("\n");
	const sourceContext = [
		`# Consolidated source context: ${identity}`,
		"",
		`This source required ${chunks.length} ordered semantic segments. The digest and notes below represent the entire input; do not interpret their compact form as an early end of the source.`,
		"",
		"## Final digest",
		globalDigest || "(No digest produced.)",
		"",
		"## Segment analysis notes",
		trimLongText(analyses.join("\n\n"), Math.max(sourceBudget, LONG_SOURCE_CHUNK_ANALYSIS_MAX)),
	].join("\n");
	return { analysis, sourceContext, chunked: true };
}
