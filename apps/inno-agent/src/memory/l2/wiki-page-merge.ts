/**
 * Merge an incoming page with an existing page while preserving provenance.
 *
 * The application always unions provenance/relationship arrays, asks the LLM
 * for a coherent body merge when bodies differ, rejects destructive shrinkage,
 * and locks identity fields to their on-disk values.
 */
import { completeWikiLlm as complete } from "./wiki-llm-compat.js";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import { parseFrontmatter } from "./wiki-maintainer.js";
import { isWikiLlmResponseAccepted, withWikiLlmPayloadAlignment } from "./wiki-llm-compat.js";
import {
	applyWikiPageStorageMetadata,
	mergeWikiFrontmatterArrays,
	readWikiPageStorageMetadata,
	setWikiFrontmatterScalar,
	stripWikiPageStorageMetadata,
	unionWikiPageStorageMetadata,
} from "./wiki-page-model-view.js";

const BODY_SHRINK_THRESHOLD = 0.7;

/** Default response budget for merge calls without an explicit override. */
export function computeWikiMergeMaxTokens(maxContextSize: number | undefined): number {
	const maxContext = typeof maxContextSize === "number" && maxContextSize > 0
		? maxContextSize
		: 204_800;
	const responseReserve = Math.floor(maxContext * 0.15);
	return Math.max(1, Math.min(16_384, Math.floor(responseReserve / 3)));
}

function outputText(response: Awaited<ReturnType<typeof complete>>): string {
	return response.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

export function buildWikiPageMergeSystemPrompt(): string {
	return [
		"Combine two versions of the same Inno Agent wiki page into one coherent file.",
		"The first input is the persisted page; the second is a new source-derived version. Both are evidence and neither may be silently discarded.",
		"The page may mention other subjects for comparison, but every comparison must stay attached to the subject and source that support it.",
		"",
		"Produce one complete Markdown file that:",
		"- preserves every factual claim from both candidates and removes only unambiguous repetition;",
		"- keeps conflicting or subject-specific claims separate instead of guessing a synthesis; when two similar claims may differ, retain both;",
		"- preserves source attribution, useful headings, tables, lists, callouts, identifiers, and `[[wikilink]]` references;",
		"- reads as one organized page rather than two appended drafts.",
		"",
		"Response rules: begin with YAML frontmatter at the first character, include the complete file, and do not add an explanation or Markdown fence. The caller deterministically rewrites `sources`, `tags`, `related`, and `updated`; preserve page identity and focus on merged content.",
	].join("\n");
}

export function buildWikiPageMergeUserPrompt(existingContent: string, incomingContent: string, sourceName: string): string {
	return [
		"## Persisted candidate",
		"",
		existingContent,
		"",
		"---",
		"",
		`## New candidate (evidence from ${sourceName})`,
		"",
		incomingContent,
		"",
		"---",
		"",
		"Return the complete reconciled file now; its first character must be `---`.",
	].join("\n");
}

export async function mergeWikiPageContent(
	existingContent: string,
	incomingContent: string,
	sourceName: string,
	model: Model<any>,
	modelRegistry: ModelRegistry,
	signal?: AbortSignal,
): Promise<{ content: string; usedFallback: boolean }> {
	throwIfAborted(signal);
	if (existingContent === incomingContent) return { content: existingContent, usedFallback: false };
	const storageMetadata = unionWikiPageStorageMetadata(
		readWikiPageStorageMetadata(existingContent),
		readWikiPageStorageMetadata(incomingContent),
	);
	const existingModelContent = stripWikiPageStorageMetadata(existingContent);
	const incomingModelContent = stripWikiPageStorageMetadata(incomingContent);
	const oldPage = parseFrontmatter(existingModelContent);
	const incomingPage = parseFrontmatter(incomingModelContent);
	if (!oldPage.frontmatter || !incomingPage.frontmatter) return { content: incomingContent, usedFallback: true };

	const arrayMergedModelContent = mergeWikiFrontmatterArrays(
		incomingModelContent,
		existingModelContent,
		["sources", "tags", "related"],
	);
	const arrayMergedPage = parseFrontmatter(arrayMergedModelContent);
	const arrayMerged = applyWikiPageStorageMetadata(arrayMergedModelContent, storageMetadata);
	if (oldPage.body.trim() === arrayMergedPage.body.trim()) return { content: arrayMerged, usedFallback: false };

	try {
		const auth = await modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) return { content: arrayMerged, usedFallback: true };
		const maxTokens = computeWikiMergeMaxTokens((model as { contextWindow?: number }).contextWindow);
		const response = await complete(
			model,
			{
				systemPrompt: buildWikiPageMergeSystemPrompt(),
				messages: [{
					role: "user" as const,
					content: [{ type: "text" as const, text: buildWikiPageMergeUserPrompt(existingModelContent, arrayMergedModelContent, sourceName) }],
					timestamp: Date.now(),
				}],
			},
			withWikiLlmPayloadAlignment({ apiKey: auth.apiKey, headers: auth.headers, maxTokens, temperature: 0.1, timeoutMs: 600_000, signal: withTimeout(signal) }),
		);
		throwIfAborted(signal);
		if (!isWikiLlmResponseAccepted(response)) return { content: arrayMerged, usedFallback: true };
		const proposed = outputText(response);
		const parsed = parseFrontmatter(proposed);
		if (!parsed.frontmatter) return { content: arrayMerged, usedFallback: true };
		const minimumBodyLength = Math.max(oldPage.body.length, arrayMergedPage.body.length) * BODY_SHRINK_THRESHOLD;
		if (parsed.body.length < minimumBodyLength) return { content: arrayMerged, usedFallback: true };

		let finalModelContent = proposed;
		for (const field of ["type", "title", "created"] as const) {
			const value = oldPage.frontmatter[field];
			if (typeof value === "string" && value) finalModelContent = setWikiFrontmatterScalar(finalModelContent, field, value);
		}
		finalModelContent = mergeWikiFrontmatterArrays(finalModelContent, arrayMergedModelContent, ["sources", "tags", "related"]);
		finalModelContent = setWikiFrontmatterScalar(finalModelContent, "updated", new Date().toISOString().slice(0, 10));
		return {
			content: applyWikiPageStorageMetadata(stripBodyWikilinkPathPrefixes(finalModelContent), storageMetadata),
			usedFallback: false,
		};
	} catch (err) {
		if (signal?.aborted) throw err;
		return { content: arrayMerged, usedFallback: true };
	}
}

