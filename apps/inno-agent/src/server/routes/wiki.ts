import { randomUUID } from "node:crypto";
import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";
import {
	type BigIntStats,
	closeSync,
	existsSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	openSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseYaml } from "yaml";
import { wikiPathJoin } from "../../memory/l2/wiki-paths.js";
import { logger } from "../../logger.js";
import { getL2Memory } from "../../memory/l2/l2-memory.js";
import {
	EvidenceRefreshError,
	EvidenceRefreshService,
	type EvidenceMutationRequest,
} from "../../memory/l2/evidence-refresh-service.js";
import type { EvidenceCandidateSelector } from "../../memory/l2/evidence-selector.js";
import {
	getWikiPageWriteQueue,
	type WikiPageWriteQueue,
} from "../../memory/l2/wiki-page-write-queue.js";
import { readManifest, removeWikiPathFromManifest } from "../../memory/l2/manifest-store.js";
import {
	resolveWikiPageDetail,
	resolveWikiPageDetailFromContent,
	type WikiPageDetail,
} from "../../memory/l2/provenance-resolver.js";
import { buildWikiGraph } from "../../memory/l2/wiki-graph.js";
import { fileRevision, parseFrontmatter } from "../../memory/l2/wiki-maintainer.js";
import { ensureDir, readText } from "../../storage/file-store.js";
import { HttpError, json, readBody, UPLOAD_MAX_BODY_BYTES } from "../http-helpers.js";
import {
	resolveAllowedWikiPage,
	type AllowedWikiPagePath,
	type WikiPagePathIntent,
} from "../wiki-page-path.js";

export interface WikiRouteContext {
	l2DataDir: string;
	evidenceSelector?: EvidenceCandidateSelector | null;
	getEvidenceSelector?: () => EvidenceCandidateSelector | null;
	writeQueue?: WikiPageWriteQueue;
}

// ---------------------------------------------------------------------------
// Wiki listing helpers retained from the P2 route split. They take the data
// root explicitly and apply the same page-path boundary as CRUD routes.
// ---------------------------------------------------------------------------

const WIKI_PAGE_DIRS = ["sources", "entities", "concepts", "analysis"] as const;
const SAFE_SOURCE_ID = /^l2src_[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

interface ParsedEvidenceRefs {
	ok: boolean;
	value?: unknown;
	rawFrontmatter?: string;
}

interface SafeEvidenceIssue {
	ordinal: number;
	sourceId?: string;
	code: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function wikiError(
	res: ServerResponse,
	status: number,
	error: string,
	code: string,
	details?: unknown,
): void {
	json(res, status, { error, code, ...(details === undefined ? {} : { details }) });
}

class WikiMutationError extends Error {
	constructor(
		readonly status: number,
		readonly error: string,
		readonly code: string,
		readonly details?: unknown,
	) {
		super(error);
		this.name = "WikiMutationError";
	}
}

function exactObjectKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(value).sort();
	const sortedExpected = [...expected].sort();
	return keys.length === sortedExpected.length && keys.every((key, index) => key === sortedExpected[index]);
}

function parseEvidenceMutationRequest(value: unknown): EvidenceMutationRequest | null {
	if (!isRecord(value) || !exactObjectKeys(value, ["path", "expectedPageRevision", "expectedFileRevision"])) return null;
	if (
		typeof value.path !== "string"
		|| typeof value.expectedPageRevision !== "string"
		|| typeof value.expectedFileRevision !== "string"
	) return null;
	return {
		path: value.path,
		expectedPageRevision: value.expectedPageRevision,
		expectedFileRevision: value.expectedFileRevision,
	};
}

function createEvidenceRefreshService(
	ctx: WikiRouteContext,
	queue: WikiPageWriteQueue,
): EvidenceRefreshService {
	return new EvidenceRefreshService({
		l2DataDir: ctx.l2DataDir,
		selector: ctx.evidenceSelector,
		getSelector: ctx.getEvidenceSelector,
		queue,
		writePage: (resolved, content, expectedFileRevision) => {
			try {
				writeWikiPageAtomic(ctx.l2DataDir, resolved, content, expectedFileRevision);
			} catch (error) {
				if (error instanceof WikiPageChangedError) {
					throw new EvidenceRefreshError(
						"page_changed",
						"Wiki page changed while the evidence action was running.",
					);
				}
				throw error;
			}
		},
		indexPage: (path) => getL2Memory(ctx.l2DataDir).indexPageByPath(path),
	});
}

function parseRawEvidenceRefs(content: string): ParsedEvidenceRefs {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?/u);
	if (!match) return { ok: true, value: undefined };
	try {
		const parsed = parseYaml(match[1]) as unknown;
		return { ok: true, value: isRecord(parsed) ? parsed.evidence_refs : undefined };
	} catch {
		return { ok: false, rawFrontmatter: match[1] };
	}
}

