import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, readJson, readText, writeJson, writeText } from "../../storage/file-store.js";
import { readManifest, updateManifestEntry } from "./manifest-store.js";
import type { L2PageTagRecord, L2TagIndexFile, L2TagRecord, WikiPageTagSource } from "./types.js";
import { parseFrontmatter, serializeFrontmatter } from "./wiki-maintainer.js";
import { canonicalizeTag, normalizeTagList } from "./l2-utils.js";

export { canonicalizeTag, normalizeTagList } from "./l2-utils.js";

const TAG_INDEX_FILE = join("index", "tags.json");

function tagIndexPath(l2DataDir: string): string {
	return join(l2DataDir, TAG_INDEX_FILE);
}

function emptyTagIndex(): L2TagIndexFile {
	return { tags: [], pageTags: [], updatedAt: new Date().toISOString() };
}

export function readTagIndex(l2DataDir: string): L2TagIndexFile {
	return readJson<L2TagIndexFile>(tagIndexPath(l2DataDir), emptyTagIndex());
}

export function writeTagIndex(l2DataDir: string, index: L2TagIndexFile): void {
	ensureDir(join(l2DataDir, "index"));
	writeJson(tagIndexPath(l2DataDir), { ...index, updatedAt: new Date().toISOString() });
}

export function rebuildTagIndex(l2DataDir: string, pages: WikiPageTagSource[]): L2TagIndexFile {
	const previous = readTagIndex(l2DataDir);
	const byCanonical = new Map<string, L2TagRecord>();
	for (const tag of previous.tags) {
		byCanonical.set(tag.canonicalKey, { ...tag, usageCount: 0 });
	}

	const pageTags: L2PageTagRecord[] = [];
	const now = new Date().toISOString();
	for (const page of pages) {
		for (const displayName of normalizeTagList(page.tags)) {
			const canonicalKey = canonicalizeTag(displayName);
			let tag = byCanonical.get(canonicalKey);
			if (!tag) {
				tag = {
					id: `tag_${randomUUID().slice(0, 8)}`,
					canonicalKey,
					displayName,
					usageCount: 0,
					createdAt: now,
					updatedAt: now,
				};
			}
			tag.displayName = displayName;
			tag.usageCount += 1;
			tag.updatedAt = now;
			byCanonical.set(canonicalKey, tag);
			pageTags.push({
				wikiPath: page.wikiPath,
				tagId: tag.id,
				sourceId: page.sourceIds[0],
				createdAt: now,
			});
		}
	}

	const next: L2TagIndexFile = {
		tags: [...byCanonical.values()]
			.filter((tag) => tag.usageCount > 0)
			.sort((a, b) => b.usageCount - a.usageCount || a.displayName.localeCompare(b.displayName, "zh-CN")),
		pageTags,
		updatedAt: now,
	};
	writeTagIndex(l2DataDir, next);
	return next;
}

export function listTags(l2DataDir: string): L2TagRecord[] {
	return readTagIndex(l2DataDir).tags;
}

export function suggestTags(l2DataDir: string, query: string, limit = 12): string[] {
	const key = canonicalizeTag(query);
	return listTags(l2DataDir)
		.filter((tag) => !key || tag.canonicalKey.includes(key) || tag.displayName.toLowerCase().includes(key))
		.slice(0, limit)
		.map((tag) => tag.displayName);
}

export function wikiPathsForTag(l2DataDir: string, tag: string): string[] {
	const key = canonicalizeTag(tag);
	const index = readTagIndex(l2DataDir);
	const record = index.tags.find((item) => item.canonicalKey === key);
	if (!record) return [];
	return index.pageTags
		.filter((item) => item.tagId === record.id)
		.map((item) => item.wikiPath);
}

export function updateWikiPageTags(l2DataDir: string, wikiPath: string, tags: string[]): string[] {
	const fullPath = join(l2DataDir, wikiPath);
	if (!existsSync(fullPath)) {
		throw new Error("Wiki page not found");
	}
	const content = readText(fullPath);
	const { frontmatter, body } = parseFrontmatter(content);
	if (!frontmatter) {
		throw new Error("Wiki page frontmatter is missing");
	}
	const normalizedTags = normalizeTagList(tags);
	const nextFrontmatter = {
		...frontmatter,
		tags: normalizedTags,
		updated: new Date().toISOString().slice(0, 10),
	};
	writeText(fullPath, `${serializeFrontmatter(nextFrontmatter)}\n${body}`);
	syncManifestTagsForWikiPage(l2DataDir, wikiPath, frontmatter.source_ids, normalizedTags);
	return normalizedTags;
}

export function syncManifestTagsForWikiPage(
	l2DataDir: string,
	wikiPath: string,
	sourceIds: string[],
	tags: string[],
): void {
	const entries = readManifest(l2DataDir);
	for (const entry of entries) {
		if (!entry.wikiPages.includes(wikiPath) && !sourceIds.includes(entry.id)) continue;
		updateManifestEntry(l2DataDir, entry.id, (current) => ({
			...current,
			tags,
			updatedAt: new Date().toISOString(),
		}));
	}
}
