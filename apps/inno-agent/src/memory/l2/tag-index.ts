import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ensureDir, readJson, writeJson } from "../../storage/file-store.js";

export interface L2TagRecord {
	id: string;
	canonicalKey: string;
	displayName: string;
	usageCount: number;
	createdAt: string;
	updatedAt: string;
}

export interface L2PageTagRecord {
	wikiPath: string;
	tagId: string;
	createdAt: string;
}

export interface L2TagIndex {
	tags: L2TagRecord[];
	pageTags: L2PageTagRecord[];
	updatedAt: string;
}

export interface WikiPageTagSource {
	wikiPath: string;
	tags: string[];
}

const TAG_INDEX_FILE = join("index", "tags.json");
const TAG_SEPARATOR = /[,\uFF0C;\uFF1B\u3001|]+/;

function tagIndexPath(l2DataDir: string): string {
	return join(l2DataDir, TAG_INDEX_FILE);
}

export function canonicalizeTag(tag: string): string {
	return tag.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function normalizeTagList(tags: string[]): string[] {
	const byKey = new Map<string, string>();
	for (const rawTag of tags) {
		for (const candidate of rawTag.split(TAG_SEPARATOR)) {
			const displayName = candidate.trim().replace(/\s+/g, " ");
			const canonicalKey = canonicalizeTag(displayName);
			if (!canonicalKey || byKey.has(canonicalKey)) continue;
			byKey.set(canonicalKey, displayName);
		}
	}
	return [...byKey.values()];
}

function emptyTagIndex(): L2TagIndex {
	return { tags: [], pageTags: [], updatedAt: new Date(0).toISOString() };
}

export function readTagIndex(l2DataDir: string): L2TagIndex {
	return readJson<L2TagIndex>(tagIndexPath(l2DataDir), emptyTagIndex());
}

function writeTagIndex(l2DataDir: string, index: L2TagIndex): void {
	ensureDir(join(l2DataDir, "index"));
	writeJson(tagIndexPath(l2DataDir), index);
}

export function rebuildTagIndex(l2DataDir: string, pages: WikiPageTagSource[]): L2TagIndex {
	const previousByKey = new Map(readTagIndex(l2DataDir).tags.map((tag) => [tag.canonicalKey, tag]));
	const nextByKey = new Map<string, L2TagRecord>();
	const pageTags: L2PageTagRecord[] = [];
	const now = new Date().toISOString();

	for (const page of pages) {
		for (const displayName of normalizeTagList(page.tags)) {
			const canonicalKey = canonicalizeTag(displayName);
			const previous = previousByKey.get(canonicalKey);
			const tag = nextByKey.get(canonicalKey) ?? {
				id: previous?.id ?? `tag_${randomUUID().slice(0, 8)}`,
				canonicalKey,
				displayName,
				usageCount: 0,
				createdAt: previous?.createdAt ?? now,
				updatedAt: now,
			};
			tag.usageCount += 1;
			nextByKey.set(canonicalKey, tag);
			pageTags.push({ wikiPath: page.wikiPath, tagId: tag.id, createdAt: now });
		}
	}

	const index: L2TagIndex = {
		tags: [...nextByKey.values()].sort(
			(a, b) => b.usageCount - a.usageCount || a.displayName.localeCompare(b.displayName, "zh-CN"),
		),
		pageTags,
		updatedAt: now,
	};
	writeTagIndex(l2DataDir, index);
	return index;
}

export function listTags(l2DataDir: string): L2TagRecord[] {
	return readTagIndex(l2DataDir).tags;
}

export function suggestTags(l2DataDir: string, query: string, limit = 12): string[] {
	const key = canonicalizeTag(query);
	return listTags(l2DataDir)
		.filter((tag) => !key || tag.canonicalKey.includes(key))
		.slice(0, Math.max(0, limit))
		.map((tag) => tag.displayName);
}

export function wikiPathsForTag(l2DataDir: string, tag: string): string[] {
	const index = readTagIndex(l2DataDir);
	const record = index.tags.find((item) => item.canonicalKey === canonicalizeTag(tag));
	if (!record) return [];
	return index.pageTags.filter((item) => item.tagId === record.id).map((item) => item.wikiPath);
}
