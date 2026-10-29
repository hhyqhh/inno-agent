import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname } from "node:path";
import { logger } from "../logger.js";
import { resolveContainedPathAsync } from "../utils/path-safety.js";
import { OfficePdfConverter, officePath } from "./pdf-converter.js";

const MAX_WORD_BYTES = 25 * 1024 * 1024;
const MAX_PDF_BYTES = 64 * 1024 * 1024;
const CACHE_BYTES = 256 * 1024 * 1024;
const CACHE_AGE = 7 * 24 * 60 * 60 * 1000;
const PIPELINE_VERSION = "word-pdf-v4-grid-metrics";

export class WordPreviewError extends Error {
	constructor(public readonly code: string, public readonly status: number, message: string) { super(message); }
}
export interface WordPdfPreview { path: string; size: number; etag: string }

function previewError(error: unknown): WordPreviewError {
	if (error instanceof WordPreviewError) return error;
	if (error instanceof Error && error.message === "WORD_ENGINE_UNAVAILABLE") return new WordPreviewError("WORD_ENGINE_UNAVAILABLE", 503, "LibreOffice is required to preview Word documents.");
	if (error instanceof Error && error.message === "WORD_ENGINE_INCOMPATIBLE") return new WordPreviewError("WORD_ENGINE_INCOMPATIBLE", 503, "LibreOffice 26.8.0 has a document spacing defect. Use 26.8.1 or later.");
	// Engine errors include user paths; never expose their raw messages.
	return new WordPreviewError("WORD_PREVIEW_FAILED", 422, "Unable to convert this Word document to PDF.");
}

/** Sole owner of conversion, versioned disk cache and the warm Office process. */
export class WordPreviewService {
	private readonly converter: OfficePdfConverter;
	private readonly pending = new Map<string, Promise<WordPdfPreview>>();
	private readonly fontVersion: Promise<string>;
	private readonly versions = new Map<string, { stamp: string; key: string }>();
	private queue: Promise<unknown> = Promise.resolve();
	private closed = false;
	constructor(private readonly cacheRoot: string, converter?: OfficePdfConverter) {
		this.converter = converter ?? new OfficePdfConverter(cacheRoot);
		// Font installations/configuration change PDF output even if source bytes do not.
		this.fontVersion = (async () => {
			const paths = ["/Applications/Microsoft Word.app/Contents/Resources/DFonts", "/Library/Fonts", "/System/Library/Fonts",
				await officePath(homedir(), "Library/Fonts"), process.env.FONTCONFIG_FILE, process.env.INNO_LIBREOFFICE_PATH,
				process.env.INNO_BUNDLED_TOOLS_DIR].filter((path): path is string => !!path);
			return (await Promise.all(paths.map(async (path) => { const info = await stat(path).catch(() => null); return `${path}:${info?.mtimeMs ?? 0}`; }))).join("|");
		})();
	}
	warm(): Promise<void> { return this.converter.warm(); }
	stop(): void { this.closed = true; this.converter.stop(); }
	async dispose(): Promise<void> { this.closed = true; await this.converter.dispose(); await this.queue; }

	private async cached(key: string): Promise<WordPdfPreview | null> {
		const path = await officePath(this.cacheRoot, `${key}.pdf`);
		const info = await stat(path).catch(() => null);
		return info?.isFile() && info.size > 5 && info.size <= MAX_PDF_BYTES
			? { path, size: info.size, etag: `"${key}"` } : null;
	}

