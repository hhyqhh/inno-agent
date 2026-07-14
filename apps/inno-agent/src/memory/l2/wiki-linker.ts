import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { basename, extname, join } from "node:path";

import { complete } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import { ensureDir, readText, writeText } from "../../storage/file-store.js";
import type { ManifestEntry, WikiPageType } from "./types.js";
import { parseFrontmatter, serializeFrontmatter } from "./wiki-maintainer.js";
import { logger } from "../../logger.js";
import { normalizeMarkdownForMilkdown } from "./markdown-normalizer.js";

type LinkablePageType = Extract<WikiPageType, "entity" | "concept">;

interface LinkedItem {
	title: string;
	type: LinkablePageType;
	description: string;
}

export interface WikiLinkMaintenanceResult {
	created: string[];
	updated: string[];
	unchanged: string[];
	pages: string[];
}

export interface WikiLinkMaintenanceOptions {
	createMissing?: boolean;
	currentRelations?: string;
	signal?: AbortSignal;
}

const LINK_MAINTAIN_PROMPT = `你是一个学习 Wiki 知识库维护助手。

请从下面的资料摘要中抽取值得长期维护的实体和概念，并分类。

分类规则：
- entity: 人物、组织、公司、项目、产品、论文、标准、框架/库的具体名称。
- concept: 技术概念、理论、方法、能力、机制、模式、问题类型。
- 不要抽取过泛的词，例如"方法"、"系统"、"内容"。
- 优先使用资料中已有的 [[双链]] 条目。
- 最多返回 20 个条目。

资料标题：{title}

资料摘要：
---
{content}
---

只返回 JSON，不要代码块：
{"items":[{"title":"条目名","type":"concept","description":"一句话定义或说明"}]}`;

const MAX_LINK_PROMPT_LENGTH = 30000;
const MAX_RELATION_CONTEXT_LENGTH = 20000;

const RELATION_AWARE_LINK_MAINTAIN_PROMPT = `你是一个学习 Wiki 知识图谱维护助手。

你的任务不是重新生成资料文档，而是根据「原资料」和「当前这份资料已有的知识关系」决定应该新增或更新哪些实体/概念知识点。

规则：
- 可以保留当前已有关系，也可以补充原资料中明显缺失的重要实体/概念。
- 不要创建 source-summary / 资料页；只返回 entity 或 concept。
- 避免过泛词，例如“方法”“系统”“内容”“模板”。
- 如果当前关系已经覆盖得很好，返回这些已有关系即可，不要为了变化而制造新节点。
- 最多返回 20 个条目。

资料标题：{title}

原资料：
---
{content}
---

当前知识关系：
---
{currentRelations}
---

只返回 JSON，不要代码块：
{"items":[{"title":"条目名","type":"concept","description":"一句话定义或说明"}]}`;

export function readSourceKnowledgeRelations(l2DataDir: string, wikiPages: string[]): string {
	const sections: string[] = [];
	for (const wikiPath of wikiPages) {
		const normalizedPath = wikiPath.replace(/\\/g, "/");
		if (!normalizedPath.includes("wiki/entities/") && !normalizedPath.includes("wiki/concepts/")) continue;
		const absPath = join(l2DataDir, normalizedPath);
		if (!existsSync(absPath)) continue;
		try {
			const content = readText(absPath);
			const { frontmatter, body } = parseFrontmatter(content);
			const title = frontmatter?.title || basename(normalizedPath, extname(normalizedPath));
			const type = frontmatter?.type || (normalizedPath.includes("wiki/entities/") ? "entity" : "concept");
			const sourceIds = frontmatter?.source_ids?.join(", ") || "";
			const preview = body.trim().slice(0, 2000);
			sections.push([
				`Path: ${normalizedPath}`,
				`Title: ${title}`,
				`Type: ${type}`,
				`Source IDs: ${sourceIds}`,
				"Content:",
				preview || "(empty)",
			].join("\n"));
		} catch (err) {
			logger.warn({ err, wikiPath: normalizedPath }, "failed to read linked wiki relation context");
		}
	}
	const context = sections.length > 0 ? sections.join("\n\n---\n\n") : "(no current entity/concept relations)";
	return context.length > MAX_RELATION_CONTEXT_LENGTH
		? `${context.slice(0, MAX_RELATION_CONTEXT_LENGTH)}\n\n...(relations truncated)`
		: context;
}

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
	return extractWikiLinks(content).slice(0, 20).map((title) => ({
		title,
		type: looksLikeEntity(title) ? "entity" : "concept",
		description: "由 L2 自动从资料摘要中的双链识别，待进一步完善。",
	}));
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
		});
	}
	return items;
}

