import { randomUUID } from "node:crypto";
import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";
import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { wikiPathJoin } from "../../memory/l2/wiki-paths.js";
import { sanitizeUploadedFileName, uploadExtension } from "../../memory/l2/upload-file-utils.js";
import { logger } from "../../logger.js";
import { getL2Memory } from "../../memory/l2/l2-memory.js";
import { readManifest, removeWikiPathFromManifest } from "../../memory/l2/manifest-store.js";
import { buildWikiGraph } from "../../memory/l2/wiki-graph.js";
import { parseFrontmatter } from "../../memory/l2/wiki-maintainer.js";
import {
	listTags,
	rebuildTagIndex,
	suggestTags,
	updateWikiPageTags,
	wikiPathsForTag,
	type WikiPageTagSource,
} from "../../memory/l2/tag-index.js";
import { ensureDir, readText, writeText } from "../../storage/file-store.js";
import { safeJoinReal } from "../file-helpers.js";
import { json, readBody, UPLOAD_MAX_BODY_BYTES } from "../http-helpers.js";

export interface WikiRouteContext {
	l2DataDir: string;
}

// ---------------------------------------------------------------------------
// Helpers moved verbatim from server.ts (P2 route split). The two wiki
// listing helpers closed over server.ts's module-level l2DataDir; they take
// it as an explicit parameter instead.
// ---------------------------------------------------------------------------

const WIKI_PAGE_DIRS = ["sources", "entities", "concepts", "analysis"] as const;

function listWikiPagePaths(l2DataDir: string): string[] {
	const wikiRoot = join(l2DataDir, "wiki");
	const paths: string[] = [];
	for (const dirName of WIKI_PAGE_DIRS) {
		const dir = join(wikiRoot, dirName);
		if (!existsSync(dir)) continue;
		for (const file of readdirSync(dir)) {
			if (file.endsWith(".md")) {
				paths.push(wikiPathJoin("wiki", dirName, file));
			}
		}
	}
	return paths.sort((a, b) => a.localeCompare(b, "zh-CN"));
}

function manifestSourceIdByWikiPath(l2DataDir: string): Map<string, string> {
	const map = new Map<string, string>();
	for (const entry of readManifest(l2DataDir)) {
		for (const wikiPath of entry.wikiPages) {
			map.set(wikiPath, entry.id);
		}
	}
	return map;
}

function collectWikiPageTagSources(l2DataDir: string): WikiPageTagSource[] {
	const pages: WikiPageTagSource[] = [];
	for (const wikiPath of listWikiPagePaths(l2DataDir)) {
		const fullPath = safeJoinReal(l2DataDir, wikiPath);
		if (!fullPath || !existsSync(fullPath)) continue;
		const { frontmatter } = parseFrontmatter(readText(fullPath));
		if (frontmatter) pages.push({ wikiPath, tags: frontmatter.tags });
	}
	return pages;
}

function refreshTagIndex(l2DataDir: string): void {
	rebuildTagIndex(l2DataDir, collectWikiPageTagSources(l2DataDir));
}

/**
 * /api/wiki/* and /api/l2/raw/upload route domain. Returns true when the
 * request was handled. Extracted verbatim from server.ts during the P2 route
 * split — behavior unchanged. (The L2 upload route previously sat ~170 lines
 * below the wiki routes; exact-path matching makes the reordering inert.)
 */
