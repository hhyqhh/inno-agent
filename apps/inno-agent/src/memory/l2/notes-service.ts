import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { basename } from "node:path";
import { logger } from "../../logger.js";
import { ensureDir, readText, writeText } from "../../storage/file-store.js";
import { resolveContainedPath } from "../../utils/path-safety.js";
import {
	extractNoteDraftTitle,
	parseNoteDraft,
	serializeNoteDraft,
	type NoteDraftFrontmatter,
} from "./note-frontmatter.js";

export interface NoteDraftSummary {
	noteId: string;
	rawPath: string;
	title: string;
	status: "draft";
	createdAt: string;
	updatedAt: string;
}

export interface NoteDraft extends NoteDraftSummary {
	content: string;
}

export interface DeleteNoteDraftResult {
	rawPath: string;
	title: string;
}

export class NoteDraftPathError extends Error {
	constructor() {
		super("Invalid note draft path");
		this.name = "NoteDraftPathError";
	}
}

export class NoteDraftNotFoundError extends Error {
	constructor() {
		super("Note draft not found");
		this.name = "NoteDraftNotFoundError";
	}
}

function draftFileName(title: string, noteId: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 40);
	return `${slug || "note"}-${noteId.slice(-8)}.md`;
}

function normalizeTitle(title: string | undefined): string {
	return title?.trim().slice(0, 200) || "Untitled Note";
}

function resolveNotesDir(l2DataDir: string): string {
	const notesDir = resolveContainedPath(l2DataDir, "raw/notes");
	if (!notesDir) throw new NoteDraftPathError();
	return notesDir;
}

function resolveDraftPath(l2DataDir: string, rawPath: string): { rawPath: string; filePath: string } {
	const normalized = rawPath.trim().replaceAll("\\", "/");
	if (!/^raw\/notes\/[^/]+\.md$/i.test(normalized)) throw new NoteDraftPathError();
	const filePath = resolveContainedPath(l2DataDir, normalized);
	if (!filePath) throw new NoteDraftPathError();
	return { rawPath: normalized, filePath };
}

function readDraftFile(l2DataDir: string, rawPath: string): NoteDraft {
	const resolved = resolveDraftPath(l2DataDir, rawPath);
	if (!existsSync(resolved.filePath)) throw new NoteDraftNotFoundError();
	const { frontmatter, body } = parseNoteDraft(readText(resolved.filePath));
	if (!frontmatter) throw new NoteDraftNotFoundError();
	const fallback = basename(resolved.rawPath, ".md");
	return {
		noteId: frontmatter.note_id,
		rawPath: resolved.rawPath,
		title: frontmatter.title || extractNoteDraftTitle(body, fallback),
		status: "draft",
		content: body,
		createdAt: frontmatter.created,
		updatedAt: frontmatter.updated,
	};
}

export function listL2NoteDrafts(l2DataDir: string): NoteDraftSummary[] {
	const notesDir = resolveNotesDir(l2DataDir);
	if (!existsSync(notesDir)) return [];
	const drafts: NoteDraftSummary[] = [];
	for (const name of readdirSync(notesDir)) {
		if (!name.toLowerCase().endsWith(".md")) continue;
		const rawPath = `raw/notes/${name}`;
		try {
			const { content: _content, ...summary } = readDraftFile(l2DataDir, rawPath);
			drafts.push(summary);
		} catch (err) {
			logger.warn({ err, rawPath }, "skipping invalid note draft");
		}
	}
	return drafts.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function readL2NoteDraft(l2DataDir: string, rawPath: string): NoteDraft {
	return readDraftFile(l2DataDir, rawPath);
}

export function createL2NoteDraft(
	l2DataDir: string,
	options: { title?: string; content?: string } = {},
): NoteDraft {
	const notesDir = resolveNotesDir(l2DataDir);
	ensureDir(notesDir);
	const title = normalizeTitle(options.title);
	const noteId = `note_${randomUUID().slice(0, 8)}`;
	const now = new Date().toISOString();
	const rawPath = `raw/notes/${draftFileName(title, noteId)}`;
	const { filePath } = resolveDraftPath(l2DataDir, rawPath);
	const frontmatter: NoteDraftFrontmatter = {
		note_id: noteId,
		title,
		status: "draft",
		created: now,
		updated: now,
	};
	const content = options.content ?? `# ${title}\n\n`;
	writeText(filePath, serializeNoteDraft(frontmatter, content));
	return { noteId, rawPath, title, status: "draft", content, createdAt: now, updatedAt: now };
}

export function saveL2NoteDraft(
	l2DataDir: string,
	rawPath: string,
	options: { title: string; content: string },
): NoteDraft {
	const current = readDraftFile(l2DataDir, rawPath);
	const resolved = resolveDraftPath(l2DataDir, rawPath);
	const title = normalizeTitle(options.title);
	const updatedAt = new Date().toISOString();
	const stat = statSync(resolved.filePath);
	const frontmatter: NoteDraftFrontmatter = {
		note_id: current.noteId,
		title,
		status: "draft",
		created: current.createdAt || stat.birthtime.toISOString(),
		updated: updatedAt,
	};
	writeText(resolved.filePath, serializeNoteDraft(frontmatter, options.content));
	return { ...current, title, content: options.content, updatedAt };
}

export function deleteL2NoteDraft(l2DataDir: string, rawPath: string): DeleteNoteDraftResult {
	const resolved = resolveDraftPath(l2DataDir, rawPath);
	const draft = readDraftFile(l2DataDir, rawPath);
	try {
		unlinkSync(resolved.filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new NoteDraftNotFoundError();
		throw error;
	}
	return { rawPath: resolved.rawPath, title: draft.title };
}
