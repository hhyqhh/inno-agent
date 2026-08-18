import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { wikiPathJoin } from "./wiki-paths.js";

import { complete } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import { ensureDir, readText, writeText } from "../../storage/file-store.js";
import type { ManifestEntry, WikiPageType, WikiPageFrontmatter } from "./types.js";
import { parseFrontmatter, serializeFrontmatter } from "./wiki-maintainer.js";
import { splitStructuralChunks } from "./structural-chunker.js";
import { buildAliasIndex, normalizeWikiLink } from "./wiki-links.js";
import { logger } from "../../logger.js";
import { resolveContainedPath } from "../../utils/path-safety.js";

type LinkablePageType = Extract<WikiPageType, "entity" | "concept">;

interface LinkedItem {
	title: string;
	type: LinkablePageType;
	description: string;
	tags: string[];
}

export interface WikiLinkMaintenanceResult {
	created: string[];
	updated: string[];
	unchanged: string[];
	/** Pages where a contradiction with the new source was recorded. */
	contested: string[];
	pages: string[];
	/** Source summary after unresolved wikilinks have been downgraded to text. */
	sourcePageBody: string;
}

const LINK_MAINTAIN_PROMPT = `你是一个学习 Wiki 知识库维护助手。

请从下面的资料摘要中抽取值得长期维护的实体和概念，并分类。

分类规则：
- entity: 人物、组织、公司、项目、产品、论文、标准、框架/库的具体名称。
- concept: 技术概念、理论、方法、能力、机制、模式、问题类型。
- 不要抽取过泛的词，例如"方法"、"系统"、"内容"。
- 优先使用资料中已有的 [[双链]] 条目。
- tags 只写 0-3 个属于该条目本身的主题标签，不要复制整篇资料的标签。
- 最多返回 20 个条目。

资料标题：{title}

资料摘要：
---
{content}
---

只返回 JSON，不要代码块：
{"items":[{"title":"条目名","type":"concept","description":"一句话定义或说明","tags":["主题标签"]}]}`;

const MAX_LINK_PROMPT_LENGTH = 30000;
const MAX_LINK_MODEL_CHUNKS = 12;
const MAX_LINKED_ITEMS = 20;
const MAX_RELATED_ITEMS = 5;
const MAX_ITEM_TAGS = 3;
const MAX_EXISTING_PAGE_TITLES = 200;

function slugifyTitle(title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 60);
	if (slug) return slug;
	return createHash("sha256").update(title).digest("hex").slice(0, 12);
}

