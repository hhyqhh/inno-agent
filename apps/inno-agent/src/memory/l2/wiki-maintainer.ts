import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { wikiPathJoin } from "./wiki-paths.js";
import { parse as parseYaml, Document as YamlDocument } from "yaml";
import { ensureDir, writeText, readText, appendText, fileExists } from "../../storage/file-store.js";
import type {
	WikiPageFrontmatter,
	WikiPageType,
	WikiPageStatus,
	ConfidenceLevel,
	ManifestEntry,
	WikiPrerequisite,
} from "./types.js";
import { logger } from "../../logger.js";

const L2_SCHEMA_VERSION = "1.0";

const TYPE_SECTION_MAP: Record<WikiPageType, string> = {
	"source-summary": "## 资料摘要 (Sources)",
	entity: "## 实体 (Entities)",
	concept: "## 概念 (Concepts)",
	analysis: "## 分析 (Analysis)",
};

const TYPE_DIR_MAP: Record<WikiPageType, string> = {
	"source-summary": "sources",
	entity: "entities",
	concept: "concepts",
	analysis: "analysis",
};

// ============================================================================
// Frontmatter serialization — backed by the `yaml` library
// ============================================================================

/**
 * Serialize wiki frontmatter to a `---`-delimited YAML block. Keys are emitted
 * in the historical on-disk order and `tags` is kept as an inline flow sequence
 * so pages touched by an update produce minimal diffs.
 */
export function serializeFrontmatter(fm: WikiPageFrontmatter): string {
	const obj: Record<string, unknown> = {
		title: fm.title,
		created: fm.created || fm.updated,
		type: fm.type,
		tags: fm.tags,
		sources: fm.sources,
		source_ids: fm.source_ids,
		updated: fm.updated,
		status: fm.status,
		confidence: fm.confidence,
	};
	if (fm.contested !== undefined) obj.contested = fm.contested;
	if (fm.contradictions && fm.contradictions.length > 0) obj.contradictions = fm.contradictions;
	if (fm.concept_id) obj.concept_id = fm.concept_id;
	if (fm.prerequisites && fm.prerequisites.length > 0) obj.prerequisites = fm.prerequisites;
	if (fm.evidence_refs !== undefined) obj.evidence_refs = fm.evidence_refs;

	const doc = new YamlDocument(obj);
	const tagsNode = doc.get("tags", true) as { flow?: boolean } | undefined;
	if (tagsNode && typeof tagsNode === "object") tagsNode.flow = true;

	// The yaml lib pads flow collections (`[ a, b ]`); strip the inner padding
	// to match the legacy `[a, b]` format and minimize diffs.
	const yamlBody = doc.toString({ lineWidth: 0 }).replace(/^tags: \[ (.*) \]$/m, "tags: [$1]");
	return `---\n${yamlBody}---`;
}

