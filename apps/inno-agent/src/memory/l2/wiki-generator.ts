/**
 * Model-assisted wiki page generation. The module owns Inno's FILE contract,
 * storage metadata boundary, schema routing, and recovery behavior; the
 * prompts describe the desired page behavior without exposing storage fields
 * to the model.
 */
import { basename, dirname, join, normalize } from "node:path";
import { existsSync } from "node:fs";
import { completeWikiLlm as complete } from "./wiki-llm-compat.js";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import { ensureDir, readJsonl, readText, writeJsonl, writeText } from "../../storage/file-store.js";
import { logger } from "../../logger.js";
import type { ManifestEntry } from "./types.js";
import { getSourcePagePath, parseFrontmatter } from "./wiki-maintainer.js";
import { mergeWikiPageContent } from "./wiki-page-merge.js";
import { currentWikiDate } from "./wiki-date.js";
import {
	applyWikiPageStorageMetadata,
	readWikiPageStorageMetadata,
	setWikiFrontmatterScalar,
	writeWikiFrontmatterArray,
} from "./wiki-page-model-view.js";
import { sanitizeGeneratedWikiPage } from "./wiki-ingest-sanitize.js";
import { buildWikiLanguageDirective } from "./wiki-output-language.js";
import { isWikiLlmResponseAccepted, withWikiLlmPayloadAlignment } from "./wiki-llm-compat.js";
import { parseWikiSchemaRouting, validateWikiPageRouting, type WikiSchemaRouting } from "./wiki-schema-routing.js";

const OPENER_LINE = /^---\s*FILE:\s*(.+?)\s*---\s*$/i;
const CLOSER_LINE = /^---\s*END\s+FILE\s*---\s*$/i;
const FENCE_LINE = /^\s{0,3}(```+|~~~+)/;
const AGGREGATE_PATHS = new Set(["wiki/index.md", "wiki/overview.md", "wiki/log.md"]);
const LONG_SOURCE_MIN_BUDGET = 8_000;
const LONG_SOURCE_MAX_SINGLE_PASS_BUDGET = 300_000;

function isWindowsSafePathSegment(segment: string): boolean {
	if (!segment || /[<>:"|?*]/.test(segment) || /[ .]$/.test(segment)) return false;
	const stem = segment.split(".")[0]?.toUpperCase();
	return Boolean(stem) && !["CON", "PRN", "AUX", "NUL"].includes(stem!)
		&& !/^COM[1-9]$/.test(stem!) && !/^LPT[1-9]$/.test(stem!);
}

/** Reject paths that cannot be safely written inside the wiki directory. */
function isSafeIngestPath(path: string): boolean {
	if (!path.trim() || /[\x00-\x1f]/.test(path) || path.startsWith("/") || path.startsWith("\\") || /^[a-z]:/i.test(path)) return false;
	const normalizedPath = path.replace(/\\/g, "/");
	const segments = normalizedPath.split("/");
	return normalizedPath.startsWith("wiki/") && !segments.some((segment) => segment === "..")
		&& segments.every(isWindowsSafePathSegment);
}

export interface ParsedFileBlock {
	path: string;
	content: string;
}

/** Parse the model's line-oriented FILE block protocol. */
export function parseGeneratedFileBlocks(text: string): { blocks: ParsedFileBlock[]; warnings: string[]; truncatedPaths: string[] } {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const blocks: ParsedFileBlock[] = [];
	const warnings: string[] = [];
	const truncatedPaths: string[] = [];
	for (let index = 0; index < lines.length;) {
		const opener = OPENER_LINE.exec(lines[index]);
		if (!opener) { index += 1; continue; }
		const path = opener[1].trim();
		index += 1;
		const content: string[] = [];
		let fenceMarker: string | null = null;
		let fenceLength = 0;
		let closed = false;
		while (index < lines.length) {
			const line = lines[index];
			const fence = FENCE_LINE.exec(line);
			if (fence) {
				const marker = fence[1][0];
				if (fenceMarker === null) { fenceMarker = marker; fenceLength = fence[1].length; }
				else if (marker === fenceMarker && fence[1].length >= fenceLength) { fenceMarker = null; fenceLength = 0; }
				content.push(line); index += 1; continue;
			}
			if (fenceMarker === null && CLOSER_LINE.test(line)) { closed = true; index += 1; break; }
			content.push(line); index += 1;
		}
		if (!closed) {
			warnings.push(`FILE block \"${path || "(unnamed)"}\" was not closed before end of stream \u2014 likely truncation (model hit max_tokens, timeout, or connection dropped). Block dropped.`);
			if (path && isSafeIngestPath(path)) truncatedPaths.push(path);
			continue;
		}
		if (!path || !isSafeIngestPath(path)) {
			warnings.push(`FILE block with unsafe path \"${path || "(unnamed)"}\" rejected (must be under wiki/, no .., no absolute paths, and Windows-safe file names).`);
			continue;
		}
		blocks.push({ path, content: content.join("\n") });
	}
	return { blocks, warnings, truncatedPaths };
}

export interface RichGenerationResult {
	created: string[];
	updated: string[];
	pages: string[];
	aggregateWrites?: string[];
	reviews: number;
	warnings: string[];
	hardFailures: string[];
	unrecoveredTruncatedPaths: string[];
}

