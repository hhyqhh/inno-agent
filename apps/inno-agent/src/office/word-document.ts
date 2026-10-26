import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname } from "node:path";
import { resolveContainedPathAsync } from "../utils/path-safety.js";

export const WORD_MAX_BYTES = 32 * 1024 * 1024;
export const WORD_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export class WordEditorError extends Error {
	constructor(public readonly code: string, public readonly statusCode = 400) { super(code); }
}
const versionOf = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Sole owner of browser DOCX writes. The browser owns its draft; no editor sidecar is needed. */
export class WordDocumentService {
	private pending: Promise<unknown> = Promise.resolve();
	constructor(private readonly dataDir: string, private readonly resolveWorkspace: (id: string) => Promise<string | null>) {}
	private async filePath(workspaceId: string, path: string): Promise<string> {
		const normalized = path.replaceAll("\\", "/");
		if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) throw new WordEditorError("WORD_EDITOR_INVALID_PATH", 403);
		if (extname(normalized).toLowerCase() !== ".docx") throw new WordEditorError("WORD_EDITOR_DOCX_REQUIRED", 415);
		const root = await this.resolveWorkspace(workspaceId);
		if (!root) throw new WordEditorError("WORD_EDITOR_FILE_MISSING", 404);
		const resolved = await resolveContainedPathAsync(root, normalized);
		if (!resolved) throw new WordEditorError("WORD_EDITOR_INVALID_PATH", 403);
		return resolved;
	}
	private async read(path: string): Promise<Buffer> {
		const info = await stat(path).catch(() => null);
		if (!info?.isFile()) throw new WordEditorError("WORD_EDITOR_FILE_MISSING", 404);
		if (info.size > WORD_MAX_BYTES) throw new WordEditorError("WORD_EDITOR_TOO_LARGE", 413);
		const bytes = await readFile(path);
		this.validate(bytes);
		return bytes;
	}
	private validate(bytes: Buffer): void {
		if (bytes.length > WORD_MAX_BYTES) throw new WordEditorError("WORD_EDITOR_TOO_LARGE", 413);
		if (bytes.subarray(0, 4).toString("hex") !== "504b0304") throw new WordEditorError("WORD_EDITOR_INVALID_DOCUMENT", 422);
	}
	async open(workspaceId: string, path: string) {
		const bytes = await this.read(await this.filePath(workspaceId, path));
		return { bytes, version: versionOf(bytes) };
	}
	async save(workspaceId: string, path: string, version: string, bytes: Buffer) {
		this.validate(bytes);
		if (!/^[a-f0-9]{64}$/.test(version)) throw new WordEditorError("WORD_EDITOR_VERSION_REQUIRED", 428);
		const operation = this.pending.then(async () => {
			const file = await this.filePath(workspaceId, path);
			const original = await this.read(file);
			const currentVersion = versionOf(original);
			const nextVersion = versionOf(bytes);
			// A native app or an agent can change the file while this browser holds a draft.
			// Compare content, not mtime; an identical retry after a lost response is safe.
			if (currentVersion !== version && currentVersion !== nextVersion) throw new WordEditorError("WORD_EDITOR_CONFLICT", 409);
			if (currentVersion !== nextVersion) {
				const backup = await resolveContainedPathAsync(this.dataDir, `office/originals/${currentVersion}.docx`);
				if (!backup) throw new WordEditorError("WORD_EDITOR_INVALID_PATH", 403);
				await mkdir(dirname(backup), { recursive: true });
				await writeFile(backup, original, { flag: "wx", mode: 0o600 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
				const temporary = await resolveContainedPathAsync(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
				if (!temporary) throw new WordEditorError("WORD_EDITOR_INVALID_PATH", 403);
				try {
					await writeFile(temporary, bytes, { flag: "wx", mode: (await stat(file)).mode });
					await rename(temporary, file);
				} finally { await rm(temporary, { force: true }); }
			}
			return { version: nextVersion, savedAt: new Date().toISOString() };
		});
		this.pending = operation.catch(() => {});
		return operation;
	}
}