export function parseFrontmatter(content: string): { frontmatter: WikiPageFrontmatter | null; body: string } {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?([\s\S]*)$/);
	if (!match) return { frontmatter: null, body: content };

	const body = match[2];
	let raw: Record<string, unknown>;
	try {
		const parsed = parseYaml(match[1]) as unknown;
		raw = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
	} catch (err) {
		logger.warn({ err }, "failed to parse wiki frontmatter YAML");
		raw = {};
	}

	const asString = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
	const asStringArray = (v: unknown): string[] =>
		Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
	const contestedRaw = raw.contested;
	const contested =
		contestedRaw === true || contestedRaw === "true"
			? true
			: contestedRaw === false || contestedRaw === "false"
				? false
				: undefined;
	const prerequisites: WikiPrerequisite[] = Array.isArray(raw.prerequisites)
		? raw.prerequisites.flatMap((value) => {
			if (!value || typeof value !== "object" || Array.isArray(value)) return [];
			const item = value as Record<string, unknown>;
			const conceptId = asString(item.concept_id).trim();
			if (!conceptId) return [];
			const relation = item.relation === "supporting" ? "supporting" as const : "required" as const;
			const source: WikiPrerequisite["source"] = item.source === "curated"
				|| item.source === "teacher"
				|| item.source === "model_inferred"
				? item.source
				: "imported" as const;
			const numberOrUndefined = (candidate: unknown): number | undefined =>
				typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
			return [{
				concept_id: conceptId,
				relation,
				required_level: numberOrUndefined(item.required_level),
				importance: numberOrUndefined(item.importance),
				source,
				source_confidence: numberOrUndefined(item.source_confidence),
				rationale: asString(item.rationale) || undefined,
				scope: asString(item.scope) || undefined,
			}];
		})
		: [];
	const frontmatter: WikiPageFrontmatter = {
		title: asString(raw.title),
		created: asString(raw.created) || asString(raw.updated),
		type: (raw.type as WikiPageType) ?? "source-summary",
		tags: asStringArray(raw.tags),
		sources: asStringArray(raw.sources),
		source_ids: asStringArray(raw.source_ids),
		updated: asString(raw.updated),
		status: (raw.status as WikiPageStatus) ?? "draft",
		confidence: (raw.confidence as ConfidenceLevel) ?? "medium",
		contested,
		contradictions: asStringArray(raw.contradictions),
	};
	const conceptId = asString(raw.concept_id).trim();
	if (conceptId) frontmatter.concept_id = conceptId;
	if (prerequisites.length > 0) frontmatter.prerequisites = prerequisites;
	if (Array.isArray(raw.evidence_refs)) frontmatter.evidence_refs = raw.evidence_refs;

	return { frontmatter, body };
}

export function bodyRevision(body: string): string {
	const normalized = body.replace(/\r\n?/g, "\n");
	return `sha256:${createHash("sha256").update(normalized, "utf8").digest("hex")}`;
}

export function fileRevision(bytes: Uint8Array): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function defaultSchemaContent(): string {
	const today = new Date().toISOString().slice(0, 10);
	return `# L2 Wiki Schema

> System-managed schema for Inno Agent L2 memory. Created automatically; users do not need to initialize it.
> Schema version: ${L2_SCHEMA_VERSION}
> Last updated: ${today}

## Domain

L2 stores learning content: source summaries, entities, concepts, and durable analysis. It does not store learner ability judgments, goals, preferences, or misconceptions; those belong to L1.

## Directory Layout

- \`raw/\`: immutable original sources.
- \`extracted/\`: faithful extracted Markdown evidence.
- \`wiki/sources/\`: one source-summary page per archived source.
- \`wiki/entities/\`: people, organizations, products, projects, papers, standards, and concrete named artifacts.
- \`wiki/concepts/\`: technical concepts, theories, methods, mechanisms, patterns, and problem types.
- \`wiki/analysis/\`: durable synthesis, comparisons, research conclusions, and learning routes.

## Frontmatter

Every wiki page must include:

\`\`\`yaml
---
title: Page Title
created: YYYY-MM-DD
updated: YYYY-MM-DD
type: source-summary | entity | concept | analysis
tags: [learning-content]
sources:
  - raw/uploads/source.txt
source_ids:
  - l2src_xxxxxxxx
status: draft | reviewed | outdated
confidence: high | medium | low
contested: false
contradictions: []
---
\`\`\`

Concept pages may additionally declare a stable concept id and directional teaching dependencies:

\`\`\`yaml
concept_id: physics.inclined_plane_acceleration
prerequisites:
  - concept_id: physics.force_decomposition
    relation: required
    required_level: 0.65
    importance: 0.9
    source: teacher
    source_confidence: 0.9
    rationale: The learner must resolve forces along the incline.
    scope: high-school-physics-standard-problem
\`\`\`

An ordinary \`[[wikilink]]\` means only that two pages are related. It must not be treated as a prerequisite unless the directional relationship is declared above.

## Maintenance Rules

- Raw files are immutable after ingestion.
- Read existing schema, index, and recent log before adding new pages.
- Prefer updating existing entity/concept pages over creating duplicates.
- Use \`[[wikilinks]]\` for cross-references.
- When a page is updated, bump \`updated\`.
- Every archive action rebuilds \`wiki/index.md\` and appends \`wiki/log.md\`.
- If new information conflicts with existing content, keep both claims with sources, lower confidence when needed, and set \`contested: true\`.
- Pages over roughly 200 lines should be split into narrower pages when practical.

## Tag Taxonomy

- learning-content
- source-summary
- entity
- concept
- analysis
- conversation
- upload
- research
- web
- agent-inferred
- draft
- reviewed
- contested

## Page Thresholds

- Create a page when an entity or concept is central to one archived source or appears across multiple sources.
- Update an existing page when a new source mentions something already covered.
- Do not create pages for passing mentions, one-off wording, or private learner-state facts.
`;
}

