import { createHash, randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { existsSync, rmSync } from "node:fs";

import { readText, writeText } from "../../storage/file-store.js";
import { appendManifest, findManifestByRawPath, readManifest, removeManifestByRawPath } from "./manifest-store.js";
import { convertToExtracted } from "./source-converter.js";
import { removeNoteAttachmentDir } from "./note-attachments.js";
import { getSourceById, type SourceSummaryView } from "./source-resolver.js";
import type { ManifestEntry } from "./types.js";
import {
	appendLog,
	createSourcePage,
	ensureL2Directories,
	parseFrontmatter,
	rebuildIndex,
	serializeFrontmatter,
} from "./wiki-maintainer.js";

function parseNoteContent(content: string): { title: string; tags: string[]; body: string } {
	const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (!match) {
		return { title: "", tags: [], body: content };
	}
	let title = "";
	const tags: string[] = [];
	for (const line of match[1].split("\n")) {
		const titleMatch = line.match(/^title:\s*(.+)$/i);
		if (titleMatch) title = titleMatch[1].trim();
		const tagsMatch = line.match(/^tags:\s*(.+)$/i);
		if (tagsMatch) {
			tags.push(
				...tagsMatch[1]
					.split(/[,，;；、|/\n]/)
					.map((tag) => tag.trim().replace(/^#+/, ""))
					.filter(Boolean),
			);
		}
	}
	return { title, tags, body: match[2] };
}

function titleFromFileName(fileName: string): string {
	return (
		basename(fileName, ".md")
			.replace(/-\d{4}-\d{2}-\d{2}-[a-f0-9]{6}$/i, "")
			.replace(/-/g, " ")
			.trim() || fileName
	);
}

function summaryBodyFromNote(body: string): string {
	const trimmed = body.trim();
	if (!trimmed) return "## 内容\n\n(空笔记)";
	return trimmed.startsWith("#") ? trimmed : `## 内容\n\n${trimmed}`;
}

export function isUserNotePath(rawPath: string): boolean {
	const normalized = rawPath.replace(/^\/+/, "");
	return normalized.startsWith("raw/notes/") && normalized.toLowerCase().endsWith(".md");
}

function syncWikiSourcePage(l2DataDir: string, entry: ManifestEntry, content: string): void {
	const sourcePage =
		entry.wikiPages.find((page) => page.includes("wiki/sources/")) ?? entry.wikiPages[0];
	if (!sourcePage) return;

	const { title, tags, body } = parseNoteContent(content);
	const summaryBody = summaryBodyFromNote(body);
	const fullPath = join(l2DataDir, sourcePage);
	const { frontmatter } = parseFrontmatter(readText(fullPath));
	if (!frontmatter) return;

	const today = new Date().toISOString().slice(0, 10);
	const updatedFrontmatter = {
		...frontmatter,
		title: title || frontmatter.title,
		tags: tags.length > 0 ? tags : frontmatter.tags,
		updated: today,
	};
	const ref = entry.extractedPath ? `\n## 来源\n\n完整提取文本: \`${entry.extractedPath}\`\n` : "";
	const pageBody = `\n# ${title || frontmatter.title}\n\n${summaryBody}\n${ref}`;
	writeText(fullPath, serializeFrontmatter(updatedFrontmatter) + pageBody);
}

function syncArchivedNote(l2DataDir: string, entry: ManifestEntry, content: string): void {
	const { body } = parseNoteContent(content);
	const extractedBody = body.trim() || content;
	if (entry.extractedPath) {
		writeText(join(l2DataDir, entry.extractedPath), extractedBody);
	}
	syncWikiSourcePage(l2DataDir, entry, content);
}

/** Archive or sync a user note under raw/notes/*.md after save. */
export function saveUserNote(l2DataDir: string, rawPath: string, content: string): SourceSummaryView {
	if (!isUserNotePath(rawPath)) {
		throw new Error("Only raw/notes/*.md supports auto-archive");
	}

	ensureL2Directories(l2DataDir);
	const normalized = rawPath.replace(/^\/+/, "");
	const existing = findManifestByRawPath(l2DataDir, normalized);
	if (existing) {
		syncArchivedNote(l2DataDir, existing, content);
		const source = getSourceById(l2DataDir, existing.id);
		if (!source) throw new Error("Archived source not found");
		return source;
	}

	const { title: fmTitle, tags, body } = parseNoteContent(content);
	const fileName = basename(normalized);
	const title = fmTitle || titleFromFileName(fileName);
	const extractedBody = body.trim() || content;
	const contentHash = createHash("sha256").update(extractedBody).digest("hex").slice(0, 16);
	const id = `l2src_${randomUUID().slice(0, 8)}`;
	const extractedPath = convertToExtracted(l2DataDir, title, extractedBody, "markdown");

	const entry: ManifestEntry = {
		id,
		title,
		sourceType: "markdown",
		rawPath: normalized,
		extractedPath,
		wikiPages: [],
		tags,
		contentHash,
		status: "extracted",
		source: { origin: "user_upload" },
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};

	const wikiPagePath = createSourcePage(l2DataDir, entry, summaryBodyFromNote(body), extractedPath);
	entry.wikiPages = [wikiPagePath];
	entry.status = "indexed";
	appendManifest(l2DataDir, entry);
	rebuildIndex(l2DataDir, readManifest(l2DataDir));
	appendLog(
		l2DataDir,
		"ingest",
		title,
		[`- User note archived: ${normalized}`, `- Source page: ${wikiPagePath}`].join("\n"),
	);

	const source = getSourceById(l2DataDir, id);
	if (!source) throw new Error("Failed to load archived source");
	return source;
}

function removeFileIfExists(filePath: string): void {
	if (existsSync(filePath)) rmSync(filePath);
}

/** Delete a user note and its archived artifacts (manifest, extracted, wiki pages). */
export function deleteUserNote(l2DataDir: string, rawPath: string): boolean {
	if (!isUserNotePath(rawPath)) {
		throw new Error("Only raw/notes/*.md can be deleted through this API");
	}
	const normalized = rawPath.replace(/^\/+/, "");
	const entry = removeManifestByRawPath(l2DataDir, normalized);
	if (entry) {
		if (entry.extractedPath) {
			removeFileIfExists(join(l2DataDir, entry.extractedPath));
		}
		for (const wikiPage of entry.wikiPages) {
			removeFileIfExists(join(l2DataDir, wikiPage));
		}
		rebuildIndex(l2DataDir, readManifest(l2DataDir));
		appendLog(l2DataDir, "delete", entry.title, `- Removed archived note: ${normalized}`);
	}
	removeFileIfExists(join(l2DataDir, normalized));
	removeNoteAttachmentDir(l2DataDir, normalized);
	return true;
}
