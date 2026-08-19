import { createHash } from "node:crypto";
import { existsSync, statSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import { ensureDir, readText, writeText } from "../../storage/file-store.js";
import { resolveContainedPath } from "../../utils/path-safety.js";
import { runInL2ArchiveQueue } from "./l2-archive-service.js";
import { getL2Memory, type L2Memory } from "./l2-memory.js";
import { findManifestByRawPath, readManifest, removeManifestEntry } from "./manifest-store.js";
import { parseNoteFrontmatter, serializeNoteFile } from "./note-frontmatter.js";
import { regenerateOverview } from "./overview.js";
import { rebuildIndex } from "./wiki-maintainer.js";
import { reconcileLinkedWikiSource } from "./wiki-linker.js";

export interface UnarchiveNotebookResult {
	rawPath: string;
	title: string;
	removedWikiPages: string[];
	backupPaths: string[];
	status: "draft" | "uploaded";
}

export interface UnarchiveNotebookRuntime {
	model?: Model<any>;
	modelRegistry?: ModelRegistry;
	memory?: L2Memory;
}

function resolveDirectRawFile(l2DataDir: string, rawPath: string): { fullPath: string; isNote: boolean } {
	const normalizedPath = rawPath.replace(/\\/g, "/");
	const isNote = normalizedPath.startsWith("raw/notes/");
	const prefix = isNote
		? "raw/notes/"
		: normalizedPath.startsWith("raw/uploads/")
			? "raw/uploads/"
			: normalizedPath.startsWith("raw/conversations/")
				? "raw/conversations/"
				: "";
	const relativePath = prefix ? normalizedPath.slice(prefix.length) : "";
	if (!prefix || !relativePath || relativePath.includes("/")) throw new Error("Invalid raw path");
	const root = join(l2DataDir, ...prefix.slice(0, -1).split("/"));
	const fullPath = resolveContainedPath(root, relativePath);
	if (!fullPath || !existsSync(fullPath) || !statSync(fullPath).isFile()) throw new Error("文件不存在");
	return { fullPath, isNote };
}

function backupAndRemoveSourcePage(
	l2DataDir: string,
	wikiPath: string,
	sourceId: string,
): string | undefined {
	const normalizedPath = wikiPath.replace(/\\/g, "/");
	const prefix = "wiki/sources/";
	if (!normalizedPath.startsWith(prefix)) return undefined;
	const relativePath = normalizedPath.slice(prefix.length);
	if (!relativePath || relativePath.includes("/")) return undefined;
	const fullPath = resolveContainedPath(join(l2DataDir, "wiki", "sources"), relativePath);
	if (!fullPath || !existsSync(fullPath)) return undefined;

	const original = readText(fullPath);
	const hash = createHash("sha256").update(original).digest("hex").slice(0, 10);
	const backupPath = join(
		"wiki",
		"orphans",
		`${basename(relativePath, ".md")}-${sourceId.slice(-8)}-${hash}.md`,
	).replace(/\\/g, "/");
	ensureDir(join(l2DataDir, "wiki", "orphans"));
	writeText(join(l2DataDir, backupPath), original);
	unlinkSync(fullPath);
	return backupPath;
}

export function unarchiveL2NotebookItem(
	l2DataDir: string,
	rawPath: string,
	runtime: UnarchiveNotebookRuntime = {},
): Promise<UnarchiveNotebookResult> {
	const normalizedPath = rawPath.replace(/\\/g, "/");
	resolveDirectRawFile(l2DataDir, normalizedPath);

	return runInL2ArchiveQueue(l2DataDir, async () => {
		const entry = findManifestByRawPath(l2DataDir, normalizedPath);
		if (!entry) throw new Error("该内容未归档，无法撤回");
		const memory = runtime.memory ?? getL2Memory(l2DataDir);
		const sourcePages = entry.wikiPages.filter((path) => path.replace(/\\/g, "/").startsWith("wiki/sources/"));
		const sourcePageSet = new Set(sourcePages.map((path) => path.replace(/\\/g, "/")));
		const linkedPages = entry.wikiPages.filter((path) => !sourcePageSet.has(path.replace(/\\/g, "/")));

		for (const wikiPath of linkedPages) {
			const reconciled = reconcileLinkedWikiSource(l2DataDir, wikiPath, {
				sourceId: entry.id,
				previousSourcePagePaths: sourcePages,
				currentTitle: entry.title,
				keepSource: false,
			});
			if (reconciled.exists) await memory.indexPageByPath(reconciled.path);
			else await memory.removePage(reconciled.path);
		}

		const remainingEntries = readManifest(l2DataDir).filter((candidate) => candidate.id !== entry.id);
		const stillReferenced = new Set(remainingEntries.flatMap((candidate) => candidate.wikiPages.map((path) => path.replace(/\\/g, "/"))));
		const removedWikiPages: string[] = [];
		const backupPaths: string[] = [];
		for (const sourcePage of sourcePages) {
			const normalizedSourcePage = sourcePage.replace(/\\/g, "/");
			if (stillReferenced.has(normalizedSourcePage)) continue;
			const backupPath = backupAndRemoveSourcePage(l2DataDir, normalizedSourcePage, entry.id);
			if (backupPath) {
				backupPaths.push(backupPath);
				removedWikiPages.push(normalizedSourcePage);
			}
			await memory.removePage(normalizedSourcePage);
		}

		const resolvedRaw = resolveDirectRawFile(l2DataDir, normalizedPath);
		let status: UnarchiveNotebookResult["status"] = "uploaded";
		if (resolvedRaw.isNote) {
			const parsed = parseNoteFrontmatter(readText(resolvedRaw.fullPath));
			if (!parsed.frontmatter?.note_id) throw new Error("Invalid note file");
			writeText(resolvedRaw.fullPath, serializeNoteFile({
				...parsed.frontmatter,
				status: "draft",
				source_id: undefined,
				updated: new Date().toISOString(),
			}, parsed.body));
			status = "draft";
		}

		if (!removeManifestEntry(l2DataDir, entry.id)) throw new Error("Manifest entry disappeared during unarchive");
		rebuildIndex(l2DataDir, remainingEntries);
		const overviewPath = await regenerateOverview(l2DataDir, runtime.model, runtime.modelRegistry);
		if (overviewPath) await memory.indexPageByPath(overviewPath);

		return { rawPath: normalizedPath, title: entry.title, removedWikiPages, backupPaths, status };
	});
}