function initialIndexContent(): string {
	const today = new Date().toISOString().slice(0, 10);
	return [
		"# L2 Wiki 索引",
		"",
		"> Content catalog. Every wiki page is listed under its type with a one-line summary.",
		"> Read this first before L2 maintenance to avoid duplicate pages.",
		`> Last updated: ${today} | Total pages: 0`,
		"",
		"## 资料摘要 (Sources)",
		"<!-- none yet -->",
		"",
		"## 实体 (Entities)",
		"<!-- none yet -->",
		"",
		"## 概念 (Concepts)",
		"<!-- none yet -->",
		"",
		"## 分析 (Analysis)",
		"<!-- none yet -->",
		"",
	].join("\n");
}

function initialLogContent(): string {
	const today = new Date().toISOString().slice(0, 10);
	return [
		"# L2 Wiki Log",
		"",
		"> Chronological record of L2 wiki maintenance actions. Append-only.",
		"> Format: `## [YYYY-MM-DD] action | subject`.",
		"",
		`## [${today}] create | L2 Wiki initialized`,
		"- System default initialization completed automatically.",
		"",
	].join("\n");
}

export function ensureSchema(l2DataDir: string): void {
	const schemaPath = join(l2DataDir, "wiki", "SCHEMA.md");
	if (!fileExists(schemaPath)) {
		writeText(schemaPath, defaultSchemaContent());
	}
}

export function ensureNavigationFiles(l2DataDir: string): void {
	const wikiDir = join(l2DataDir, "wiki");
	ensureDir(wikiDir);
	ensureSchema(l2DataDir);
	const indexPath = join(wikiDir, "index.md");
	if (!fileExists(indexPath)) writeText(indexPath, initialIndexContent());
	const logPath = join(wikiDir, "log.md");
	if (!fileExists(logPath)) writeText(logPath, initialLogContent());
}

export function readMaintenanceContext(l2DataDir: string): { schema: string; index: string; recentLog: string } {
	ensureNavigationFiles(l2DataDir);
	const schema = readText(join(l2DataDir, "wiki", "SCHEMA.md"));
	const index = readText(join(l2DataDir, "wiki", "index.md"));
	const log = readText(join(l2DataDir, "wiki", "log.md"));
	const recentLog = log.split("\n").slice(-80).join("\n");
	return { schema, index, recentLog };
}

// ============================================================================
// Source summary page
// ============================================================================

function sourcePageFilename(title: string, id: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 50);
	return `${slug}-${id.slice(-6)}.md`;
}

export function sourcePagePath(entry: ManifestEntry): string {
	return wikiPathJoin("wiki", "sources", sourcePageFilename(entry.title, entry.id));
}

function sourcePageContent(
	entry: ManifestEntry,
	summaryBody: string,
	extractedPath?: string,
	created = new Date().toISOString().slice(0, 10),
): string {
	const fm: WikiPageFrontmatter = {
		title: entry.title,
		created,
		type: "source-summary",
		tags: mergeUniqueTags(["source-summary"], entry.tags),
		sources: [entry.rawPath],
		source_ids: [entry.id],
		updated: new Date().toISOString().slice(0, 10),
		status: "draft",
		confidence: "medium",
	};
	const ref = extractedPath ? `\n## 来源\n\n完整提取文本: \`${extractedPath}\`\n` : "";
	const body = `\n# ${entry.title}\n\n${summaryBody}\n${ref}`;
	return serializeFrontmatter(fm) + body;
}

