import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";
import { basename, extname, join } from "node:path";

import {
	deleteNoteAttachment,
	listNoteAttachments,
	uploadNoteAttachment,
} from "../../memory/l2/note-attachments-service.js";
import {
	archiveL2NotebookItem,
	createL2Note,
	deleteL2NotebookItem,
	listL2Notes,
	readNoteContent,
	saveL2NoteContent,
} from "../../memory/l2/notes-service.js";
import { listNoteTemplates } from "../../memory/l2/note-templates.js";
import { unarchiveL2NotebookItem } from "../../memory/l2/notebook-unarchive-service.js";
import {
	listL2Sources,
	readRawTextPreview,
	regenerateL2Source,
	saveRawMarkdownContent,
} from "../../memory/l2/sources-service.js";
import type { L2Memory } from "../../memory/l2/l2-memory.js";
import { logger } from "../../logger.js";
import { safeJoinReal } from "../file-helpers.js";
import { json, matchRoute, readBody, UPLOAD_MAX_BODY_BYTES } from "../http-helpers.js";

export interface NotebookRouteContext {
	l2DataDir: string;
	codeDir: string;
	getArchiveRuntime: () => { model?: Model<any>; modelRegistry?: ModelRegistry; memory?: L2Memory };
}

interface ResolvedL2Path {
	fullPath: string;
	rawPath: string;
}

function resolveRawPath(l2DataDir: string, userPath: string): ResolvedL2Path | null {
	const rawPath = userPath.replace(/\\/g, "/");
	if (!rawPath.startsWith("raw/") || rawPath === "raw/") return null;
	const fullPath = safeJoinReal(join(l2DataDir, "raw"), rawPath.slice("raw/".length));
	return fullPath ? { fullPath, rawPath } : null;
}

function resolveNotePath(l2DataDir: string, userPath: string): ResolvedL2Path | null {
	const rawPath = userPath.replace(/\\/g, "/");
	if (!rawPath.startsWith("raw/notes/") || rawPath === "raw/notes/") return null;
	const relativePath = rawPath.slice("raw/notes/".length);
	if (relativePath.includes("/") || !relativePath.toLowerCase().endsWith(".md")) return null;
	const fullPath = safeJoinReal(join(l2DataDir, "raw", "notes"), relativePath);
	return fullPath ? { fullPath, rawPath } : null;
}

function isFile(filePath: string): boolean {
	try {
		return existsSync(filePath) && statSync(filePath).isFile();
	} catch {
		return false;
	}
}

function errorMessage(err: unknown, fallback: string): string {
	return err instanceof Error ? err.message : fallback;
}

function rawFileMime(filePath: string): string {
	const ext = extname(filePath).toLowerCase();
	if (ext === ".pdf") return "application/pdf";
	if (ext === ".png") return "image/png";
	if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
	if (ext === ".gif") return "image/gif";
	if (ext === ".webp") return "image/webp";
	return "application/octet-stream";
}