export async function handleWikiRoutes(
	req: HttpReq,
	res: ServerResponse,
	method: string,
	url: string,
	ctx: WikiRouteContext,
): Promise<boolean> {
	const { l2DataDir } = ctx;

	// --- Wiki API ---
	if (method === "GET" && (url === "/api/wiki/pages" || url.startsWith("/api/wiki/pages?"))) {
		try {
			refreshTagIndex(l2DataDir);
			const tag = new URL(url, "http://localhost").searchParams.get("tag");
			const allowedPaths = tag ? new Set(wikiPathsForTag(l2DataDir, tag)) : null;
			const sourceIds = manifestSourceIdByWikiPath(l2DataDir);
			const pages: unknown[] = [];
			for (const wikiPath of listWikiPagePaths(l2DataDir)) {
				if (allowedPaths && !allowedPaths.has(wikiPath)) continue;
				const fullPath = join(l2DataDir, wikiPath);
				if (existsSync(fullPath)) {
					const content = readText(fullPath);
					const { frontmatter, body } = parseFrontmatter(content);
					pages.push({
						path: wikiPath,
						frontmatter,
						bodyPreview: body.slice(0, 200),
						sourceId: sourceIds.get(wikiPath) ?? "",
					});
				}
			}
			json(res, 200, pages);
		} catch (err) {
			logger.warn({ err }, "failed to list wiki pages");
			json(res, 200, []);
		}
		return true;
	}

	if (method === "GET" && url.startsWith("/api/l2/tags/suggest")) {
		try {
			refreshTagIndex(l2DataDir);
			const query = new URL(url, "http://localhost").searchParams.get("query") ?? "";
			json(res, 200, { suggestions: suggestTags(l2DataDir, query) });
		} catch (err) {
			logger.warn({ err }, "failed to suggest L2 tags");
			json(res, 200, { suggestions: [] });
		}
		return true;
	}

	if (method === "GET" && (url === "/api/l2/tags" || url.startsWith("/api/l2/tags?"))) {
		try {
			refreshTagIndex(l2DataDir);
			json(res, 200, { tags: listTags(l2DataDir) });
		} catch (err) {
			logger.warn({ err }, "failed to list L2 tags");
			json(res, 200, { tags: [] });
		}
		return true;
	}

	if (method === "GET" && url.startsWith("/api/wiki/page?")) {
		const params = new URL(url, "http://localhost").searchParams;
		const path = params.get("path");
		if (!path) {
			json(res, 400, { error: "Missing path parameter" });
			return true;
		}
		const fullPath = safeJoinReal(l2DataDir, path);
		if (!fullPath) {
			json(res, 400, { error: "Invalid wiki path" });
			return true;
		}
		if (!existsSync(fullPath)) {
			json(res, 404, { error: "Wiki page not found" });
			return true;
		}
		const content = readText(fullPath);
		json(res, 200, { path, content });
		return true;
	}

	if (method === "PUT" && url === "/api/wiki/page") {
		const body = (await readBody(req)) as Record<string, unknown>;
		const path = body.path as string | undefined;
		const content = body.content as string | undefined;
		if (!path || content === undefined) {
			json(res, 400, { error: "Missing path or content" });
			return true;
		}
		const fullPath = safeJoinReal(l2DataDir, path);
		if (!fullPath) {
			json(res, 400, { error: "Invalid wiki path" });
			return true;
		}
		writeText(fullPath, content);
		await getL2Memory(l2DataDir).indexPageByPath(path);
		json(res, 200, { path, saved: true });
		return true;
	}

	if (method === "PATCH" && url === "/api/wiki/page/tags") {
		const body = (await readBody(req)) as Record<string, unknown>;
		const path = typeof body.path === "string" ? body.path.trim() : "";
		const tags = Array.isArray(body.tags)
			? body.tags.filter((tag): tag is string => typeof tag === "string")
			: [];
		if (!path) {
			json(res, 400, { error: "Missing wiki path" });
			return true;
		}
		try {
			const updatedTags = updateWikiPageTags(l2DataDir, path, tags);
			await getL2Memory(l2DataDir).indexPageByPath(path);
			refreshTagIndex(l2DataDir);
			json(res, 200, { path, tags: updatedTags });
		} catch (err) {
			logger.warn({ err, path }, "failed to update wiki page tags");
			const message = err instanceof Error ? err.message : "Failed to update wiki tags";
			json(res, message === "Invalid wiki path" ? 400 : 404, { error: message });
		}
		return true;
	}

	if (method === "DELETE" && url.startsWith("/api/wiki/page?")) {
		const params = new URL(url, "http://localhost").searchParams;
		const path = params.get("path");
		if (!path) {
			json(res, 400, { error: "Missing path parameter" });
			return true;
		}
		const fullPath = safeJoinReal(l2DataDir, path);
		if (!fullPath) {
			json(res, 400, { error: "Invalid wiki path" });
			return true;
		}
		if (!existsSync(fullPath)) {
			json(res, 404, { error: "Wiki page not found" });
			return true;
		}
		try {
			rmSync(fullPath);
			removeWikiPathFromManifest(l2DataDir, path);
			await getL2Memory(l2DataDir).removePage(path);
			json(res, 200, { path, deleted: true });
		} catch (err) {
			logger.warn({ err }, "failed to delete wiki page");
			json(res, 500, { error: "Failed to delete wiki page" });
		}
		return true;
	}

	if (method === "GET" && url === "/api/wiki/graph") {
		try {
			json(res, 200, buildWikiGraph(l2DataDir));
		} catch (err) {
			logger.warn({ err }, "failed to build wiki graph");
			json(res, 200, { nodes: [], edges: [] });
		}
		return true;
	}

	if (method === "GET" && url === "/api/wiki/stats") {
		try {
			const entries = readManifest(l2DataDir);
			let totalSize = 0;
			let pageCount = 0;
			for (const wikiPath of listWikiPagePaths(l2DataDir)) {
				const fullPath = join(l2DataDir, wikiPath);
				if (existsSync(fullPath)) {
					totalSize += statSync(fullPath).size;
					pageCount++;
				}
			}
			json(res, 200, { pageCount, totalSize, entryCount: entries.length });
		} catch (err) {
			logger.warn({ err }, "failed to compute wiki stats");
			json(res, 200, { pageCount: 0, totalSize: 0, entryCount: 0 });
		}
		return true;
	}

	// --- L2 Raw Upload API ---
	if (method === "POST" && url === "/api/l2/raw/upload") {
		const body = (await readBody(req, { maxBytes: UPLOAD_MAX_BODY_BYTES })) as Record<string, unknown>;
		const fileName = typeof body.fileName === "string" ? body.fileName : "";
		const mimeType = typeof body.mimeType === "string" ? body.mimeType : "application/octet-stream";
		const dataBase64 = typeof body.dataBase64 === "string" ? body.dataBase64 : "";
		if (!fileName || !dataBase64) {
			json(res, 400, { error: "Missing fileName or dataBase64" });
			return true;
		}

		const dir = join(l2DataDir, "raw", "uploads");
		ensureDir(dir);
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		const safeName = sanitizeUploadedFileName(fileName, "upload");
		const ext = uploadExtension(safeName, mimeType);
		const base = basename(safeName, ext).slice(0, 80) || "upload";
		const outputName = `${timestamp}-${randomUUID().slice(0, 8)}-${base}${ext}`;
		const outputPath = safeJoinReal(dir, outputName);
		if (!outputPath) {
			json(res, 400, { error: "Invalid upload path" });
			return true;
		}
		const data = Buffer.from(dataBase64, "base64");
		writeFileSync(outputPath, data);
		const rawPath = join("raw", "uploads", outputName).replace(/\\/g, "/");
		json(res, 201, {
			fileName,
			mimeType,
			size: data.length,
			rawPath,
		});
		return true;
	}

	return false;
}