async function extractLinkedItems(
	model: Model<any> | undefined,
	modelRegistry: ModelRegistry | undefined,
	title: string,
	content: string,
	currentRelations?: string,
	signal?: AbortSignal,
): Promise<LinkedItem[]> {
	signal?.throwIfAborted();
	const fallback = fallbackItems(content);
	if (!model || !modelRegistry) return fallback;

	const truncated =
		content.length > MAX_LINK_PROMPT_LENGTH
			? content.slice(0, MAX_LINK_PROMPT_LENGTH) + "\n\n...(内容已截断)"
			: content;
	const promptTemplate = currentRelations ? RELATION_AWARE_LINK_MAINTAIN_PROMPT : LINK_MAINTAIN_PROMPT;
	const prompt = promptTemplate
		.replace("{title}", title)
		.replace("{content}", truncated)
		.replace("{currentRelations}", currentRelations ?? "");

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
				signal,
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
		if (signal?.aborted) throw err;
		logger.warn({ err }, "LLM wiki link extraction failed, using fallback");
		return fallback;
	}
}

function pageDirForType(type: LinkablePageType): string {
	return type === "entity" ? "entities" : "concepts";
}

function relativePagePath(type: LinkablePageType, filename: string): string {
	return join("wiki", pageDirForType(type), filename);
}

function findExistingPage(l2DataDir: string, item: LinkedItem): { path: string; exists: boolean } {
	const dir = join(l2DataDir, "wiki", pageDirForType(item.type));
	const slugPath = relativePagePath(item.type, `${slugifyTitle(item.title)}.md`);
	const slugAbsPath = join(l2DataDir, slugPath);
	if (existsSync(slugAbsPath)) return { path: slugPath, exists: true };
	if (!existsSync(dir)) return { path: slugPath, exists: false };

	for (const file of readdirSync(dir)) {
		if (!file.endsWith(".md")) continue;
		const relativePath = relativePagePath(item.type, file);
		const content = readText(join(l2DataDir, relativePath));
		const { frontmatter } = parseFrontmatter(content);
		const title = frontmatter?.title || basename(file, extname(file));
		if (title === item.title) return { path: relativePath, exists: true };
	}
	return { path: slugPath, exists: false };
}

function mergeTags(...tagGroups: string[][]): string[] {
	const seen = new Set<string>();
	const tags: string[] = [];
	for (const group of tagGroups) {
		for (const rawTag of group) {
			for (const tag of rawTag.split(/[\s,\uFF0C;\uFF1B\u3001|]+/)) {
			const trimmed = tag.trim();
			if (!trimmed || seen.has(trimmed)) continue;
			seen.add(trimmed);
			tags.push(trimmed);
			}
		}
	}
	return tags.slice(0, 12);
}

function buildNewPage(item: LinkedItem, entry: ManifestEntry, sourcePagePath: string): string {
	const today = new Date().toISOString().slice(0, 10);
	const frontmatter = serializeFrontmatter({
		title: item.title,
		created: today,
		type: item.type,
		tags: mergeTags([item.type], entry.tags),
		sources: [sourcePagePath],
		source_ids: [entry.id],
		updated: today,
		status: "draft",
		confidence: "medium",
	});
	return normalizeMarkdownForMilkdown(`${frontmatter}
# ${item.title}

## 定义

${item.description}

## 相关资料

- [[${entry.title}]] — \`${sourcePagePath}\`
`);
}

function referenceBullet(entry: ManifestEntry, sourcePagePath: string): string {
	return `- [[${entry.title}]] — \`${sourcePagePath}\``;
}

function addFrontmatterArrayItem(yamlBlock: string, key: string, value: string): { yaml: string; changed: boolean } {
	const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const multilineItemPattern = new RegExp(`^\\s+-\\s+${escaped}\\s*$`, "m");
	const inlineKeyPattern = new RegExp(`^${key}:\\s*\\[(.*)\\]\\s*$`, "m");
	const multilineKeyPattern = new RegExp(`^${key}:\\s*$`, "m");

	if (multilineItemPattern.test(yamlBlock)) return { yaml: yamlBlock, changed: false };

	const inlineMatch = yamlBlock.match(inlineKeyPattern);
	if (inlineMatch) {
		const items = inlineMatch[1]
			.split(",")
			.map((item) => item.trim())
			.filter(Boolean);
		if (items.includes(value)) return { yaml: yamlBlock, changed: false };
		const replacement = `${key}:\n${items.map((item) => `  - ${item}`).join("\n")}\n  - ${value}`;
		return { yaml: yamlBlock.replace(inlineKeyPattern, replacement), changed: true };
	}

	const keyMatch = yamlBlock.match(multilineKeyPattern);
	if (keyMatch && keyMatch.index !== undefined) {
		const start = keyMatch.index + keyMatch[0].length;
		const nextKeyMatch = yamlBlock.slice(start).match(/^\w+:\s*/m);
		const insertAt = nextKeyMatch?.index === undefined ? yamlBlock.length : start + nextKeyMatch.index;
		const before = yamlBlock.slice(0, insertAt).trimEnd();
		const after = yamlBlock.slice(insertAt);
		return { yaml: `${before}\n  - ${value}\n${after.replace(/^\n/, "")}`, changed: true };
	}

	return { yaml: `${yamlBlock.trimEnd()}\n${key}:\n  - ${value}`, changed: true };
}