/** Handle Notebook notes, sources, raw previews, and note attachments. */
export async function handleNotebookRoutes(
	req: HttpReq,
	res: ServerResponse,
	method: string,
	url: string,
	ctx: NotebookRouteContext,
): Promise<boolean> {
	const { l2DataDir, codeDir } = ctx;

	if (method === "GET" && url === "/api/l2/sources") {
		try {
			json(res, 200, listL2Sources(l2DataDir));
		} catch (err) {
			logger.warn({ err }, "failed to list L2 sources");
			json(res, 500, { error: "Failed to list sources" });
		}
		return true;
	}

	if (method === "GET" && url.startsWith("/api/l2/raw/content?")) {
		const params = new URL(url, "http://localhost").searchParams;
		const rawPath = params.get("path");
		const full = params.get("full") === "1";
		if (!rawPath) {
			json(res, 400, { error: "Missing path parameter" });
			return true;
		}
		const resolved = resolveRawPath(l2DataDir, rawPath);
		if (!resolved) {
			json(res, 400, { error: "Invalid raw path" });
			return true;
		}
		if (!isFile(resolved.fullPath)) {
			json(res, 404, { error: "Raw file not found" });
			return true;
		}
		try {
			json(res, 200, {
				path: resolved.rawPath,
				content: readRawTextPreview(l2DataDir, resolved.rawPath, full ? Number.MAX_SAFE_INTEGER : undefined),
			});
		} catch (err) {
			logger.warn({ err, rawPath: resolved.rawPath }, "failed to read raw content");
			json(res, 500, { error: "Failed to read raw content" });
		}
		return true;
	}

	if (method === "PUT" && url === "/api/l2/raw/content") {
		const body = await readBody(req) as Record<string, unknown>;
		const rawPath = typeof body.rawPath === "string" ? body.rawPath.trim() : "";
		const hasContent = typeof body.content === "string";
		if (!rawPath || !hasContent) {
			json(res, 400, { error: "Missing rawPath or content" });
			return true;
		}
		const resolved = resolveRawPath(l2DataDir, rawPath);
		if (!resolved) {
			json(res, 400, { error: "Invalid raw path" });
			return true;
		}
		if (!isFile(resolved.fullPath)) {
			json(res, 404, { error: "Raw file not found" });
			return true;
		}
		try {
			json(res, 200, saveRawMarkdownContent(l2DataDir, resolved.rawPath, body.content as string));
		} catch (err) {
			logger.warn({ err, rawPath: resolved.rawPath }, "failed to save raw Markdown");
			json(res, 500, { error: errorMessage(err, "Save raw Markdown failed") });
		}
		return true;
	}

	if (method === "GET" && url.startsWith("/api/l2/raw/file?")) {
		const rawPath = new URL(url, "http://localhost").searchParams.get("path");
		if (!rawPath) {
			json(res, 400, { error: "Missing path parameter" });
			return true;
		}
		const resolved = resolveRawPath(l2DataDir, rawPath);
		if (!resolved) {
			json(res, 400, { error: "Invalid raw path" });
			return true;
		}
		if (!isFile(resolved.fullPath)) {
			json(res, 404, { error: "Raw file not found" });
			return true;
		}
		const name = basename(resolved.fullPath);
		const mimeType = rawFileMime(resolved.fullPath);
		const disposition = mimeType === "application/octet-stream" ? "attachment" : "inline";
		const asciiName = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
		const fileSize = statSync(resolved.fullPath).size;
		const stream = createReadStream(resolved.fullPath);
		stream.on("error", (err) => {
			logger.warn({ err, rawPath: resolved.rawPath }, "failed to stream raw file");
			if (!res.headersSent) json(res, 500, { error: "Failed to read raw file" });
			else res.destroy(err);
		});
		res.writeHead(200, {
			"Content-Type": mimeType,
			"Content-Disposition": `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(name)}`,
			"Content-Length": fileSize,
			"X-Content-Type-Options": "nosniff",
		});
		stream.pipe(res);
		return true;
	}

	if (method === "GET" && url.startsWith("/api/l2/notes/content?")) {
		const rawPath = new URL(url, "http://localhost").searchParams.get("path");
		if (!rawPath) {
			json(res, 400, { error: "Missing path parameter" });
			return true;
		}
		const resolved = resolveNotePath(l2DataDir, rawPath);
		if (!resolved) {
			json(res, 400, { error: "Invalid note path" });
			return true;
		}
		if (!isFile(resolved.fullPath)) {
			json(res, 404, { error: "Note not found" });
			return true;
		}
		try {
			json(res, 200, readNoteContent(l2DataDir, resolved.rawPath));
		} catch (err) {
			logger.warn({ err, rawPath: resolved.rawPath }, "failed to read note content");
			json(res, 500, { error: errorMessage(err, "Failed to read note") });
		}
		return true;
	}

	if (method === "GET" && url === "/api/l2/notes/templates") {
		try {
			json(res, 200, { templates: listNoteTemplates(codeDir) });
		} catch (err) {
			logger.warn({ err }, "failed to list note templates");
			json(res, 500, { error: "Failed to list templates" });
		}
		return true;
	}

	if (method === "GET" && (url === "/api/l2/notes" || url.startsWith("/api/l2/notes?"))) {
		const params = new URL(url, "http://localhost").searchParams;
		const status = params.get("status") ?? undefined;
		const notebookType = params.get("notebookType") ?? undefined;
		const validNotebookTypes = new Set(["conversation", "file", "note"]);
		try {
			json(res, 200, listL2Notes(l2DataDir, {
				status,
				notebookType:
					notebookType && validNotebookTypes.has(notebookType)
						? (notebookType as "conversation" | "file" | "note")
						: undefined,
			}));
		} catch (err) {
			logger.warn({ err }, "failed to list L2 notes");
			json(res, 500, { error: "Failed to list notes" });
		}
		return true;
	}

	if (method === "POST" && url === "/api/l2/notes") {
		const body = (await readBody(req)) as Record<string, unknown>;
		const title = typeof body.title === "string" ? body.title.trim() : undefined;
		const templateId = typeof body.templateId === "string" ? body.templateId.trim() : undefined;
		const content = typeof body.content === "string" ? body.content : undefined;
		const tags = Array.isArray(body.tags) ? body.tags.filter((tag): tag is string => typeof tag === "string") : undefined;
		try {
			json(res, 201, createL2Note(l2DataDir, codeDir, { title, templateId, tags, content }));
		} catch (err) {
			logger.warn({ err }, "failed to create note");
			json(res, 500, { error: errorMessage(err, "Create note failed") });
		}
		return true;
	}

	if (method === "PUT" && url === "/api/l2/notes/content") {
		const body = (await readBody(req)) as Record<string, unknown>;
		const rawPath = typeof body.rawPath === "string" ? body.rawPath.trim() : "";
		const title = typeof body.title === "string" ? body.title.trim() : "";
		const hasContent = typeof body.content === "string";
		const content = hasContent ? (body.content as string) : "";
		const tags = Array.isArray(body.tags) ? body.tags.filter((tag): tag is string => typeof tag === "string") : undefined;
		const recordDate = typeof body.recordDate === "string" ? body.recordDate.trim() : undefined;
		if (!rawPath || !title || !hasContent) {
			json(res, 400, { error: "Missing rawPath, title, or content" });
			return true;
		}
		const resolved = resolveNotePath(l2DataDir, rawPath);
		if (!resolved) {
			json(res, 400, { error: "Invalid note path" });
			return true;
		}
		if (!isFile(resolved.fullPath)) {
			json(res, 404, { error: "Note not found" });
			return true;
		}
		try {
			json(res, 200, saveL2NoteContent(l2DataDir, resolved.rawPath, { title, tags, recordDate, content }));
		} catch (err) {
			logger.warn({ err, rawPath: resolved.rawPath }, "failed to save note");
			json(res, 500, { error: errorMessage(err, "Save note failed") });
		}
		return true;
	}

	if (method === "GET" && url.startsWith("/api/l2/notes/attachments?")) {
		const rawPath = new URL(url, "http://localhost").searchParams.get("path");
		if (!rawPath) {
			json(res, 400, { error: "Missing path parameter" });
			return true;
		}
		const resolved = resolveNotePath(l2DataDir, rawPath);
		if (!resolved) {
			json(res, 400, { error: "Invalid note path" });
			return true;
		}
		try {
			json(res, 200, { attachments: listNoteAttachments(l2DataDir, resolved.rawPath) });
		} catch (err) {
			logger.warn({ err, rawPath: resolved.rawPath }, "failed to list note attachments");
			json(res, 500, { error: errorMessage(err, "Failed to list attachments") });
		}
		return true;
	}

	if (method === "POST" && url === "/api/l2/notes/attachments") {
		const body = (await readBody(req, { maxBytes: UPLOAD_MAX_BODY_BYTES })) as Record<string, unknown>;
		const noteRawPath = typeof body.noteRawPath === "string" ? body.noteRawPath.trim() : "";
		const fileName = typeof body.fileName === "string" ? body.fileName.trim() : "";
		const mimeType = typeof body.mimeType === "string" ? body.mimeType : "application/octet-stream";
		const dataBase64 = typeof body.dataBase64 === "string" ? body.dataBase64 : "";
		if (!noteRawPath || !fileName || !dataBase64) {
			json(res, 400, { error: "Missing noteRawPath, fileName, or dataBase64" });
			return true;
		}
		const resolved = resolveNotePath(l2DataDir, noteRawPath);
		if (!resolved) {
			json(res, 400, { error: "Invalid note path" });
			return true;
		}
		if (!isFile(resolved.fullPath)) {
			json(res, 404, { error: "Note not found" });
			return true;
		}
		try {
			const attachment = uploadNoteAttachment(l2DataDir, resolved.rawPath, { fileName, mimeType, dataBase64 });
			json(res, 201, {
				attachmentId: attachment.id,
				filePath: attachment.filePath,
				status: attachment.status,
				attachment,
			});
		} catch (err) {
			logger.warn({ err, noteRawPath: resolved.rawPath }, "failed to upload note attachment");
			json(res, 500, { error: errorMessage(err, "Upload attachment failed") });
		}
		return true;
	}

	const deleteAttachmentMatch = matchRoute("DELETE", method, url, "/api/l2/notes/attachments/:attachmentId");
	if (deleteAttachmentMatch) {
		const attachmentId = deleteAttachmentMatch.attachmentId.trim();
		if (!attachmentId) {
			json(res, 400, { error: "Missing attachment id" });
			return true;
		}
		try {
			const removed = deleteNoteAttachment(l2DataDir, attachmentId);
			json(res, 200, { attachmentId: removed.id });
		} catch (err) {
			logger.warn({ err, attachmentId }, "failed to delete note attachment");
			const message = errorMessage(err, "Delete attachment failed");
			json(res, message.includes("not found") ? 404 : 500, { error: message });
		}
		return true;
	}

	if (method === "DELETE" && url.startsWith("/api/l2/notes?")) {
		const rawPath = new URL(url, "http://localhost").searchParams.get("path");
		if (!rawPath) {
			json(res, 400, { error: "Missing path" });
			return true;
		}
		const resolved = resolveRawPath(l2DataDir, rawPath);
		if (!resolved) {
			json(res, 400, { error: "Invalid raw path" });
			return true;
		}
		try {
			json(res, 200, deleteL2NotebookItem(l2DataDir, resolved.rawPath));
		} catch (err) {
			logger.warn({ err, rawPath: resolved.rawPath }, "failed to delete notebook item");
			const message = errorMessage(err, "Delete failed");
			json(res, message.includes("文件不存在") ? 404 : 409, { error: message });
		}
		return true;
	}

	if (method === "POST" && url === "/api/l2/notes/unarchive") {
		const body = await readBody(req) as Record<string, unknown>;
		const rawPath = typeof body.rawPath === "string" ? body.rawPath.trim() : "";
		if (!rawPath) {
			json(res, 400, { error: "Missing rawPath" });
			return true;
		}
		const resolved = resolveRawPath(l2DataDir, rawPath);
		if (!resolved) {
			json(res, 400, { error: "Invalid raw path" });
			return true;
		}
		if (!isFile(resolved.fullPath)) {
			json(res, 404, { error: "Raw file not found" });
			return true;
		}
		try {
			const runtime = ctx.getArchiveRuntime();
			const result = await unarchiveL2NotebookItem(l2DataDir, resolved.rawPath, runtime);
			json(res, 200, result);
		} catch (err) {
			logger.warn({ err, rawPath: resolved.rawPath }, "failed to unarchive notebook item");
			const message = errorMessage(err, "Unarchive failed");
			json(res, message.includes("未归档") ? 409 : 500, { error: message });
		}
		return true;
	}

	if (method === "POST" && url === "/api/l2/sources/regenerate") {
		const body = (await readBody(req)) as Record<string, unknown>;
		const sourceId = typeof body.sourceId === "string" ? body.sourceId.trim() : "";
		if (!sourceId) {
			json(res, 400, { error: "Missing sourceId" });
			return true;
		}
		try {
			const result = await regenerateL2Source(l2DataDir, sourceId, ctx.getArchiveRuntime());
			json(res, 200, result);
		} catch (err) {
			logger.warn({ err, sourceId }, "failed to regenerate L2 source");
			const message = errorMessage(err, "Source regeneration failed");
			json(res, message.startsWith("Source not found:") ? 404 : 500, { error: message });
		}
		return true;
	}

	if (method === "POST" && (url === "/api/l2/notes/archive" || url === "/api/l2/sources/archive")) {
		const body = (await readBody(req)) as Record<string, unknown>;
		const rawPath = typeof body.rawPath === "string" ? body.rawPath.trim() : "";
		const title = typeof body.title === "string" ? body.title.trim() : undefined;
		const tags = Array.isArray(body.tags) ? body.tags.filter((tag): tag is string => typeof tag === "string") : undefined;
		if (!rawPath) {
			json(res, 400, { error: "Missing rawPath" });
			return true;
		}
		const resolved = resolveRawPath(l2DataDir, rawPath);
		if (!resolved) {
			json(res, 400, { error: "Invalid raw path" });
			return true;
		}
		if (!isFile(resolved.fullPath)) {
			json(res, 404, { error: "Raw file not found" });
			return true;
		}
		try {
			const runtime = ctx.getArchiveRuntime();
			const result = await archiveL2NotebookItem(l2DataDir, resolved.rawPath, {
				title,
				tags,
				model: runtime.model,
				modelRegistry: runtime.modelRegistry,
				memory: runtime.memory,
			});
			json(res, 201, result);
		} catch (err) {
			const isNoteRoute = url === "/api/l2/notes/archive";
			logger.warn({ err, rawPath: resolved.rawPath }, isNoteRoute ? "failed to archive note" : "failed to archive raw file");
			json(res, 500, { error: errorMessage(err, isNoteRoute ? "Archive note failed" : "Archive failed") });
		}
		return true;
	}

	return false;
}