	async get(workspaceDir: string, relativePath: string): Promise<WordPdfPreview> {
		if (this.closed) throw new WordPreviewError("WORD_PREVIEW_BUSY", 503, "Document preview is shutting down.");
		const source = await resolveContainedPathAsync(workspaceDir, relativePath);
		if (!source) throw new WordPreviewError("WORD_FILE_NOT_FOUND", 404, "Workspace file not found.");
		const extension = extname(source).toLowerCase();
		if (extension !== ".doc" && extension !== ".docx") throw new WordPreviewError("WORD_FORMAT_UNSUPPORTED", 415, "Only DOC and DOCX previews are supported.");
		const info = await stat(source, { bigint: true }).catch(() => null);
		if (!info?.isFile()) throw new WordPreviewError("WORD_FILE_NOT_FOUND", 404, "Workspace file not found.");
		if (info.size > MAX_WORD_BYTES) throw new WordPreviewError("WORD_PREVIEW_TOO_LARGE", 413, "Word document is too large to preview.");
		// ctime catches same-size saves whose mtime was restored by an editor.
		const stamp = `${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.ino}`;
		let key = this.versions.get(source)?.stamp === stamp ? this.versions.get(source)!.key : "";
		if (key) { const hit = await this.cached(key); if (hit) return hit; }
		const content = await readFile(source);
		if (content.length > MAX_WORD_BYTES) throw new WordPreviewError("WORD_PREVIEW_TOO_LARGE", 413, "Word document is too large to preview.");
		// Rendering fixes must invalidate old PDFs even when the DOCX is unchanged.
		const engineVersion = await this.converter.fingerprint().catch((error) => { throw previewError(error); });
		key = createHash("sha256").update(PIPELINE_VERSION).update(engineVersion).update(await this.fontVersion).update(source).update("\0").update(content).digest("hex");
		this.versions.set(source, { stamp, key });
		if (this.versions.size > 256) this.versions.delete(this.versions.keys().next().value!);
		const hit = await this.cached(key);
		if (hit) return hit;
		const existing = this.pending.get(key);
		if (existing) return existing;
		if (this.pending.size >= 4) throw new WordPreviewError("WORD_PREVIEW_BUSY", 503, "Document preview is busy. Please retry shortly.");
		const task = this.queue.then(async () => {
			if (this.closed) throw new WordPreviewError("WORD_PREVIEW_BUSY", 503, "Document preview is shutting down.");
			await mkdir(this.cacheRoot, { recursive: true, mode: 0o700 });
			const staging = await officePath(this.cacheRoot, `${key}.partial`);
			try {
				// Convert an immutable snapshot and publish atomically only after validation.
				await this.converter.convert(content, extension, staging);
				const output = await stat(staging);
				if (output.size > MAX_PDF_BYTES) throw new WordPreviewError("WORD_PREVIEW_TOO_LARGE", 413, "Document preview is too large.");
				const handle = await open(staging, "r");
				try { const header = Buffer.alloc(5); await handle.read(header, 0, 5, 0); if (header.toString() !== "%PDF-") throw new Error("Invalid PDF"); }
				finally { await handle.close(); }
				const path = await officePath(this.cacheRoot, `${key}.pdf`);
				await rename(staging, path);
				await this.prune(key).catch(() => logger.warn("Word preview cache cleanup failed"));
				return { path, size: output.size, etag: `"${key}"` };
			} catch (error) {
				throw previewError(error);
			} finally { await rm(staging, { force: true }).catch(() => undefined); }
		});
		this.pending.set(key, task);
		this.queue = task.catch(() => undefined);
		try { return await task; } finally { this.pending.delete(key); }
	}

	private async prune(current: string): Promise<void> {
		const files = await Promise.all((await readdir(this.cacheRoot)).filter((name) => /^[a-f0-9]{64}\.pdf$/.test(name)).map(async (name) => {
			const path = await officePath(this.cacheRoot, name);
			return { name, path, ...await stat(path) };
		}));
		files.sort((a, b) => b.mtimeMs - a.mtimeMs);
		let bytes = 0;
		for (const file of files) {
			bytes += file.size;
			if (file.name !== `${current}.pdf` && (bytes > CACHE_BYTES || Date.now() - file.mtimeMs > CACHE_AGE)) await rm(file.path, { force: true });
		}
	}
}

let active: { root: string; service: WordPreviewService } | undefined;
export async function wordPreviewService(dataDir: string): Promise<WordPreviewService> {
	const root = await officePath(dataDir, "office-previews");
	if (!active) active = { root, service: new WordPreviewService(root) };
	if (active.root !== root) throw new Error("Word preview service already initialized for another data directory");
	return active.service;
}
export async function getWordPdfPreview(dataDir: string, workspaceDir: string, relativePath: string): Promise<WordPdfPreview> {
	return (await wordPreviewService(dataDir)).get(workspaceDir, relativePath);
}
export async function warmWordPreviews(dataDir: string): Promise<void> { await (await wordPreviewService(dataDir)).warm(); }
export function stopWordPreviews(): void { active?.service.stop(); }

export async function closeWordPreviews(): Promise<void> { await active?.service.dispose(); }