function updateFrontmatterReference(content: string, entry: ManifestEntry, sourcePagePath: string): {
	content: string;
	changed: boolean;
} {
	const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (!match) return { content, changed: false };

	let yamlBlock = match[1];
	let changed = false;

	if (!/^created:\s*.*$/m.test(yamlBlock)) {
		const existingUpdated = yamlBlock.match(/^updated:\s*(.*)$/m)?.[1]?.trim();
		yamlBlock = `${yamlBlock.trimEnd()}\ncreated: ${existingUpdated || new Date().toISOString().slice(0, 10)}`;
		changed = true;
	}

	const sourceResult = addFrontmatterArrayItem(yamlBlock, "sources", sourcePagePath);
	yamlBlock = sourceResult.yaml;
	changed ||= sourceResult.changed;

	const sourceIdResult = addFrontmatterArrayItem(yamlBlock, "source_ids", entry.id);
	yamlBlock = sourceIdResult.yaml;
	changed ||= sourceIdResult.changed;

	const today = new Date().toISOString().slice(0, 10);
	if (/^updated:\s*.*$/m.test(yamlBlock)) {
		const nextYaml = yamlBlock.replace(/^updated:\s*.*$/m, `updated: ${today}`);
		changed ||= nextYaml !== yamlBlock;
		yamlBlock = nextYaml;
	} else {
		yamlBlock = `${yamlBlock.trimEnd()}\nupdated: ${today}`;
		changed = true;
	}

	return { content: `---\n${yamlBlock}\n---\n${match[2]}`, changed };
}

function addReferenceIfMissing(content: string, entry: ManifestEntry, sourcePagePath: string): string | null {
	const bodyAlreadyReferencesSource = content.includes(sourcePagePath);
	const metadataUpdate = updateFrontmatterReference(content, entry, sourcePagePath);
	content = metadataUpdate.content;
	let changed = metadataUpdate.changed;

	if (bodyAlreadyReferencesSource) return changed ? content : null;

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

function upsertLinkedPage(
	l2DataDir: string,
	item: LinkedItem,
	entry: ManifestEntry,
	sourcePagePath: string,
	options: WikiLinkMaintenanceOptions = {},
): { path: string; status: "created" | "updated" | "unchanged" } {
	const found = findExistingPage(l2DataDir, item);
	const relativePath = found.path;
	const absPath = join(l2DataDir, relativePath);
	ensureDir(join(l2DataDir, "wiki", pageDirForType(item.type)));

	if (!found.exists && options.createMissing === false) {
		return { path: relativePath, status: "unchanged" };
	}

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
 * The source page keeps the original summary. This function creates or updates
 * linked entity/concept pages, then returns their paths so the manifest and
 * index can include them in the same archive transaction.
 */
export async function maintainLinkedWikiPages(
	l2DataDir: string,
	entry: ManifestEntry,
	sourcePagePath: string,
	sourcePageBody: string,
	model?: Model<any>,
	modelRegistry?: ModelRegistry,
	options: WikiLinkMaintenanceOptions = {},
): Promise<WikiLinkMaintenanceResult> {
	const result: WikiLinkMaintenanceResult = { created: [], updated: [], unchanged: [], pages: [] };
	const items = await extractLinkedItems(model, modelRegistry, entry.title, sourcePageBody, options.currentRelations, options.signal);
	options.signal?.throwIfAborted();
	for (const item of items) {
		const page = upsertLinkedPage(l2DataDir, item, entry, sourcePagePath, options);
		if (options.createMissing === false && page.status === "unchanged" && !existsSync(join(l2DataDir, page.path))) {
			continue;
		}
		result.pages.push(page.path);
		result[page.status].push(page.path);
	}
	result.pages = [...new Set(result.pages)];
	return result;
}