function invalidEvidenceIssues(detail: WikiPageDetail): SafeEvidenceIssue[] {
	const issues: SafeEvidenceIssue[] = detail.provenance.referenceIssues.map((issue) => ({ ...issue }));
	let ordinal = 0;
	for (const group of detail.provenance.sourceGroups) {
		for (const reference of group.references) {
			if (reference.positionStatus !== "verified") {
				issues.push({
					ordinal,
					...(SAFE_SOURCE_ID.test(group.sourceId) ? { sourceId: group.sourceId } : {}),
					code: reference.reasonCodes[0] ?? reference.positionStatus,
				});
			}
			ordinal += 1;
		}
	}
	return issues;
}

function closeQuietly(descriptor: number | undefined): void {
	if (descriptor === undefined) return;
	try {
		closeSync(descriptor);
	} catch {
		// Preserve the original write error.
	}
}

interface FileIdentity {
	dev: bigint;
	ino: bigint;
}

interface FileSnapshot extends FileIdentity {
	size: bigint;
	mtimeNs: bigint;
	ctimeNs: bigint;
}

function identityOf(stats: BigIntStats): FileIdentity {
	return { dev: stats.dev, ino: stats.ino };
}

function snapshotOf(stats: BigIntStats): FileSnapshot {
	return {
		...identityOf(stats),
		size: stats.size,
		mtimeNs: stats.mtimeNs,
		ctimeNs: stats.ctimeNs,
	};
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
	return sameIdentity(left, right)
		&& left.size === right.size
		&& left.mtimeNs === right.mtimeNs
		&& left.ctimeNs === right.ctimeNs;
}

function sameFilesystemPath(left: string, right: string): boolean {
	return process.platform === "win32"
		? left.toLowerCase() === right.toLowerCase()
		: left === right;
}

function inspectPlainDirectory(path: string): FileIdentity | null {
	try {
		const stats = lstatSync(path, { bigint: true });
		if (stats.isSymbolicLink() || !stats.isDirectory()) return null;
		if (!sameFilesystemPath(path, realpathSync.native(path))) return null;
		return identityOf(stats);
	} catch {
		return null;
	}
}

function inspectPlainFile(path: string): FileSnapshot | null {
	try {
		const stats = lstatSync(path, { bigint: true });
		if (stats.isSymbolicLink() || !stats.isFile()) return null;
		if (!sameFilesystemPath(path, realpathSync.native(path))) return null;
		return snapshotOf(stats);
	} catch {
		return null;
	}
}

function requireSameFileSnapshot(path: string, expected: FileSnapshot): void {
	const current = inspectPlainFile(path);
	if (current === null || !sameSnapshot(current, expected)) {
		throw new Error("Wiki temporary file changed.");
	}
}