function withTimeout(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(600_000);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	throw signal.reason instanceof Error ? signal.reason : new Error("Wiki ingestion cancelled");
}

/** Remove duplicate wikilinks after a successful merge. */
function stripBodyWikilinkPathPrefixes(content: string): string {
	const frontmatter = content.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
	if (!frontmatter) return content;
	const body = content.slice(frontmatter[0].length);
	if (!body.includes("[[")) return content;
	return `${frontmatter[0]}${normalizeWikilinksOutsideCode(body)}`;
}

function normalizeWikilinksOutsideCode(body: string): string {
	let fence: { marker: "`" | "~"; length: number } | null = null;
	return body.replace(/.*(?:\r?\n|$)/g, (line) => {
		const content = line.replace(/\r?\n$/, "");
		const markerMatch = content.match(/^ {0,3}(`{3,}|~{3,})/);
		if (markerMatch) {
			const marker = markerMatch[1][0] as "`" | "~";
			const length = markerMatch[1].length;
			if (!fence) fence = { marker, length };
			else if (marker === fence.marker && length >= fence.length && content.slice(markerMatch[0].length).trim() === "") fence = null;
			return line;
		}
		if (fence || /^(?: {4}|\t)/.test(content)) return line;
		return replaceOutsideInlineCode(line);
	});
}

function replaceOutsideInlineCode(text: string): string {
	let output = "";
	let cursor = 0;
	while (cursor < text.length) {
		const opening = text.indexOf("`", cursor);
		if (opening < 0) return output + replaceWikilinkPrefixes(text.slice(cursor));
		output += replaceWikilinkPrefixes(text.slice(cursor, opening));
		let runEnd = opening + 1;
		while (text[runEnd] === "`") runEnd += 1;
		const delimiter = text.slice(opening, runEnd);
		const closing = text.indexOf(delimiter, runEnd);
		if (closing < 0) {
			output += replaceWikilinkPrefixes(text.slice(opening, runEnd));
			cursor = runEnd;
			continue;
		}
		output += text.slice(opening, closing + delimiter.length);
		cursor = closing + delimiter.length;
	}
	return output;
}

const PAGE_WIKILINK_RE = /\[\[([^\]|\n]+)(?:\|([^\]\n]*))?\]\]/g;

function replaceWikilinkPrefixes(text: string): string {
	return text.replace(PAGE_WIKILINK_RE, (match, rawTarget: string, rawAlias: string | undefined, offset: number) => {
		if (offset > 0 && text[offset - 1] === "!") return match;
		const preceding = text.slice(0, offset).match(/\\+$/)?.[0].length ?? 0;
		if (preceding % 2 === 1) return match;
		const target = rawTarget.trim();
		const normalizedTarget = bareWikilinkTarget(target);
		if (normalizedTarget === target) return match;
		return `[[${normalizedTarget}${rawAlias === undefined ? "" : `|${rawAlias}`}]]`;
	});
}

function bareWikilinkTarget(target: string): string {
	if (!target || target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(target)) return target;
	const fragmentIndex = target.indexOf("#");
	const pageTarget = fragmentIndex >= 0 ? target.slice(0, fragmentIndex) : target;
	const fragment = fragmentIndex >= 0 ? target.slice(fragmentIndex) : "";
	const normalizedPath = pageTarget.replace(/\\/g, "/");
	if (!normalizedPath.includes("/")) return target;
	const leaf = normalizedPath.split("/").pop();
	if (!leaf) return target;
	const extensionIndex = leaf.lastIndexOf(".");
	if (extensionIndex > 0 && leaf.slice(extensionIndex).toLowerCase() !== ".md") return target;
	return `${leaf}${fragment}`;
}