/**
 * Create a wiki source summary page.
 * @param summaryBody - LLM-generated summary markdown (or full content as fallback)
 * @param extractedPath - relative path to the full extracted file, for reference
 * Returns the relative path from l2DataDir.
 */
export function createSourcePage(
	l2DataDir: string,
	entry: ManifestEntry,
	summaryBody: string,
	extractedPath?: string,
): string {
	const dir = join(l2DataDir, "wiki", "sources");
	ensureDir(dir);
	const relativePath = sourcePagePath(entry);
	const absolutePath = join(l2DataDir, relativePath);
	if (!fileExists(absolutePath)) {
		writeText(absolutePath, sourcePageContent(entry, summaryBody, extractedPath));
	} else {
		const existing = parseFrontmatter(readText(absolutePath)).frontmatter;
		if (!existing?.source_ids.includes(entry.id)) {
			throw new Error(`Source summary path is owned by another source: ${relativePath}`);
		}
	}
	return relativePath;
}

export function sourcePageHasExpectedContent(
	l2DataDir: string,
	entry: ManifestEntry,
	summaryBody: string,
	extractedPath?: string,
): boolean {
	const absolutePath = join(l2DataDir, sourcePagePath(entry));
	if (!fileExists(absolutePath)) return false;
	const current = readText(absolutePath);
	const created = parseFrontmatter(current).frontmatter?.created;
	return current === sourcePageContent(entry, summaryBody, extractedPath, created);
}

export function replaceSourcePageIfRevision(
	l2DataDir: string,
	entry: ManifestEntry,
	summaryBody: string,
	expectedFileRevision: string,
	extractedPath?: string,
): boolean {
	const absolutePath = join(l2DataDir, sourcePagePath(entry));
	if (!fileExists(absolutePath)) return false;
	const current = readText(absolutePath);
	if (fileRevision(Buffer.from(current, "utf8")) !== expectedFileRevision) return false;
	const created = parseFrontmatter(current).frontmatter?.created;
	writeText(absolutePath, sourcePageContent(entry, summaryBody, extractedPath, created));
	return true;
}

// ============================================================================
// Index maintenance
// ============================================================================

function readWikiPageIndexItem(
	l2DataDir: string,
	fallbackTitle: string,
	wikiPath: string,
): { type: WikiPageType; title: string; path: string } {
	const fullPath = join(l2DataDir, wikiPath);
	const content = fileExists(fullPath) ? readText(fullPath) : "";
	const { frontmatter } = parseFrontmatter(content);
	if (frontmatter) {
		return { type: frontmatter.type, title: frontmatter.title || fallbackTitle, path: wikiPath };
	}
	if (wikiPath.includes("wiki/entities/")) return { type: "entity", title: fallbackTitle, path: wikiPath };
	if (wikiPath.includes("wiki/concepts/")) return { type: "concept", title: fallbackTitle, path: wikiPath };
	if (wikiPath.includes("wiki/analysis/")) return { type: "analysis", title: fallbackTitle, path: wikiPath };
	return { type: "source-summary", title: fallbackTitle, path: wikiPath };
}

/**
 * Rebuild wiki/index.md from all manifest entries, grouped by page frontmatter type.
 */