function requireSameResolvedPage(
	l2DataDir: string,
	relativePath: string,
	absolutePath: string,
	intent: WikiPagePathIntent,
): AllowedWikiPagePath {
	const current = resolveAllowedWikiPage(l2DataDir, relativePath, intent);
	if (
		current === null
		|| current.relativePath !== relativePath
		|| !sameFilesystemPath(current.absolutePath, absolutePath)
	) {
		throw new Error("Wiki page mutation boundary changed.");
	}
	return current;
}

function requireSameIdentity(path: string, expected: FileIdentity, kind: "directory" | "file"): void {
	const current = kind === "directory" ? inspectPlainDirectory(path) : inspectPlainFile(path);
	if (current === null || !sameIdentity(current, expected)) {
		throw new Error("Wiki page mutation target changed.");
	}
}

function cleanupOwnedTemporaryFile(
	temporaryPath: string,
	parentPath: string,
	parentIdentity: FileIdentity,
	temporarySnapshot: FileSnapshot,
): void {
	try {
		requireSameIdentity(parentPath, parentIdentity, "directory");
		requireSameFileSnapshot(temporaryPath, temporarySnapshot);
		unlinkSync(temporaryPath);
	} catch {
		// Leave any path whose ownership can no longer be proven untouched.
	}
}

class WikiPageChangedError extends Error {
	constructor() {
		super("Wiki page changed during publication.");
		this.name = "WikiPageChangedError";
	}
}

function requireExpectedWikiFileRevision(
	l2DataDir: string,
	resolved: AllowedWikiPagePath,
	expectedFileRevision: string,
): void {
	let descriptor: number | undefined;
	try {
		const rebound = requireSameResolvedPage(
			l2DataDir,
			resolved.relativePath,
			resolved.absolutePath,
			"write",
		);
		descriptor = openSync(rebound.absolutePath, "r");
		const opened = snapshotOf(fstatSync(descriptor, { bigint: true }));
		const pathBefore = inspectPlainFile(rebound.absolutePath);
		if (pathBefore === null || !sameSnapshot(opened, pathBefore)) throw new WikiPageChangedError();
		const bytes = readFileSync(descriptor);
		const after = snapshotOf(fstatSync(descriptor, { bigint: true }));
		const pathAfter = inspectPlainFile(rebound.absolutePath);
		if (
			pathAfter === null
			|| !sameSnapshot(opened, after)
			|| !sameSnapshot(after, pathAfter)
			|| fileRevision(bytes) !== expectedFileRevision
		) {
			throw new WikiPageChangedError();
		}
	} catch (error) {
		if (error instanceof WikiPageChangedError) throw error;
		throw new WikiPageChangedError();
	} finally {
		closeQuietly(descriptor);
	}
}