export interface WikiIngestReview {
	id: string;
	sourceId: string;
	sourcePath: string;
	type: "contradiction" | "duplicate" | "missing-page" | "suggestion" | "confirm";
	title: string;
	description: string;
	pages?: string[];
	search?: string[];
	options: Array<{ label: string; action: string }>;
	createdAt: string;
}

function outputText(response: Awaited<ReturnType<typeof complete>>): string {
	return response.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function withTimeout(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(600_000);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	throw signal.reason instanceof Error ? signal.reason : new Error("Wiki ingestion cancelled");
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.max(minimum, Math.min(maximum, value));
}

/** Select a bounded generation budget from the model context window. */
export function computeWikiGenerationMaxTokens(maxContextSize: number | undefined): number {
	const maxContext = maxContextSize && maxContextSize > 0 ? maxContextSize : 128_000;
	if (maxContext >= 512_000) return 32_768;
	if (maxContext >= 256_000) return 24_576;
	if (maxContext >= 128_000) return 16_384;
	return 8_192;
}

/** Reserve context and output space before sending source text to the model. */
export function computeWikiSourceBudget(maxContextSize: number | undefined, stableContextLength: number): number {
	const maxContext = maxContextSize && maxContextSize > 0 ? maxContextSize : 128_000;
	const responseReserve = computeWikiGenerationMaxTokens(maxContextSize);
	const stableReserve = Math.min(Math.floor(maxContext * 0.25), Math.max(12_000, stableContextLength));
	const instructionReserve = Math.max(12_000, Math.floor(maxContext * 0.08));
	const available = maxContext - responseReserve - stableReserve - instructionReserve;
	const upper = Math.min(LONG_SOURCE_MAX_SINGLE_PASS_BUDGET, Math.max(LONG_SOURCE_MIN_BUDGET, Math.floor(maxContext * 0.6)));
	return clamp(Math.floor(available), LONG_SOURCE_MIN_BUDGET, upper);
}

function trimForPrompt(value: string, maximum: number): string {
	return value.length <= maximum ? value : `${value.slice(0, maximum).trimEnd()}\n\n[...trimmed for prompt budget...]`;
}

export function buildPrompt(
	entry: ManifestEntry,
	sourceIdentity: string,
	sourcePagePath: string,
	sourceContent: string,
	schema: string,
	purpose: string,
	index: string,
	overview: string,
): string {
	const today = currentWikiDate();
	return [
		"Act as the L2 wiki maintainer for this one source and its preceding analysis.",
		"The response is a parser input: emit only FILE blocks followed, if needed, by REVIEW blocks. Do not expose private reasoning or explanatory prose.",
		"",
		buildWikiLanguageDirective(),
		"",
		"## Run constants",
		`source = ${sourceIdentity}`,
		`source_page = ${sourcePagePath}`,
		`date = ${today}`,
		"Use these values literally. Every generated knowledge page must list the source value in frontmatter `sources`.",
		"",
		"## Required deliverables",
		`- First, one complete source-summary page at exactly \`${sourcePagePath}\`.`,
		"- Separate pages for the important named subjects and ideas identified by the analysis; use schema-specific entity/concept destinations when available.",
		"- A `wiki/log.md` FILE block containing only the new ingest entry headed `## [YYYY-MM-DD] ingest | Title`.",
		"Do not emit `wiki/index.md` or `wiki/overview.md`; Inno maintains those files deterministically.",
		"",
		schema ? `## Routing contract\n${schema}\n\nThe schema is authoritative. Use its page types and directories whenever they fit the source. Fall back to \`wiki/entities/\` for named subjects and \`wiki/concepts/\` for ideas. The frontmatter type and FILE directory must agree.` : "",
		"",
		"## Page contract",
		"Each knowledge page starts with YAML frontmatter on the first line and then a Markdown body:",
		"The fenced example below illustrates the contents only; do not include the Markdown fence in a FILE block.",
		"",
		"```yaml",
		"---",
		"type: entity",
		"title: Example subject",
		`created: ${today}`,
		`updated: ${today}`,
		"tags: [example]",
		"related: [related-page]",
		`sources: ["${sourceIdentity}"]`,
		"---",
		"```",
		"",
		"Every page must contain the keys `type`, `title`, `created`, `updated`, `tags`, `related`, and `sources`. Quote YAML strings when needed. Arrays use inline YAML with bare slugs in `related`; put `[[wikilinks]]` only in the body.",
		"Use `[[wikilink]]` references when the source or current index supports a real relationship. Keep every claim, result, limit, and recommendation attached to the subject and evidence it describes; shared terminology alone is not evidence that claims transfer between subjects.",
		"When a page links to another generated page, use only that page's emitted FILE basename as a bare wikilink target (no `wiki/`, directory prefix, or `.md`). The target must exactly match the basename. Do not link to an English, pinyin, or provisional slug if the target FILE uses a CJK title-derived basename; choose one basename and use it consistently in the FILE path, body links, and related slugs.",
		"Follow the analysis for emphasis and de-emphasis, but do not manufacture details that are absent from source evidence.",
		"Keep source structure that would be damaged by prose summarization, including tables, schemas, DDL, API signatures, configuration, identifiers, types, constraints, keys, and indexes.",
		"Use wiki-root-relative media paths. For filenames, use kebab-case for Latin prose, readable CJK for CJK titles, and standard spellings for proper nouns or technical identifiers. Never place URLs, citations, or absolute paths in a filename.",
		"",
		"## Optional review contract",
		"After FILE blocks, create reviews only for consequential contradictions, likely duplicates, important missing pages, or worthwhile follow-up questions. Use type `contradiction`, `duplicate`, `missing-page`, or `suggestion`.",
		"Every review uses `OPTIONS: Create Page | Skip`. A suggestion or missing page also supplies two or three concise search queries separated by ` | `.",
		"Keep the review set small and high-signal (at most five items); emit none when no human decision is useful.",
		"",
		purpose ? `## Wiki Purpose\n${purpose}` : "",
		index ? `## Existing Page Index\n${index}` : "",
		overview ? `## Existing Wiki Overview\n${overview}` : "",
		"",
		"## Response grammar",
		"```",
		"---FILE: wiki/path/to/page.md---",
		"<complete page>",
		"---END FILE---",
		"",
		"---REVIEW: type | Title---",
		"<why human attention is needed>",
		"OPTIONS: Create Page | Skip",
		"PAGES: wiki/example.md",
		"SEARCH: query one | query two",
		"---END REVIEW---",
		"```",
		"",
		"The first character must begin `---FILE:`. Put the source page first, then other FILE blocks, then optional REVIEW blocks. Outside blocks use only blank lines. Every requested block must be complete and closed; do not add any text after the final closer. Preserve standard names, identifiers, URLs, filenames, citations, and technical terms even when surrounding prose is localized.",
		"",
		buildWikiLanguageDirective(),
	].filter(Boolean).join("\n");
}

function buildUserPrompt(sourceIdentity: string, analysis: string, sourceContent: string): string {
	return [
		`Build the L2 pages for source \`${sourceIdentity}\` from the following evidence.`,
		"The analysis guides selection and routing; it is not itself output.",
		"## Analysis",
		analysis,
		"## Source material",
		sourceContent,
		`Emit the complete FILE sequence for \`${sourceIdentity}\` now. Start with \`---FILE:\`.`,
	].join("\n");
}

function safeRelativePath(raw: string, sourcePagePath: string): string | null {
	const rel = normalize(raw.trim()).replaceAll("\\", "/").replace(/^\.\//, "");
	if (!isSafeIngestPath(rel) || !rel.endsWith(".md")) return null;
	if (rel.startsWith("wiki/sources/")) return sourcePagePath;
	if (rel === "wiki/index.md" || rel === "wiki/overview.md") return null;
	return rel;
}

function unique(values: string[]): string[] {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

/** Ensure generated page bodies use the configured Chinese target language. */
function contentMatchesChineseTarget(content: string): boolean {
	const frontmatterEnd = content.indexOf("\n---\n", 3);
	let body = frontmatterEnd > 0 ? content.slice(frontmatterEnd + 5) : content;
	body = body
		.replace(/```[\s\S]*?```/g, "")
		.replace(/\$\$[\s\S]*?\$\$/g, "")
		.replace(/\$[^$\n]*\$/g, "");
	const sample = body.slice(0, 1_500);
	if (sample.trim().length < 20) return true;

	const counts = new Map<string, number>();
	for (const character of sample) {
		const codePoint = character.codePointAt(0);
		if (!codePoint || codePoint < 0x80) continue;
		const script = nonLatinScript(codePoint);
		if (script) counts.set(script, (counts.get(script) ?? 0) + 1);
	}
	if ((counts.get("Japanese") ?? 0) > 0 && (counts.get("Chinese") ?? 0) > 0) return true;
	let detected = "English";
	let maximum = 0;
	for (const [script, count] of counts) {
		if (count > maximum) { detected = script; maximum = count; }
	}
	if (maximum < 2) detected = "English";
	return new Set(["Chinese", "Japanese", "Korean"]).has(detected);
}

/** Unicode script ranges used by the Chinese language guard. */
function nonLatinScript(codePoint: number): string | null {
	if ((codePoint >= 0x4e00 && codePoint <= 0x9fff) || (codePoint >= 0x3400 && codePoint <= 0x4dbf)
		|| (codePoint >= 0x20000 && codePoint <= 0x2a6df) || (codePoint >= 0xf900 && codePoint <= 0xfaff)) return "Chinese";
	if ((codePoint >= 0x3040 && codePoint <= 0x309f) || (codePoint >= 0x30a0 && codePoint <= 0x30ff)
		|| (codePoint >= 0x31f0 && codePoint <= 0x31ff) || (codePoint >= 0xff65 && codePoint <= 0xff9f)) return "Japanese";
	if ((codePoint >= 0xac00 && codePoint <= 0xd7af) || (codePoint >= 0x1100 && codePoint <= 0x11ff)
		|| (codePoint >= 0x3130 && codePoint <= 0x318f)) return "Korean";
	if ((codePoint >= 0x0600 && codePoint <= 0x06ff) || (codePoint >= 0x0750 && codePoint <= 0x077f)
		|| (codePoint >= 0x08a0 && codePoint <= 0x08ff) || (codePoint >= 0xfb50 && codePoint <= 0xfdff)
		|| (codePoint >= 0xfe70 && codePoint <= 0xfeff)) return "Arabic";
	if ((codePoint >= 0x0590 && codePoint <= 0x05ff) || (codePoint >= 0xfb1d && codePoint <= 0xfb4f)) return "Hebrew";
	if (codePoint >= 0x0e00 && codePoint <= 0x0e7f) return "Thai";
	if (codePoint >= 0x0900 && codePoint <= 0x097f) return "Hindi";
	if (codePoint >= 0x0980 && codePoint <= 0x09ff) return "Bengali";
	if (codePoint >= 0x0b80 && codePoint <= 0x0bff) return "Tamil";
	if (codePoint >= 0x0c00 && codePoint <= 0x0c7f) return "Telugu";
	if (codePoint >= 0x0c80 && codePoint <= 0x0cff) return "Kannada";
	if (codePoint >= 0x0d00 && codePoint <= 0x0d7f) return "Malayalam";
	if (codePoint >= 0x0a80 && codePoint <= 0x0aff) return "Gujarati";
	if (codePoint >= 0x0a00 && codePoint <= 0x0a7f) return "Punjabi";
	if (codePoint >= 0x1000 && codePoint <= 0x109f) return "Burmese";
	if (codePoint >= 0x1780 && codePoint <= 0x17ff) return "Khmer";
	if (codePoint >= 0x0e80 && codePoint <= 0x0eff) return "Lao";
	if ((codePoint >= 0x10a0 && codePoint <= 0x10ff) || (codePoint >= 0x2d00 && codePoint <= 0x2d2f)) return "Georgian";
	if (codePoint >= 0x0530 && codePoint <= 0x058f) return "Armenian";
	if (codePoint >= 0x1200 && codePoint <= 0x137f) return "Amharic";
	if (codePoint >= 0x0f00 && codePoint <= 0x0fff) return "Tibetan";
	if (codePoint >= 0x0d80 && codePoint <= 0x0dff) return "Sinhala";
	if ((codePoint >= 0x0400 && codePoint <= 0x04ff) || (codePoint >= 0x0500 && codePoint <= 0x052f)) return "Russian";
	if ((codePoint >= 0x0370 && codePoint <= 0x03ff) || (codePoint >= 0x1f00 && codePoint <= 0x1fff)) return "Greek";
	return null;
}

function canonicalGeneratedSources(sources: string[], promptSourceIdentity: string): string[] {
	const normalizedIdentity = normalize(promptSourceIdentity).replaceAll("\\", "/").replace(/^(?:\.\/)+/, "");
	const identityKey = normalizedIdentity.toLowerCase();
	const identityBaseName = basename(normalizedIdentity).toLowerCase();
	const canonical = sources.flatMap((source) => {
		const normalizedSource = normalize(source).replaceAll("\\", "/").replace(/^(?:\.\/)+/, "");
		const key = normalizedSource.toLowerCase();
		if (!normalizedSource || normalizedSource.startsWith("/") || /^[a-z]:\//i.test(normalizedSource)) return [];
		if (normalizedSource.split("/").some((part) => part === "..")) return [];
		if (normalizedSource.split("/").some((part) => part.startsWith("."))) return [];
		if (["wiki/index.md", "wiki/overview.md", "wiki/log.md"].includes(key)) return [];
		if (key === identityKey || (!normalizedSource.includes("/") && key === identityBaseName)) return [normalizedIdentity];
		return [normalizedSource];
	});
	return unique([...canonical, normalizedIdentity]);
}

/** Normalize a generated path when its title indicates a target-language rewrite. */
export function canonicalizeGeneratedPagePath(rel: string, content: string, sourcePagePath: string): string {
	if (rel === sourcePagePath || AGGREGATE_PATHS.has(rel)) return rel;
	const filename = rel.slice(rel.lastIndexOf("/") + 1);
	if (/\p{Script=Han}/u.test(filename)) return rel;
	const parsed = parseFrontmatter(sanitizeGeneratedWikiPage(content));
	const title = parsed.frontmatter?.title?.trim() || parsed.body.match(/^#\s+(.+)$/m)?.[1]?.trim();
	if (!title || !/\p{Script=Han}/u.test(title)) return rel;
	const slug = Array.from(title
		.normalize("NFKC")
		.toLowerCase()
		.trim()
		.replace(/\s+/g, "-")
		.replace(/[^\p{L}\p{N}-]/gu, "")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, ""))
		.slice(0, 50)
		.join("");
	if (!slug) return rel;
	return `${rel.slice(0, rel.lastIndexOf("/") + 1)}${slug}.md`;
}

function normalizeGeneratedPage(rel: string, content: string, entry: ManifestEntry, promptSourceIdentity: string): string {
	let modelVisibleContent = sanitizeGeneratedWikiPage(content);
	const parsed = parseFrontmatter(modelVisibleContent);
	const today = currentWikiDate();
	modelVisibleContent = setWikiFrontmatterScalar(modelVisibleContent, "created", today);
	modelVisibleContent = setWikiFrontmatterScalar(modelVisibleContent, "updated", today);
	modelVisibleContent = writeWikiFrontmatterArray(
		modelVisibleContent,
		"sources",
		canonicalGeneratedSources(parsed.frontmatter?.sources ?? [], promptSourceIdentity),
	);
	const emittedStorage = readWikiPageStorageMetadata(modelVisibleContent);
	return applyWikiPageStorageMetadata(modelVisibleContent, {
		...emittedStorage,
		sourceIds: unique([...emittedStorage.sourceIds, entry.id]),
	});
}

export function parseGeneratedReviewBlocks(text: string, entry: Pick<ManifestEntry, "id" | "rawPath">): WikiIngestReview[] {
	const reviews: WikiIngestReview[] = [];
	const pattern = /---REVIEW:\s*(\w[\w-]*)\s*\|\s*(.+?)\s*---\n([\s\S]*?)---END REVIEW---/g;
	for (const match of text.matchAll(pattern)) {
		const rawType = match[1].trim().toLowerCase();
		const body = match[3].trim();
		const optionsLine = body.match(/^OPTIONS:\s*(.+)$/m)?.[1];
		const pagesLine = body.match(/^PAGES:\s*(.+)$/m)?.[1];
		const searchLine = body.match(/^SEARCH:\s*(.+)$/m)?.[1];
		const description = body
			.replace(/^OPTIONS:.*$/m, "")
			.replace(/^PAGES:.*$/m, "")
			.replace(/^SEARCH:.*$/m, "")
			.trim();
		reviews.push({
			id: `l2review_${entry.id}_${reviews.length + 1}`,
			sourceId: entry.id,
			sourcePath: entry.rawPath,
			type: ["contradiction", "duplicate", "missing-page", "suggestion"].includes(rawType)
				? rawType as WikiIngestReview["type"]
				: "confirm",
			title: match[2].trim(),
			description,
			...(pagesLine && { pages: pagesLine.split(",").map((value) => value.trim()) }),
			...(searchLine && { search: searchLine.split("|").map((value) => value.trim()).filter(Boolean) }),
			options: optionsLine
				? optionsLine.split("|").map((value) => value.trim()).map((label) => ({ label, action: label }))
				: [{ label: "Approve", action: "Approve" }, { label: "Skip", action: "Skip" }],
			createdAt: new Date().toISOString(),
		});
	}
	return reviews;
}

function replaceSourceReviews(l2DataDir: string, entry: ManifestEntry, reviews: WikiIngestReview[]): void {
	const reviewPath = join(l2DataDir, "reviews.jsonl");
	const retained = readJsonl<WikiIngestReview>(reviewPath).filter((review) => review.sourceId !== entry.id);
	writeJsonl(reviewPath, [...retained, ...reviews]);
}

function countGeneratedFileBlocks(text: string): number {
	return (text.match(/---FILE:\s*[^-]+---/g) ?? []).length;
}

export function shouldRunDedicatedReviewStage(generation: string): boolean {
	return generation.length >= 10_000
		|| countGeneratedFileBlocks(generation) >= 4
		|| /---REVIEW:\s*[\w-]+\s*\|[\s\S]*$/i.test(generation);
}

export function buildTruncatedRepairPrompt(
	paths: string[],
	entry: ManifestEntry,
	sourceIdentity: string,
	analysis: string,
	sourceContext: string,
	schema: string,
	purpose: string,
	maxContextSize: number | undefined,
): string {
	const maxContext = maxContextSize && maxContextSize > 0 ? maxContextSize : 128_000;
	const sectionCap = Math.max(4_000, Math.floor(maxContext * 0.12));
	return [
		"Repair the truncated FILE output from the previous L2 generation attempt.",
		"Return exactly one complete FILE block for every requested path, in the same order, and no other block type.",
		"Keep each requested path byte-for-byte unchanged, close every block, and include the source identity in each page's `sources` array.",
		"Reconstruct the full frontmatter and body from the supplied analysis and source evidence; do not emit a stub or partial page.",
		"",
		buildWikiLanguageDirective(),
		"",
		"## Files to reconstruct",
		...paths.map((path) => `- ${path}`),
		"",
		`source = ${sourceIdentity}`,
		schema ? `## Routing information\n${trimForPrompt(schema, sectionCap)}` : "",
		purpose ? `## Wiki purpose\n${trimForPrompt(purpose, sectionCap)}` : "",
		`## Prior analysis\n${trimForPrompt(analysis, sectionCap)}`,
		`## Source evidence\n${trimForPrompt(sourceContext, sectionCap)}`,
		"Start with the first FILE marker. Do not add a review, explanation, markdown fence, or trailing commentary around the response.",
	].filter(Boolean).join("\n");
}

export function filterTruncatedRepairOutput(
	text: string,
	allowedPaths: readonly string[],
): { text: string; paths: string[]; warnings: string[] } {
	const allowed = new Set(allowedPaths.map(normalizedPathKey));
	const parsed = parseGeneratedFileBlocks(text);
	const warnings = [...parsed.warnings];
	const seen = new Set<string>();
	const kept: ParsedFileBlock[] = [];
	const dropped: ParsedFileBlock[] = [];
	const duplicates: ParsedFileBlock[] = [];
	for (const block of parsed.blocks) {
		const pathKey = normalizedPathKey(block.path);
		if (!allowed.has(pathKey)) {
			dropped.push(block);
			continue;
		}
		if (seen.has(pathKey)) {
			duplicates.push(block);
			continue;
		}
		seen.add(pathKey);
		kept.push(block);
	}
	if (dropped.length > 0) {
		warnings.push(`Dropped ${dropped.length} unrequested FILE block(s) from truncated repair output: ${dropped.map((block) => block.path).join(", ")}`);
	}
	if (duplicates.length > 0) {
		warnings.push(`Dropped ${duplicates.length} duplicate FILE block(s) from truncated repair output: ${duplicates.map((block) => block.path).join(", ")}`);
	}
	return {
		text: kept.map((block) => `---FILE: ${block.path}---\n${block.content.trimEnd()}\n---END FILE---`).join("\n\n"),
		paths: kept.map((block) => block.path),
		warnings,
	};
}

export function buildReviewPrompt(
	purpose: string,
	index: string,
	sourceIdentity: string,
	analysis: string,
	sourceContext: string,
	generated: string,
	maxContextSize: number | undefined,
): string {
	const maxContext = maxContextSize && maxContextSize > 0 ? maxContextSize : 128_000;
	const sectionCap = Math.max(4_000, Math.floor(maxContext * 0.15));
	const indexCap = Math.max(3_000, Math.floor(sectionCap * 0.8));
	return [
		"Inspect the generated L2 material for unresolved items that warrant a human decision or follow-up research.",
		"The page-writing stage is finished. Return only closed REVIEW blocks; never include FILE blocks, private reasoning, or an explanation.",
		"",
		buildWikiLanguageDirective(),
		"",
		"Flag only high-signal unresolved issues; do not repeat facts that are already adequately represented by pages.",
		"",
		"Allowed review types:",
		"- missing-page: a material subject is referenced but has no page",
		"- suggestion: a concrete question or comparison that would improve the wiki",
		"- contradiction: source evidence and existing pages disagree",
		"- duplicate: two pages may describe one subject",
		"",
		"Produce between one and five high-signal reviews when issues exist. Emit nothing when there is no useful issue.",
		"Use exactly `OPTIONS: Create Page | Skip`. For `missing-page` and `suggestion`, add two or three search phrases separated by ` | `.",
		"",
		"Review syntax:",
		"```",
		"---REVIEW: suggestion | Precise title---",
		"Why this issue matters.",
		"OPTIONS: Create Page | Skip",
		"PAGES: wiki/page1.md, wiki/page2.md",
		"SEARCH: query 1 | query 2 | query 3",
		"---END REVIEW---",
		"```",
		"",
		"Return REVIEW blocks only. The first character must begin a REVIEW marker; do not wrap the response in a Markdown fence and do not append commentary.",
		"",
		purpose ? `## Purpose\n${purpose}` : "",
		index ? `## Existing index\n${trimForPrompt(index, indexCap)}` : "",
		"",
		`## Source\n${sourceIdentity}`,
		"",
		"## Analysis",
		trimForPrompt(analysis, sectionCap),
		"",
		"## Source evidence",
		trimForPrompt(sourceContext, sectionCap),
		"",
		"## Generated pages",
		trimForPrompt(generated, sectionCap),
	].filter(Boolean).join("\n");
}

interface RichWriteResult {
	created: string[];
	updated: string[];
	pages: string[];
	aggregateWrites: string[];
	completedInputPaths: string[];
	warnings: string[];
	hardFailures: string[];
}

function normalizedPathKey(path: string): string {
	return normalize(path).replaceAll("\\", "/");
}

/**
 * A malformed or rejected FILE block is a warning, while an actual filesystem
 * failure is accumulated and does not prevent other generated pages from being written.
 */
async function writeGeneratedFileBlocks(
	l2DataDir: string,
	blocks: ParsedFileBlock[],
	entry: ManifestEntry,
	sourceIdentity: string,
	sourcePagePath: string,
	routing: WikiSchemaRouting,
	model: Model<any>,
	modelRegistry: ModelRegistry,
	signal?: AbortSignal,
): Promise<RichWriteResult> {
	const created: string[] = [];
	const updated: string[] = [];
	const pages: string[] = [];
	const aggregateWrites: string[] = [];
	const completedInputPaths: string[] = [];
	const warnings: string[] = [];
	const hardFailures: string[] = [];
	for (const block of blocks) {
		throwIfAborted(signal);
		const requestedRel = safeRelativePath(block.path, sourcePagePath);
		if (!requestedRel) {
			warnings.push(`FILE block \"${block.path}\" is outside Inno's supported wiki page directories and was dropped.`);
			continue;
		}
		const rel = canonicalizeGeneratedPagePath(requestedRel, block.content, sourcePagePath);
		if (rel === "wiki/log.md") {
			try {
				const abs = join(l2DataDir, rel);
				ensureDir(dirname(abs));
				const content = stampGeneratedLogDate(block.content, currentWikiDate()).trim();
				const existing = existsSync(abs) ? readText(abs).trim() : "";
				writeText(abs, existing ? `${existing}\n\n${content}` : content);
				aggregateWrites.push(rel);
				completedInputPaths.push(block.path);
			} catch (err) {
				const message = `Failed to write \"${rel}\": ${err instanceof Error ? err.message : String(err)}`;
				logger.warn({ err, source: entry.rawPath, path: rel }, "rich wiki FILE block write failed");
				warnings.push(message);
				hardFailures.push(rel);
			}
			continue;
		}
		const normalized = normalizeGeneratedPage(rel, sanitizeGeneratedWikiPage(block.content), entry, sourceIdentity);
		const routingIssue = validateWikiPageRouting(rel, normalized, routing);
		if (routingIssue) {
			warnings.push(`Dropped \"${rel}\" \u2014 ${routingIssue.message}`);
			continue;
		}
		const isEntityOrSource = rel.includes("/entities/") || rel.includes("/sources/");
		if (!isEntityOrSource && !contentMatchesChineseTarget(normalized)) {
			warnings.push(`Dropped \"${rel}\" \u2014 body language doesn't match target Chinese.`);
			continue;
		}

		try {
			const abs = join(l2DataDir, rel);
			ensureDir(dirname(abs));
			if (existsSync(abs)) {
				const existing = readText(abs);
				const oldPage = parseFrontmatter(existing);
				const ownedOnlyByCurrentSource = Boolean(
					oldPage.frontmatter?.source_ids.length
					&& oldPage.frontmatter.source_ids.every((sourceId) => sourceId === entry.id),
				);
				if (ownedOnlyByCurrentSource) {
					backupExistingPage(l2DataDir, rel, existing);
					writeText(abs, normalized);
				} else {
					const merged = await mergeWikiPageContent(existing, normalized, sourceIdentity, model, modelRegistry, signal);
					if (merged.usedFallback) {
						backupExistingPage(l2DataDir, rel, existing);
					}
					writeText(abs, merged.content);
				}
				updated.push(rel);
			} else {
				writeText(abs, normalized);
				created.push(rel);
			}
			pages.push(rel);
			completedInputPaths.push(block.path);
		} catch (err) {
			const message = `Failed to write \"${rel}\": ${err instanceof Error ? err.message : String(err)}`;
			logger.warn({ err, source: entry.rawPath, path: rel }, "rich wiki FILE block write failed");
			warnings.push(message);
			hardFailures.push(rel);
		}
	}

	return { created, updated, pages, aggregateWrites, completedInputPaths, warnings, hardFailures };
}

function backupExistingPage(l2DataDir: string, wikiPath: string, content: string): void {
	const historyDir = join(l2DataDir, "page-history");
	ensureDir(historyDir);
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const name = wikiPath.replaceAll("/", "_").replace(/\.md$/i, "");
	writeText(join(historyDir, `${name}-${stamp}.md`), content);
}

function stampGeneratedLogDate(content: string, date: string): string {
	const normalized = content.replace(/\bYYYY-MM-DD\b/g, date);
	if (!/^\s*##\s*\[?\d{4}-\d{2}-\d{2}\]?/m.test(normalized)) return normalized;
	return normalized.replace(/^(\s*##\s*\[?)\d{4}-\d{2}-\d{2}(\]?)/m, `$1${date}$2`);
}

export async function generateRichWikiPages(
	l2DataDir: string,
	entry: ManifestEntry,
	analysis: string,
	sourceContent: string,
	context: { schema: string; purpose?: string; index: string; overview?: string; sourceIdentity?: string },
	model: Model<any>,
	modelRegistry: ModelRegistry,
	signal?: AbortSignal,
): Promise<RichGenerationResult | null> {
	try {
		const auth = await modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) throw new Error("Failed to resolve API key");
		const maxContextSize = (model as { contextWindow?: number }).contextWindow;
		const maxTokens = computeWikiGenerationMaxTokens(maxContextSize);
		const sourceIdentity = context.sourceIdentity ?? entry.rawPath;
		const sourcePagePath = getSourcePagePath(entry, context.sourceIdentity);
		const routing = parseWikiSchemaRouting(context.schema);
		const generationSourceContext = sourceContent;
		const response = await complete(
			model,
			{
				systemPrompt: buildPrompt(entry, sourceIdentity, sourcePagePath, generationSourceContext, context.schema, context.purpose ?? "", context.index, context.overview ?? ""),
				messages: [{ role: "user" as const, content: [{ type: "text" as const, text: buildUserPrompt(sourceIdentity, analysis, generationSourceContext) }], timestamp: Date.now() }],
			},
			withWikiLlmPayloadAlignment({ apiKey: auth.apiKey, headers: auth.headers, maxTokens, temperature: 0.1, reasoning: "off", timeoutMs: 600_000, signal: withTimeout(signal) }),
		);
		throwIfAborted(signal);
		if (!isWikiLlmResponseAccepted(response)) throw new Error(response.errorMessage ?? "wiki generation failed");
		const generated = outputText(response);
		let reviewText = generated;
		if (shouldRunDedicatedReviewStage(generated)) {
			try {
				const reviewResponse = await complete(model, {
					systemPrompt: buildReviewPrompt(context.purpose ?? "", context.index, sourceIdentity, analysis, generationSourceContext, generated, maxContextSize),
					messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "Emit only high-value REVIEW blocks for follow-up research or unresolved knowledge gaps. Output nothing if there are none." }], timestamp: Date.now() }],
				}, withWikiLlmPayloadAlignment({ apiKey: auth.apiKey, headers: auth.headers, maxTokens: Math.min(8_192, Math.max(4_096, Math.floor(maxTokens / 2))), temperature: 0.1, reasoning: "off", timeoutMs: 600_000, signal: withTimeout(signal) }));
				throwIfAborted(signal);
				if (!isWikiLlmResponseAccepted(reviewResponse)) throw new Error(reviewResponse.errorMessage ?? "review generation failed");
				reviewText += `\n${outputText(reviewResponse)}`;
			} catch (err) {
				logger.warn({ err, source: entry.rawPath }, "dedicated wiki review generation failed");
			}
		}
		const parsedOutput = parseGeneratedFileBlocks(generated);
		const warnings = [...parsedOutput.warnings];
		const initialWrite = await writeGeneratedFileBlocks(l2DataDir, parsedOutput.blocks, entry, sourceIdentity, sourcePagePath, routing, model, modelRegistry, signal);
		warnings.push(...initialWrite.warnings);
		const created = [...initialWrite.created];
		const updated = [...initialWrite.updated];
		const pages = [...initialWrite.pages];
		const aggregateWrites = [...initialWrite.aggregateWrites];
		const hardFailures = [...initialWrite.hardFailures];
		const initialWrittenPaths = [...initialWrite.pages, ...initialWrite.aggregateWrites];
		let unrecoveredTruncatedPaths = unique(parsedOutput.truncatedPaths.filter((path) =>
			!initialWrittenPaths.some((writtenPath) => normalizedPathKey(writtenPath) === normalizedPathKey(path)),
		));

		if (unrecoveredTruncatedPaths.length > 0) {
			try {
				const repairResponse = await complete(model, {
					systemPrompt: buildTruncatedRepairPrompt(unrecoveredTruncatedPaths, entry, sourceIdentity, analysis, generationSourceContext, context.schema, context.purpose ?? "", maxContextSize),
					messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "Regenerate the requested FILE blocks now. Start immediately with `---FILE:`." }], timestamp: Date.now() }],
					}, withWikiLlmPayloadAlignment({ apiKey: auth.apiKey, headers: auth.headers, maxTokens, temperature: 0.1, reasoning: "off", timeoutMs: 600_000, signal: withTimeout(signal) }));
					throwIfAborted(signal);
				if (!isWikiLlmResponseAccepted(repairResponse)) throw new Error(repairResponse.errorMessage ?? "truncated FILE repair failed");
				const filteredRepair = filterTruncatedRepairOutput(outputText(repairResponse), unrecoveredTruncatedPaths);
				warnings.push(...filteredRepair.warnings);
				const repairBlocks = parseGeneratedFileBlocks(filteredRepair.text).blocks;
					const repairWrite = await writeGeneratedFileBlocks(l2DataDir, repairBlocks, entry, sourceIdentity, sourcePagePath, routing, model, modelRegistry, signal);
				warnings.push(...repairWrite.warnings);
				created.push(...repairWrite.created);
				updated.push(...repairWrite.updated);
				pages.push(...repairWrite.pages);
				aggregateWrites.push(...repairWrite.aggregateWrites);
				hardFailures.push(...repairWrite.hardFailures);
				const completedRepairPaths = new Set(repairWrite.completedInputPaths.map(normalizedPathKey));
				const recoveredPaths = filteredRepair.paths.filter((path) => completedRepairPaths.has(normalizedPathKey(path)));
				for (const path of recoveredPaths) {
					const warningPrefix = `FILE block \"${path}\" was not closed before end of stream`;
					for (let index = warnings.length - 1; index >= 0; index -= 1) {
						if (warnings[index].startsWith(warningPrefix)) warnings.splice(index, 1);
					}
				}
				const recoveredKeys = new Set(recoveredPaths.map(normalizedPathKey));
				unrecoveredTruncatedPaths = unrecoveredTruncatedPaths.filter((path) => !recoveredKeys.has(normalizedPathKey(path)));
			} catch (err) {
				warnings.push(`Truncated FILE repair failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		// Keep a valid source page as a fallback when the model omits that FILE block.
		if (!pages.includes(sourcePagePath)) {
			throwIfAborted(signal);
			const fallback = normalizeGeneratedPage(sourcePagePath, [
				"---", "type: source", `title: ${JSON.stringify(`Source: ${sourceIdentity}`)}`, "tags: []", "related: []",
				`sources: [${JSON.stringify(sourceIdentity)}]`, `source_ids: [${JSON.stringify(entry.id)}]`, "---", `# Source: ${sourceIdentity}`, "", analysis || "(Analysis not available)",
			].join("\n"), entry, sourceIdentity);
			try {
				const abs = join(l2DataDir, sourcePagePath);
				ensureDir(dirname(abs));
				writeText(abs, fallback);
				created.push(sourcePagePath);
				pages.push(sourcePagePath);
			} catch (err) {
				const message = `Failed to write fallback source summary \"${sourcePagePath}\": ${err instanceof Error ? err.message : String(err)}`;
				warnings.push(message);
			}
		}

		let reviews = 0;
		if (hardFailures.length === 0 && unrecoveredTruncatedPaths.length === 0) {
			throwIfAborted(signal);
			const reviewItems = parseGeneratedReviewBlocks(reviewText, entry);
			try {
				replaceSourceReviews(l2DataDir, entry, reviewItems);
				reviews = reviewItems.length;
			} catch (err) {
				warnings.push(`Review persistence failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		return {
			created: unique(created),
			updated: unique(updated),
			pages: unique(pages),
			aggregateWrites: unique(aggregateWrites),
			reviews,
			warnings,
			hardFailures: unique(hardFailures),
			unrecoveredTruncatedPaths: unique(unrecoveredTruncatedPaths),
		};
	} catch (err) {
		logger.warn({ err, source: basename(entry.rawPath) }, "rich wiki generation failed; archive remains retryable");
		throw err instanceof Error ? err : new Error(String(err));
	}
}