export function rebuildIndex(l2DataDir: string, entries: ManifestEntry[]): void {
	ensureDir(join(l2DataDir, "wiki"));
	ensureSchema(l2DataDir);
	const allPages = listWikiPagesForIndex(l2DataDir, entries);
	const totalPages = allPages.length;
	const lines: string[] = [
		"# L2 Wiki 索引",
		"",
		"> Content catalog. Every wiki page is listed under its type with a one-line summary.",
		"> Read this first before L2 maintenance to avoid duplicate pages.",
		`> Last updated: ${new Date().toISOString().slice(0, 10)} | Total pages: ${totalPages}`,
		"",
	];

	const groups: Record<WikiPageType, { title: string; path: string }[]> = {
		"source-summary": [],
		entity: [],
		concept: [],
		analysis: [],
	};

	for (const item of allPages) {
		if (groups[item.type].some((existing) => existing.path === item.path)) continue;
		groups[item.type].push({ title: item.title, path: item.path });
	}

	for (const type of ["source-summary", "entity", "concept", "analysis"] as WikiPageType[]) {
		lines.push(TYPE_SECTION_MAP[type]);
		if (groups[type].length > 0) {
			groups[type].sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
			for (const item of groups[type]) {
				lines.push(`- [[${item.title}]] — \`${item.path}\``);
			}
		} else {
			lines.push("<!-- none yet -->");
		}
		lines.push("");
	}

	writeText(join(l2DataDir, "wiki", "index.md"), lines.join("\n"));
}

// ============================================================================
// Log maintenance
// ============================================================================

/**
 * Append an entry to wiki/log.md.
 */
export function appendLog(l2DataDir: string, action: string, title: string, details?: string): void {
	const logPath = join(l2DataDir, "wiki", "log.md");
	ensureDir(join(l2DataDir, "wiki"));
	if (!fileExists(logPath)) {
		writeText(logPath, initialLogContent());
	}
	const today = new Date().toISOString().slice(0, 10);
	let entry = `\n## [${today}] ${action} | ${title}\n`;
	if (details) entry += `${details.trim()}\n`;
	appendText(logPath, entry);
}

// ============================================================================
// Directory initialization
// ============================================================================

/**
 * Ensure all L2 data directories exist.
 */
export function ensureL2Directories(l2DataDir: string): void {
	const dirs = [
		"raw/uploads",
		"raw/web",
		"raw/conversations",
		"raw/research",
		"extracted",
		"extracted/evidence/by-id",
		"wiki/sources",
		"wiki/entities",
		"wiki/concepts",
		"wiki/analysis",
	];
	for (const dir of dirs) {
		ensureDir(join(l2DataDir, dir));
	}
	ensureNavigationFiles(l2DataDir);
}

function mergeUniqueTags(...tagGroups: string[][]): string[] {
	const seen = new Set<string>();
	const tags: string[] = [];
	for (const group of tagGroups) {
		for (const tag of group) {
			const trimmed = tag.trim();
			if (!trimmed || seen.has(trimmed)) continue;
			seen.add(trimmed);
			tags.push(trimmed);
		}
	}
	return tags;
}

function listWikiPagesForIndex(
	l2DataDir: string,
	entries: ManifestEntry[],
): { type: WikiPageType; title: string; path: string }[] {
	const items: { type: WikiPageType; title: string; path: string }[] = [];
	const fallbackTitleByPath = new Map<string, string>();
	for (const entry of entries) {
		for (const wikiPath of entry.wikiPages) {
			fallbackTitleByPath.set(wikiPath, entry.title);
		}
	}
	for (const type of ["source-summary", "entity", "concept", "analysis"] as WikiPageType[]) {
		const dir = join(l2DataDir, "wiki", TYPE_DIR_MAP[type]);
		if (!fileExists(dir)) continue;
		const files = readDirectoryMdFiles(dir);
		for (const file of files) {
			const wikiPath = wikiPathJoin("wiki", TYPE_DIR_MAP[type], file);
			items.push(readWikiPageIndexItem(l2DataDir, fallbackTitleByPath.get(wikiPath) ?? file.replace(/\.md$/, ""), wikiPath));
		}
	}
	return items;
}

function readDirectoryMdFiles(dir: string): string[] {
	try {
		return readdirSync(dir).filter((file) => file.endsWith(".md"));
	} catch (err) {
		logger.warn({ err, dir }, "failed to read wiki directory");
		return [];
	}
}