function cleanTitle(title: string): string {
	return title
		.split("|")[0]
		.trim()
		.replace(/^#+\s*/, "")
		.replace(/\s+/g, " ");
}

function cleanTag(tag: string): string {
	return tag.trim().replace(/^#+/, "").replace(/\s+/g, "-").slice(0, 40);
}

function extractWikiLinks(content: string): string[] {
	const seen = new Set<string>();
	const titles: string[] = [];
	const linkPattern = /\[\[([^\]]+)\]\]/g;
	let match: RegExpExecArray | null;
	while ((match = linkPattern.exec(content)) !== null) {
		const title = cleanTitle(match[1]);
		if (!isUsefulTitle(title) || seen.has(title)) continue;
		seen.add(title);
		titles.push(title);
	}
	return titles;
}

function isUsefulTitle(title: string): boolean {
	if (title.length < 2 || title.length > 80) return false;
	if (/^https?:\/\//i.test(title)) return false;
	if (/[\\/*?:"<>|]/.test(title)) return false;
	return true;
}

function looksLikeEntity(title: string): boolean {
	if (/\b(et al\.?|Inc\.?|Corp\.?|Ltd\.?|LLC)\b/i.test(title)) return true;
	if (/\b(IEEE|ACM|ISO)\b/.test(title)) return true;
	if (/[A-Za-z]+\s+\d{4}/.test(title)) return true;
	return false;
}

function fallbackItems(content: string): LinkedItem[] {
	return extractWikiLinks(content).slice(0, MAX_LINKED_ITEMS).map((title) => ({
		title,
		type: looksLikeEntity(title) ? "entity" : "concept",
		description: "由 L2 自动从资料摘要中的双链识别，待进一步完善。",
		tags: [],
	}));
}

/**
 * The source summary is the authority for which wikilinks must become pages.
 * LLM extraction may improve their types/descriptions, but it cannot silently
 * omit a link that is already present in the persisted summary.
 */
function reconcileSummaryItems(summary: string, extracted: LinkedItem[]): LinkedItem[] {
	const explicitTitles = extractWikiLinks(summary).slice(0, MAX_LINKED_ITEMS);
	if (explicitTitles.length === 0) return extracted.slice(0, MAX_LINKED_ITEMS);

	const extractedByTitle = new Map(extracted.map((item) => [normalizeWikiLink(item.title), item]));
	return explicitTitles.map((title) => {
		const item = extractedByTitle.get(normalizeWikiLink(title));
		return item
			? { ...item, title }
			: {
					title,
					type: looksLikeEntity(title) ? "entity" : "concept",
					description: "由 L2 自动从资料摘要中的双链识别，待进一步完善。",
					tags: [],
				};
	});
}

function parseLinkedItemsJson(text: string): LinkedItem[] {
	const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start < 0 || end < start) return [];
	const parsed = JSON.parse(trimmed.slice(start, end + 1)) as { items?: unknown };
	if (!Array.isArray(parsed.items)) return [];

	const items: LinkedItem[] = [];
	const seen = new Set<string>();
	for (const raw of parsed.items) {
		if (!raw || typeof raw !== "object") continue;
		const record = raw as Record<string, unknown>;
		const title = typeof record.title === "string" ? cleanTitle(record.title) : "";
		const type = record.type === "entity" ? "entity" : record.type === "concept" ? "concept" : null;
		if (!title || !type || !isUsefulTitle(title) || seen.has(title)) continue;
		seen.add(title);
		items.push({
			title,
			type,
			description:
				typeof record.description === "string" && record.description.trim()
					? record.description.trim()
					: "由 L2 自动识别，待进一步完善。",
			tags: Array.isArray(record.tags)
				? record.tags
						.filter((value): value is string => typeof value === "string")
						.map(cleanTag)
						.filter(Boolean)
						.slice(0, MAX_ITEM_TAGS)
				: [],
		});
	}
	return items;
}

async function extractLinkedItems(
	model: Model<any> | undefined,
	modelRegistry: ModelRegistry | undefined,
	title: string,
	content: string,
): Promise<LinkedItem[]> {
	const fallback = fallbackItems(content);
	if (!model || !modelRegistry) return fallback;

	const truncated =
		content.length > MAX_LINK_PROMPT_LENGTH
			? content.slice(0, MAX_LINK_PROMPT_LENGTH) + "\n\n...(内容已截断)"
			: content;
	const prompt = LINK_MAINTAIN_PROMPT.replace("{title}", title).replace("{content}", truncated);

	try {
		const auth = await modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) return fallback;
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
		if (response.stopReason === "error") return fallback;
		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		const extracted = parseLinkedItemsJson(text);
		return extracted.length > 0 ? extracted : fallback;
	} catch (err) {
		logger.warn({ err }, "LLM wiki link extraction failed, using fallback");
		return fallback;
	}
}

function linkedItemKey(item: LinkedItem): string {
	return `${item.type}:${cleanTitle(item.title).toLowerCase()}`;
}

async function extractLinkedItemsAcrossChunks(
	model: Model<any> | undefined,
	modelRegistry: ModelRegistry | undefined,
	title: string,
	content: string,
): Promise<LinkedItem[]> {
	if (content.length <= MAX_LINK_PROMPT_LENGTH) {
		return extractLinkedItems(model, modelRegistry, title, content);
	}

	const chunks = splitStructuralChunks(content, { targetChars: 24_000, overlapChars: 400 });
	if (chunks.length > MAX_LINK_MODEL_CHUNKS) return fallbackItems(content);

	const items: LinkedItem[] = [];
	const seen = new Set<string>();
	for (let index = 0; index < chunks.length; index += 1) {
		const chunkItems = await extractLinkedItems(
			model,
			modelRegistry,
			`${title}（第 ${index + 1}/${chunks.length} 部分）`,
			chunks[index],
		);
		for (const item of chunkItems) {
			const key = linkedItemKey(item);
			if (seen.has(key)) continue;
			seen.add(key);
			items.push(item);
			if (items.length >= MAX_LINKED_ITEMS) return items;
		}
	}
	return items;
}

function pageDirForType(type: LinkablePageType): string {
	return type === "entity" ? "entities" : "concepts";
}

function relativePagePath(type: LinkablePageType, filename: string): string {
	return wikiPathJoin("wiki", pageDirForType(type), filename);
}

function findExistingPage(l2DataDir: string, item: LinkedItem): string {
	const dir = join(l2DataDir, "wiki", pageDirForType(item.type));
	const slugPath = relativePagePath(item.type, `${slugifyTitle(item.title)}.md`);
	const slugAbsPath = join(l2DataDir, slugPath);
	if (existsSync(slugAbsPath)) return slugPath;
	if (!existsSync(dir)) return slugPath;

	for (const file of readdirSync(dir)) {
		if (!file.endsWith(".md")) continue;
		const relativePath = relativePagePath(item.type, file);
		const content = readText(join(l2DataDir, relativePath));
		const { frontmatter } = parseFrontmatter(content);
		const title = frontmatter?.title || basename(file, extname(file));
		if (normalizeWikiLink(title) === normalizeWikiLink(item.title)) return relativePath;
	}
	return slugPath;
}

interface WikiPageReference {
	title: string;
	type: LinkablePageType;
	path: string;
}

function readWikiPageReferences(l2DataDir: string): WikiPageReference[] {
	const pages: WikiPageReference[] = [];
	for (const type of ["entity", "concept"] as const) {
		const dir = join(l2DataDir, "wiki", pageDirForType(type));
		if (!existsSync(dir)) continue;
		for (const file of readdirSync(dir)) {
			if (!file.endsWith(".md")) continue;
			const path = relativePagePath(type, file);
			const { frontmatter } = parseFrontmatter(readText(join(l2DataDir, path)));
			pages.push({ title: frontmatter?.title || basename(file, extname(file)), type, path });
		}
	}
	return pages.sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
}

function alignItemsWithExistingPages(items: LinkedItem[], existingPages: WikiPageReference[]): LinkedItem[] {
	const existingByTitle = new Map<string, WikiPageReference | null>();
	for (const page of existingPages) {
		const key = normalizeWikiLink(page.title);
		if (existingByTitle.has(key)) existingByTitle.set(key, null);
		else existingByTitle.set(key, page);
	}
	return items.map((item) => {
		const existing = existingByTitle.get(normalizeWikiLink(item.title));
		return existing ? { ...item, title: existing.title, type: existing.type } : item;
	});
}

function readAllWikiPageAliases(l2DataDir: string): { title: string; path: string }[] {
	const pages: { title: string; path: string }[] = [];
	for (const dirName of ["sources", "entities", "concepts", "analysis"] as const) {
		const dir = join(l2DataDir, "wiki", dirName);
		if (!existsSync(dir)) continue;
		for (const file of readdirSync(dir)) {
			if (!file.endsWith(".md")) continue;
			const path = wikiPathJoin("wiki", dirName, file);
			const { frontmatter } = parseFrontmatter(readText(join(l2DataDir, path)));
			pages.push({ title: frontmatter?.title || basename(file, extname(file)), path });
		}
	}
	return pages;
}

function downgradeUnresolvedWikilinks(l2DataDir: string, body: string): string {
	const alias = buildAliasIndex(readAllWikiPageAliases(l2DataDir));
	return body.replace(/\[\[([^\]]+)\]\]/g, (full, inner: string) => {
		const [target, display] = inner.split("|", 2).map((part) => part.trim());
		return alias.resolve(target) ? full : display || target;
	});
}

function mergeTags(...tagGroups: string[][]): string[] {
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
	return tags.slice(0, 12);
}

function relatedSection(relatedTitles: string[]): string {
	if (relatedTitles.length === 0) return "";
	return `\n## 相关概念\n\n${relatedTitles.map((title) => `- [[${title}]]`).join("\n")}\n`;
}

function buildNewPage(
	item: LinkedItem,
	entry: ManifestEntry,
	sourcePagePath: string,
	relatedTitles: string[] = [],
): string {
	const today = new Date().toISOString().slice(0, 10);
	const frontmatter = serializeFrontmatter({
		title: item.title,
		created: today,
		type: item.type,
		tags: mergeTags([item.type], item.tags),
		sources: [sourcePagePath],
		source_ids: [entry.id],
		updated: today,
		status: "draft",
		confidence: "medium",
	});
	return `${frontmatter}
# ${item.title}

## 定义

${item.description}
${relatedSection(relatedTitles)}

## 相关资料

- [[${entry.title}]] — \`${sourcePagePath}\`
`;
}

function addRelatedLinks(content: string, relatedTitles: string[]): string | null {
	const missing = relatedTitles.filter((title) => !content.includes(`[[${title}]]`));
	if (missing.length === 0) return null;
	const bullets = missing.map((title) => `- [[${title}]]`).join("\n");
	const header = "\n## 相关概念";
	const sectionStart = content.indexOf(header);
	if (sectionStart >= 0) {
		const bodyStart = sectionStart + header.length;
		const nextSection = content.slice(bodyStart).search(/\n## /);
		const insertAt = nextSection >= 0 ? bodyStart + nextSection : content.length;
		return `${content.slice(0, insertAt).trimEnd()}\n${bullets}${content.slice(insertAt)}`;
	}
	const sourceSection = content.indexOf("\n## 相关资料");
	if (sourceSection >= 0) {
		return `${content.slice(0, sourceSection).trimEnd()}\n\n## 相关概念\n\n${bullets}\n${content.slice(sourceSection)}`;
	}
	return `${content.trimEnd()}\n\n## 相关概念\n\n${bullets}\n`;
}

function referenceBullet(entry: Pick<ManifestEntry, "title">, sourcePagePath: string): string {
	return `- [[${entry.title}]] — \`${sourcePagePath}\``;
}

function refreshReferenceBullet(
	content: string,
	entry: Pick<ManifestEntry, "title">,
	sourcePagePath: string,
): { content: string; found: boolean; changed: boolean } {
	const marker = `\`${sourcePagePath}\``;
	const expected = referenceBullet(entry, sourcePagePath);
	let found = false;
	let changed = false;
	const lines = content.split("\n").flatMap((line) => {
		if (!line.trimStart().startsWith("- ") || !line.includes(marker)) return [line];
		if (found) {
			changed = true;
			return [];
		}
		found = true;
		if (line !== expected) changed = true;
		return [expected];
	});
	return { content: lines.join("\n"), found, changed };
}

/**
 * Parse a page's frontmatter, let `fn` mutate it, then re-serialize. Returns
 * the original content unchanged (changed=false) when the page has no
 * frontmatter or when the mutation produces no logical difference.
 */
function mutateFrontmatter(
	content: string,
	fn: (fm: WikiPageFrontmatter) => void,
): { content: string; changed: boolean } {
	const { frontmatter, body } = parseFrontmatter(content);
	if (!frontmatter) return { content, changed: false };
	const before = serializeFrontmatter(frontmatter);
	fn(frontmatter);
	const after = serializeFrontmatter(frontmatter);
	if (after === before) return { content, changed: false };
	return { content: `${after}\n${body}`, changed: true };
}

function updateFrontmatterReference(content: string, entry: ManifestEntry, sourcePagePath: string): {
	content: string;
	changed: boolean;
} {
	const today = new Date().toISOString().slice(0, 10);
	return mutateFrontmatter(content, (fm) => {
		if (!fm.sources.includes(sourcePagePath)) fm.sources.push(sourcePagePath);
		if (!fm.source_ids.includes(entry.id)) fm.source_ids.push(entry.id);
		if (!fm.created) fm.created = fm.updated || today;
		fm.updated = today;
	});
}

function addReferenceIfMissing(content: string, entry: ManifestEntry, sourcePagePath: string): string | null {
	const metadataUpdate = updateFrontmatterReference(content, entry, sourcePagePath);
	content = metadataUpdate.content;
	let changed = metadataUpdate.changed;

	const refreshed = refreshReferenceBullet(content, entry, sourcePagePath);
	content = refreshed.content;
	changed ||= refreshed.changed;
	if (refreshed.found) return changed ? content : null;

	const bullet = referenceBullet(entry, sourcePagePath);
	const sectionHeader = "\n## 相关资料";
	const sectionStart = content.indexOf(sectionHeader);
	if (sectionStart >= 0) {
		const bodyStart = sectionStart + sectionHeader.length;
		const nextSection = content.slice(bodyStart).search(/\n## /);
		const insertAt = nextSection >= 0 ? bodyStart + nextSection : content.length;
		const before = content.slice(0, insertAt).trimEnd();
		const after = content.slice(insertAt);
		return `${before}\n${bullet}${after}`;
	}
	return `${content.trimEnd()}\n\n## 相关资料\n\n${bullet}\n`;
}

export interface ReconcileLinkedWikiSourceResult {
	status: "unchanged" | "updated";
	path: string;
	exists: boolean;
}

/**
 * Reconcile one source's provenance after re-archiving it. The helper only
 * touches generated entity/concept pages and is idempotent so an interrupted
 * archive can safely retry the cleanup.
 */
export function reconcileLinkedWikiSource(
	l2DataDir: string,
	wikiPath: string,
	options: {
		sourceId: string;
		previousSourcePagePaths: string[];
		currentSourcePagePath?: string;
		currentTitle: string;
		keepSource: boolean;
	},
): ReconcileLinkedWikiSourceResult {
	const normalizedPath = wikiPath.replace(/\\/g, "/");
	if (!normalizedPath.startsWith("wiki/entities/") && !normalizedPath.startsWith("wiki/concepts/")) {
		return { status: "unchanged", path: normalizedPath, exists: false };
	}
	const absPath = resolveContainedPath(join(l2DataDir, "wiki"), normalizedPath.slice("wiki/".length));
	if (!absPath || !existsSync(absPath)) return { status: "unchanged", path: normalizedPath, exists: false };

	const original = readText(absPath);
	const { frontmatter, body } = parseFrontmatter(original);
	if (!frontmatter) return { status: "unchanged", path: normalizedPath, exists: true };

	const previousPaths = new Set(options.previousSourcePagePaths.map((path) => path.replace(/\\/g, "/")));
	const currentPath = options.currentSourcePagePath?.replace(/\\/g, "/");
	const stalePaths = new Set(
		[...previousPaths].filter((path) => !options.keepSource || path !== currentPath),
	);
	let changed = false;

	const nextSources = frontmatter.sources.filter((path) => !stalePaths.has(path.replace(/\\/g, "/")));
	if (nextSources.length !== frontmatter.sources.length) {
		frontmatter.sources = nextSources;
		changed = true;
	}
	if (options.keepSource && currentPath && !frontmatter.sources.includes(currentPath)) {
		frontmatter.sources.push(currentPath);
		changed = true;
	}

	if (options.keepSource) {
		if (!frontmatter.source_ids.includes(options.sourceId)) {
			frontmatter.source_ids.push(options.sourceId);
			changed = true;
		}
	} else {
		const nextSourceIds = frontmatter.source_ids.filter((id) => id !== options.sourceId);
		if (nextSourceIds.length !== frontmatter.source_ids.length) {
			frontmatter.source_ids = nextSourceIds;
			changed = true;
		}
		const nextContradictions = (frontmatter.contradictions ?? []).filter((id) => id !== options.sourceId);
		if (nextContradictions.length !== (frontmatter.contradictions ?? []).length) {
			frontmatter.contradictions = nextContradictions;
			changed = true;
		}
		if (nextContradictions.length === 0 && frontmatter.contested) {
			frontmatter.contested = false;
			changed = true;
		}
	}

	let nextBody = body;
	const sourceIdMarker = `\`${options.sourceId}\``;
	const filteredLines = nextBody.split("\n").filter((line) => {
		if (!line.trimStart().startsWith("- ")) return true;
		if ([...stalePaths].some((path) => line.includes(`\`${path}\``))) return false;
		if (!options.keepSource && line.includes(sourceIdMarker)) return false;
		return true;
	});
	if (filteredLines.length !== nextBody.split("\n").length) {
		nextBody = filteredLines.join("\n");
		changed = true;
	}

	if (options.keepSource && currentPath) {
		const entry = { title: options.currentTitle };
		const refreshed = refreshReferenceBullet(nextBody, entry, currentPath);
		nextBody = refreshed.content;
		changed ||= refreshed.changed;
		const refreshedContradictions = nextBody.split("\n").map((line) => {
			if (!line.trimStart().startsWith("- ") || !line.includes(sourceIdMarker)) return line;
			return line.replace(/（来源 \[\[[^\]]+\]\] /, `（来源 [[${options.currentTitle}]] `);
		});
		const refreshedBody = refreshedContradictions.join("\n");
		if (refreshedBody !== nextBody) {
			nextBody = refreshedBody;
			changed = true;
		}
	}

	const hasProvenance = frontmatter.source_ids.length > 0 || frontmatter.sources.length > 0;
	if (!options.keepSource && !hasProvenance && changed) {
		const backupHash = createHash("sha256").update(original).digest("hex").slice(0, 10);
		const orphanDir = join(l2DataDir, "wiki", "orphans");
		ensureDir(orphanDir);
		const backupPath = wikiPathJoin(
			"wiki",
			"orphans",
			`${basename(normalizedPath, ".md")}-${backupHash}.md`,
		);
		writeText(join(l2DataDir, backupPath), original);
		frontmatter.status = "outdated";
		frontmatter.confidence = "low";
		frontmatter.contested = false;
		frontmatter.contradictions = [];
		nextBody = `# ${frontmatter.title}\n\n## 状态\n\n> 原始来源已更新；旧页面内容已备份到 \`${backupPath}\`，请重新确认。\n`;
	}
	if (!changed) return { status: "unchanged", path: normalizedPath, exists: true };
	frontmatter.updated = new Date().toISOString().slice(0, 10);
	writeText(absPath, `${serializeFrontmatter(frontmatter)}\n${nextBody}`);
	return { status: "updated", path: normalizedPath, exists: true };
}

function upsertLinkedPage(
	l2DataDir: string,
	item: LinkedItem,
	entry: ManifestEntry,
	sourcePagePath: string,
): { path: string; status: "created" | "updated" | "unchanged" } {
	const relativePath = findExistingPage(l2DataDir, item);
	const absPath = join(l2DataDir, relativePath);
	ensureDir(join(l2DataDir, "wiki", pageDirForType(item.type)));

	if (!existsSync(absPath)) {
		writeText(absPath, buildNewPage(item, entry, sourcePagePath));
		return { path: relativePath, status: "created" };
	}

	const existing = readText(absPath);
	const updated = addReferenceIfMissing(existing, entry, sourcePagePath);
	if (!updated) return { path: relativePath, status: "unchanged" };
	writeText(absPath, updated);
	return { path: relativePath, status: "updated" };
}

/**
 * Maintain entity/concept pages after a source page is created.
 *
 * The source page keeps the original summary text. This function creates or
 * updates linked entity/concept pages, downgrades only links that cannot be
 * materialized, then returns the page paths and closed summary body.
 *
 * With a model available this runs two-stage CoT: (1) extract candidates and
 * read their existing page definitions, (2) plan create/update with merged
 * definitions and contradiction detection, then write/merge. Without a model
 * the original non-destructive behavior (create-or-append-reference) applies.
 */
export async function maintainLinkedWikiPages(
	l2DataDir: string,
	entry: ManifestEntry,
	sourcePagePath: string,
	sourcePageBody: string,
	model?: Model<any>,
	modelRegistry?: ModelRegistry,
): Promise<WikiLinkMaintenanceResult> {
	const result: WikiLinkMaintenanceResult = {
		created: [],
		updated: [],
		unchanged: [],
		contested: [],
		pages: [],
		sourcePageBody,
	};
	const existingPages = readWikiPageReferences(l2DataDir);
	const extracted = await extractLinkedItemsAcrossChunks(model, modelRegistry, entry.title, sourcePageBody);
	const items = alignItemsWithExistingPages(reconcileSummaryItems(sourcePageBody, extracted), existingPages);

	// Stage 1: read existing definitions for all candidates, build plan.
	const candidates = items.map((it) => ({
		title: it.title,
		type: it.type,
		description: it.description,
		tags: it.tags,
		existingDefinition: readExistingDefinition(l2DataDir, it),
	}));
	const rawPlan = await planLinkedItems(model, modelRegistry, entry.title, sourcePageBody, candidates, existingPages);
	const plan = rawPlan ? reconcilePlanItems(rawPlan, candidates, existingPages) : null;

	if (plan) {
		// Stage 2: write/merge according to plan.
		for (const p of plan) {
			const page = upsertPlannedPage(l2DataDir, p, entry, sourcePagePath);
			result.pages.push(page.path);
			result[page.status].push(page.path);
			if (page.contested) result.contested.push(page.path);
		}
	} else {
		// Fallback: original non-destructive create-or-append-reference.
		for (const item of items) {
			const page = upsertLinkedPage(l2DataDir, item, entry, sourcePagePath);
			result.pages.push(page.path);
			result[page.status].push(page.path);
		}
	}
	result.pages = [...new Set(result.pages)];
	result.sourcePageBody = downgradeUnresolvedWikilinks(l2DataDir, sourcePageBody);
	return result;
}

// ============================================================================
// Two-stage CoT helpers
// ============================================================================

interface PlanItem {
	title: string;
	type: LinkablePageType;
	action: "create" | "update";
	definition: string;
	tags: string[];
	contradiction?: string;
	relatedTitles: string[];
}

const STAGE1_PLAN_PROMPT = `你是学习 Wiki 知识库的维护规划助手。已知一份新资料的摘要，以及知识库中若干实体/概念页面的现有定义。请为每个条目规划如何维护。

规则：
- action=create：知识库尚无此条目（现有定义为空）。definition 写一到三句中文定义。
- action=update：已有此条目。请把新资料的信息与现有定义**融合**，写出更完整、准确、无重复的 definition（融合后的完整定义，而不是仅追加）。
- 若新资料与现有定义存在**事实冲突/矛盾**，将 contradiction 设为一句话冲突说明；否则设为 null。
- definition 聚焦"是什么"，不要写入学习者个人状态、目标或偏好。
- relatedTitles 列出 0-5 个确实相关的页面标题，只能从候选条目或“现有知识页”中选择。
- 优先连接同一机制的上下位概念、组成关系、依赖关系，以及新资料与现有 Wiki 的明确联系；不要仅因标签相似而连接。
- 最多处理 20 个条目。

资料标题：{title}

资料摘要：
---
{summary}
---

候选条目（existingDefinition 为空表示知识库暂无该条目）：
{candidates}

现有知识页（可用于 relatedTitles）：
{existingPages}

只返回 JSON，不要代码块：
{"items":[{"title":"条目名","type":"concept","action":"update","definition":"融合后的完整定义","contradiction":null,"relatedTitles":["相关页面"]}]}`;

function parsePlanItems(text: string): PlanItem[] {
	const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start < 0 || end < start) return [];
	let parsed: { items?: unknown };
	try {
		parsed = JSON.parse(trimmed.slice(start, end + 1)) as { items?: unknown };
	} catch {
		return [];
	}
	if (!Array.isArray(parsed.items)) return [];
	const planItems: PlanItem[] = [];
	const seen = new Set<string>();
	for (const raw of parsed.items) {
		if (!raw || typeof raw !== "object") continue;
		const rec = raw as Record<string, unknown>;
		const title = typeof rec.title === "string" ? cleanTitle(rec.title) : "";
		const type = rec.type === "entity" ? "entity" : rec.type === "concept" ? "concept" : null;
		if (!title || !type || !isUsefulTitle(title) || seen.has(title)) continue;
		const definition = typeof rec.definition === "string" ? rec.definition.trim() : "";
		if (!definition) continue;
		seen.add(title);
		planItems.push({
			title,
			type,
			action: rec.action === "update" ? "update" : "create",
			definition,
			tags: [],
			contradiction:
				typeof rec.contradiction === "string" && rec.contradiction.trim() ? rec.contradiction.trim() : undefined,
			relatedTitles: Array.isArray(rec.relatedTitles)
				? rec.relatedTitles
						.filter((value): value is string => typeof value === "string")
						.map(cleanTitle)
						.filter(isUsefulTitle)
						.slice(0, MAX_RELATED_ITEMS)
				: [],
		});
	}
	return planItems;
}

interface PlanCandidate {
	title: string;
	type: LinkablePageType;
	description: string;
	tags: string[];
	existingDefinition?: string;
}

function reconcilePlanItems(
	plan: PlanItem[],
	candidates: PlanCandidate[],
	existingPages: WikiPageReference[],
): PlanItem[] {
	const planByTitle = new Map(plan.map((item) => [normalizeWikiLink(item.title), item]));
	const allowed = new Map<string, string | null>();
	for (const page of existingPages) {
		const key = normalizeWikiLink(page.title);
		if (allowed.has(key)) allowed.set(key, null);
		else if (!allowed.has(key)) allowed.set(key, page.title);
	}
	for (const candidate of candidates) allowed.set(normalizeWikiLink(candidate.title), candidate.title);

	return candidates.map((candidate) => {
		const proposed = planByTitle.get(normalizeWikiLink(candidate.title));
		const relatedTitles: string[] = [];
		for (const title of proposed?.relatedTitles ?? []) {
			const canonical = allowed.get(normalizeWikiLink(title));
			if (!canonical || normalizeWikiLink(canonical) === normalizeWikiLink(candidate.title)) continue;
			if (!relatedTitles.includes(canonical)) relatedTitles.push(canonical);
			if (relatedTitles.length >= MAX_RELATED_ITEMS) break;
		}
		return {
			title: candidate.title,
			type: candidate.type,
			action: candidate.existingDefinition ? "update" : "create",
			definition: proposed?.definition || candidate.existingDefinition || candidate.description,
			tags: candidate.tags,
			contradiction: proposed?.contradiction,
			relatedTitles,
		};
	});
}

function readExistingDefinition(l2DataDir: string, item: LinkedItem): string | undefined {
	const rel = findExistingPage(l2DataDir, item);
	const abs = join(l2DataDir, rel);
	if (!existsSync(abs)) return undefined;
	const { body } = parseFrontmatter(readText(abs));
	const idx = body.indexOf("## 定义");
	if (idx < 0) return undefined;
	const rest = body.slice(idx + "## 定义".length);
	const nextSec = rest.search(/\n## /);
	const def = (nextSec >= 0 ? rest.slice(0, nextSec) : rest).trim();
	return def || undefined;
}

async function planLinkedItems(
	model: Model<any> | undefined,
	modelRegistry: ModelRegistry | undefined,
	title: string,
	summary: string,
	candidates: PlanCandidate[],
	existingPages: WikiPageReference[],
): Promise<PlanItem[] | null> {
	if (!model || !modelRegistry || candidates.length === 0) return null;
	const candidateJson = JSON.stringify(
		candidates.map((c) => ({
			title: c.title,
			type: c.type,
			tags: c.tags,
			existingDefinition: c.existingDefinition ? c.existingDefinition.slice(0, 600) : "",
		})),
	);
	const truncatedSummary =
		summary.length > MAX_LINK_PROMPT_LENGTH ? summary.slice(0, MAX_LINK_PROMPT_LENGTH) + "\n\n...(内容已截断)" : summary;
	const prompt = STAGE1_PLAN_PROMPT
		.replace("{title}", title)
		.replace("{summary}", truncatedSummary)
		.replace("{candidates}", candidateJson)
		.replace(
			"{existingPages}",
			JSON.stringify(existingPages.slice(0, MAX_EXISTING_PAGE_TITLES).map((page) => ({ title: page.title, type: page.type }))),
		);
	try {
		const auth = await modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) return null;
		const response = await complete(
			model,
			{ messages: [{ role: "user" as const, content: [{ type: "text" as const, text: prompt }], timestamp: Date.now() }] },
			{ apiKey: auth.apiKey, headers: auth.headers, maxTokens: 4096 },
		);
		if (response.stopReason === "error") return null;
		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		const plan = parsePlanItems(text);
		return plan.length > 0 ? plan : null;
	} catch (err) {
		logger.warn({ err }, "LLM ingest planning failed, using fallback");
		return null;
	}
}

function replaceDefinitionSection(content: string, newDef: string): string {
	const header = "## 定义";
	const idx = content.indexOf(header);
	if (idx < 0) {
		const relIdx = content.indexOf("\n## 相关资料");
		const section = `## 定义\n\n${newDef}\n\n`;
		if (relIdx >= 0) return `${content.slice(0, relIdx + 1)}${section}${content.slice(relIdx + 1)}`;
		return `${content.trimEnd()}\n\n${section}`;
	}
	const bodyStart = idx + header.length;
	const rest = content.slice(bodyStart);
	const nextSec = rest.search(/\n## /);
	const insertEnd = nextSec >= 0 ? bodyStart + nextSec : content.length;
	return `${content.slice(0, bodyStart)}\n\n${newDef}\n${content.slice(insertEnd)}`;
}

function applyContradiction(content: string, entry: ManifestEntry, note: string): string | null {
	const fmResult = mutateFrontmatter(content, (fm) => {
		fm.contested = true;
		if (!fm.contradictions) fm.contradictions = [];
		if (!fm.contradictions.includes(entry.id)) fm.contradictions.push(entry.id);
	});
	let next = fmResult.content;
	let changed = fmResult.changed;
	if (!next.includes(note)) {
		const bullet = `- ${note}（来源 [[${entry.title}]] \`${entry.id}\`）`;
		const header = "\n## 争议";
		const idx = next.indexOf(header);
		if (idx >= 0) {
			const bodyStart = idx + header.length;
			const rest = next.slice(bodyStart);
			const nextSec = rest.search(/\n## /);
			const insertAt = nextSec >= 0 ? bodyStart + nextSec : next.length;
			next = `${next.slice(0, insertAt).trimEnd()}\n${bullet}${next.slice(insertAt)}`;
		} else {
			next = `${next.trimEnd()}\n\n## 争议\n\n${bullet}\n`;
		}
		changed = true;
	}
	return changed ? next : null;
}

function mergeIntoExistingPage(
	content: string,
	item: PlanItem,
	entry: ManifestEntry,
	sourcePagePath: string,
): { content: string; contested: boolean } | null {
	let next = content;
	let changed = false;
	let contested = false;
	if (item.definition) {
		const replaced = replaceDefinitionSection(next, item.definition);
		if (replaced !== next) { next = replaced; changed = true; }
	}
	const withRelated = addRelatedLinks(next, item.relatedTitles);
	if (withRelated) { next = withRelated; changed = true; }
	const withRef = addReferenceIfMissing(next, entry, sourcePagePath);
	if (withRef) { next = withRef; changed = true; }
	if (item.contradiction) {
		const withContra = applyContradiction(next, entry, item.contradiction);
		if (withContra) { next = withContra; changed = true; contested = true; }
	}
	return changed ? { content: next, contested } : null;
}

function upsertPlannedPage(
	l2DataDir: string,
	item: PlanItem,
	entry: ManifestEntry,
	sourcePagePath: string,
): { path: string; status: "created" | "updated" | "unchanged"; contested: boolean } {
	const linked: LinkedItem = { title: item.title, type: item.type, description: item.definition, tags: item.tags };
	const relativePath = findExistingPage(l2DataDir, linked);
	const absPath = join(l2DataDir, relativePath);
	ensureDir(join(l2DataDir, "wiki", pageDirForType(item.type)));
	if (!existsSync(absPath)) {
		writeText(absPath, buildNewPage(linked, entry, sourcePagePath, item.relatedTitles));
		return { path: relativePath, status: "created", contested: false };
	}
	const merged = mergeIntoExistingPage(readText(absPath), item, entry, sourcePagePath);
	if (!merged) return { path: relativePath, status: "unchanged", contested: false };
	writeText(absPath, merged.content);
	return { path: relativePath, status: "updated", contested: merged.contested };
}