function writeWikiPageAtomic(
	l2DataDir: string,
	resolved: AllowedWikiPagePath,
	content: string,
	expectedFileRevision?: string,
): void {
	const current = requireSameResolvedPage(
		l2DataDir,
		resolved.relativePath,
		resolved.absolutePath,
		"write",
	);
	const filePath = current.absolutePath;
	const parentPath = dirname(filePath);
	const parentIdentity = inspectPlainDirectory(parentPath);
	if (parentIdentity === null) throw new Error("Wiki page parent is not a plain directory.");
	const temporaryPath = join(
		parentPath,
		`.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
	);
	const bytes = Buffer.from(content, "utf8");
	let descriptor: number | undefined;
	let temporarySnapshot: FileSnapshot | undefined;
	let published = false;
	try {
		descriptor = openSync(temporaryPath, "wx", 0o600);
		const descriptorStats = fstatSync(descriptor, { bigint: true });
		if (!descriptorStats.isFile()) throw new Error("Wiki temporary path is not a file.");
		temporarySnapshot = snapshotOf(descriptorStats);
		requireSameIdentity(parentPath, parentIdentity, "directory");
		requireSameFileSnapshot(temporaryPath, temporarySnapshot);
		let offset = 0;
		while (offset < bytes.length) {
			const written = writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
			if (written <= 0) throw new Error("Failed to write Wiki page bytes.");
			offset += written;
		}
		fsyncSync(descriptor);
		const writtenStats = fstatSync(descriptor, { bigint: true });
		if (!writtenStats.isFile()) throw new Error("Wiki temporary path is not a file.");
		temporarySnapshot = snapshotOf(writtenStats);
		requireSameFileSnapshot(temporaryPath, temporarySnapshot);
		const descriptorToClose = descriptor;
		descriptor = undefined;
		closeSync(descriptorToClose);
		if (expectedFileRevision !== undefined) {
			requireExpectedWikiFileRevision(l2DataDir, resolved, expectedFileRevision);
		}
		requireSameResolvedPage(l2DataDir, resolved.relativePath, filePath, "write");
		requireSameIdentity(parentPath, parentIdentity, "directory");
		requireSameFileSnapshot(temporaryPath, temporarySnapshot);
		renameSync(temporaryPath, filePath);
		published = true;
	} finally {
		if (descriptor !== undefined) {
			try {
				const currentStats = fstatSync(descriptor, { bigint: true });
				if (currentStats.isFile()) temporarySnapshot = snapshotOf(currentStats);
			} catch {
				// Without a descriptor snapshot, pathname cleanup must fail closed.
			}
		}
		closeQuietly(descriptor);
		if (temporarySnapshot !== undefined && !published) {
			cleanupOwnedTemporaryFile(temporaryPath, parentPath, parentIdentity, temporarySnapshot);
		}
	}
}

function deleteWikiPageSafely(l2DataDir: string, resolved: AllowedWikiPagePath): void {
	const current = requireSameResolvedPage(
		l2DataDir,
		resolved.relativePath,
		resolved.absolutePath,
		"delete",
	);
	const parentPath = dirname(current.absolutePath);
	const parentIdentity = inspectPlainDirectory(parentPath);
	const pageIdentity = inspectPlainFile(current.absolutePath);
	if (parentIdentity === null || pageIdentity === null) {
		throw new Error("Wiki page delete target is not a plain file.");
	}
	requireSameResolvedPage(l2DataDir, resolved.relativePath, current.absolutePath, "delete");
	requireSameIdentity(parentPath, parentIdentity, "directory");
	requireSameIdentity(current.absolutePath, pageIdentity, "file");
	unlinkSync(current.absolutePath);
}

function listWikiPagePaths(l2DataDir: string): string[] {
	const paths: string[] = [];
	for (const dirName of WIKI_PAGE_DIRS) {
		const probe = resolveAllowedWikiPage(l2DataDir, `wiki/${dirName}/.__list_probe__.md`, "read");
		if (probe === null) continue;
		const directory = dirname(probe.absolutePath);
		if (!existsSync(directory)) continue;
		for (const file of readdirSync(directory)) {
			const wikiPath = wikiPathJoin("wiki", dirName, file);
			const resolved = resolveAllowedWikiPage(l2DataDir, wikiPath, "read");
			if (resolved !== null && existsSync(resolved.absolutePath)) paths.push(resolved.relativePath);
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

function sanitizeUploadName(name: string): string {
	const cleaned = name
		.replace(/[/\\?%*:|"<>]/g, "-")
		.replace(/\s+/g, " ")
		.trim();
	return cleaned || "upload";
}

function uploadExtension(fileName: string, mimeType: string): string {
	const ext = extname(fileName);
	if (ext) return ext;
	if (mimeType === "application/pdf") return ".pdf";
	if (mimeType.includes("wordprocessingml")) return ".docx";
	if (mimeType.includes("spreadsheetml")) return ".xlsx";
	if (mimeType.includes("presentationml")) return ".pptx";
	if (mimeType === "text/markdown") return ".md";
	if (mimeType.startsWith("image/")) return `.${mimeType.slice("image/".length).replace("jpeg", "jpg")}`;
	if (mimeType.startsWith("text/")) return ".txt";
	return ".bin";
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
	const writeQueue = ctx.writeQueue ?? getWikiPageWriteQueue(l2DataDir);

	// --- Wiki API ---
	if (method === "GET" && url === "/api/wiki/pages") {
		try {
			const sourceIds = manifestSourceIdByWikiPath(l2DataDir);
			const pages: unknown[] = [];
			for (const wikiPath of listWikiPagePaths(l2DataDir)) {
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

	if (method === "GET" && url.startsWith("/api/wiki/page?")) {
		const params = new URL(url, "http://localhost").searchParams;
		const path = params.get("path");
		if (!path) {
			wikiError(res, 400, "Missing path parameter", "invalid_request");
			return true;
		}
		const resolved = resolveAllowedWikiPage(l2DataDir, path, "read");
		if (resolved === null) {
			wikiError(res, 400, "Invalid wiki path", "invalid_wiki_path");
			return true;
		}
		if (!existsSync(resolved.absolutePath)) {
			wikiError(res, 404, "Wiki page not found", "wiki_page_not_found");
			return true;
		}
		try {
			json(res, 200, resolveWikiPageDetail(l2DataDir, resolved.relativePath));
		} catch (err) {
			logger.warn({ err }, "failed to read wiki page detail");
			wikiError(res, 500, "Failed to read wiki page", "wiki_page_read_failed");
		}
		return true;
	}

	if (
		method === "POST"
		&& (url === "/api/wiki/page/evidence/refresh" || url === "/api/wiki/page/evidence/remove-stale")
	) {
		let body: unknown;
		try {
			body = await readBody(req);
		} catch (error) {
			if (error instanceof HttpError) {
				if (error.statusCode === 413) res.setHeader("Connection", "close");
				wikiError(
					res,
					error.statusCode,
					error.message,
					error.statusCode === 413 ? "request_too_large" : "invalid_request",
				);
				return true;
			}
			throw error;
		}
		const mutation = parseEvidenceMutationRequest(body);
		if (!mutation) {
			wikiError(res, 400, "Invalid evidence mutation request", "invalid_request");
			return true;
		}
		try {
			const service = createEvidenceRefreshService(ctx, writeQueue);
			const detail = url.endsWith("/refresh")
				? await service.refresh(mutation)
				: await service.removeStale(mutation);
			json(res, 200, detail);
		} catch (error) {
			if (error instanceof EvidenceRefreshError) {
				wikiError(res, error.status, error.message, error.code);
			} else {
				logger.warn({ err: error }, "failed to mutate Wiki evidence references");
				wikiError(res, 500, "Failed to update evidence references", "wiki_page_write_failed");
			}
		}
		return true;
	}

	if (method === "PUT" && url === "/api/wiki/page") {
		const body = await readBody(req);
		if (!isRecord(body) || typeof body.path !== "string" || body.path.length === 0 || typeof body.content !== "string") {
			wikiError(res, 400, "Missing path or content", "invalid_request");
			return true;
		}
		const putBody = body as { path: string; content: string };
		const resolved = resolveAllowedWikiPage(l2DataDir, putBody.path, "write");
		if (resolved === null) {
			wikiError(res, 400, "Invalid wiki path", "invalid_wiki_path");
			return true;
		}

		try {
			const detail = await writeQueue.run(resolved.relativePath, async () => {
				let previousContent: string | undefined;
				try {
					previousContent = existsSync(resolved.absolutePath) ? readText(resolved.absolutePath) : undefined;
				} catch {
					throw new WikiMutationError(500, "Failed to save wiki page", "wiki_page_write_failed");
				}

				const previousRefs = previousContent === undefined
					? { ok: true, value: undefined }
					: parseRawEvidenceRefs(previousContent);
				const nextRefs = parseRawEvidenceRefs(putBody.content);
				const unchangedMalformedFrontmatter = !previousRefs.ok
					&& !nextRefs.ok
					&& previousRefs.rawFrontmatter === nextRefs.rawFrontmatter;
				if (!nextRefs.ok && !unchangedMalformedFrontmatter) {
					throw new WikiMutationError(422, "Invalid evidence references", "invalid_evidence_refs", {
						issues: [{ ordinal: 0, code: "invalid-frontmatter" }],
					});
				}

				const refsChanged = !unchangedMalformedFrontmatter
					&& (!previousRefs.ok || !isDeepStrictEqual(previousRefs.value, nextRefs.value));
				if (refsChanged) {
					let prospective: WikiPageDetail;
					try {
						prospective = resolveWikiPageDetailFromContent(l2DataDir, resolved.relativePath, putBody.content);
					} catch {
						throw new WikiMutationError(422, "Invalid evidence references", "invalid_evidence_refs", {
							issues: [{ ordinal: 0, code: "validation-failed" }],
						});
					}
					const issues = invalidEvidenceIssues(prospective);
					if (issues.length > 0) {
						throw new WikiMutationError(422, "Invalid evidence references", "invalid_evidence_refs", { issues });
					}
				}

				try {
					writeWikiPageAtomic(l2DataDir, resolved, putBody.content);
					await getL2Memory(l2DataDir).indexPageByPath(resolved.relativePath);
					return resolveWikiPageDetail(l2DataDir, resolved.relativePath);
				} catch (error) {
					if (error instanceof WikiMutationError) throw error;
					throw new WikiMutationError(500, "Failed to save wiki page", "wiki_page_write_failed");
				}
			});
			json(res, 200, detail);
		} catch (err) {
			if (err instanceof WikiMutationError) {
				wikiError(res, err.status, err.error, err.code, err.details);
			} else {
				logger.warn({ err }, "failed to save wiki page");
				wikiError(res, 500, "Failed to save wiki page", "wiki_page_write_failed");
			}
		}
		return true;
	}

	if (method === "DELETE" && url.startsWith("/api/wiki/page?")) {
		const params = new URL(url, "http://localhost").searchParams;
		const path = params.get("path");
		if (!path) {
			wikiError(res, 400, "Missing path parameter", "invalid_request");
			return true;
		}
		const resolved = resolveAllowedWikiPage(l2DataDir, path, "delete");
		if (resolved === null) {
			wikiError(res, 400, "Invalid wiki path", "invalid_wiki_path");
			return true;
		}
		try {
			const result = await writeQueue.run(resolved.relativePath, async () => {
				const current = resolveAllowedWikiPage(l2DataDir, resolved.relativePath, "delete");
				if (current === null) {
					throw new WikiMutationError(400, "Invalid wiki path", "invalid_wiki_path");
				}
				if (!existsSync(current.absolutePath)) {
					throw new WikiMutationError(404, "Wiki page not found", "wiki_page_not_found");
				}
				deleteWikiPageSafely(l2DataDir, current);
				removeWikiPathFromManifest(l2DataDir, current.relativePath);
				await getL2Memory(l2DataDir).removePage(current.relativePath);
				return { path: current.relativePath, deleted: true };
			});
			json(res, 200, result);
		} catch (err) {
			if (err instanceof WikiMutationError) {
				wikiError(res, err.status, err.error, err.code, err.details);
			} else {
				logger.warn({ err }, "failed to delete wiki page");
				wikiError(res, 500, "Failed to delete wiki page", "wiki_page_delete_failed");
			}
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
		const safeName = sanitizeUploadName(fileName);
		const ext = uploadExtension(safeName, mimeType);
		const base = basename(safeName, ext).slice(0, 80) || "upload";
		const outputName = `${timestamp}-${base}${ext}`;
		const outputPath = join(dir, outputName);
		const data = Buffer.from(dataBase64, "base64");
		writeFileSync(outputPath, data);
		const rawPath = join("raw", "uploads", outputName);
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
