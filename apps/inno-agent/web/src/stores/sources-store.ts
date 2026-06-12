import { EventEmitter } from "./event-emitter.js";
import { createRawNote, deleteRawFile, listSources, updateRawFile } from "../api/sources.js";
import { uploadRawFile } from "../api/uploads.js";
import { updateWikiPage } from "../api/wiki.js";
import { buildBlankNote } from "../lib/build-blank-note.js";
import { prepareWikiMarkdownImport } from "../lib/wiki-import.js";
import type { OrphanRawFile, SourceDraftFilter, SourceSummary } from "../types/sources.js";

interface SourcesStoreEvents {
	change: void;
}

export type SelectedSource =
	| { kind: "manifest"; source: SourceSummary }
	| { kind: "orphan"; file: OrphanRawFile };

class SourcesStoreImpl extends EventEmitter<SourcesStoreEvents> {
	sources: SourceSummary[] = [];
	orphans: OrphanRawFile[] = [];
	selected: SelectedSource | null = null;
	isLoading = false;
	isUploading = false;
	isImporting = false;
	isCreating = false;
	isDeleting = false;
	isSavingOrphan = false;
	searchQuery = "";
	filterDraft: SourceDraftFilter = "all";
	notice: string | null = null;
	error: string | null = null;

	get filteredSources(): SourceSummary[] {
		let result = this.sources;
		if (this.filterDraft === "draft") {
			result = [];
		}
		if (this.searchQuery) {
			const q = this.searchQuery.toLowerCase();
			result = result.filter(
				(s) =>
					s.title.toLowerCase().includes(q) ||
					s.fileName.toLowerCase().includes(q) ||
					s.tags.some((tag) => tag.toLowerCase().includes(q)),
			);
		}
		return result;
	}

	get filteredOrphans(): OrphanRawFile[] {
		if (this.filterDraft === "archived") return [];
		if (!this.searchQuery) return this.orphans;
		const q = this.searchQuery.toLowerCase();
		return this.orphans.filter((f) => f.fileName.toLowerCase().includes(q));
	}

	clearFlash(): void {
		this.notice = null;
		this.error = null;
	}

	async loadAll(): Promise<void> {
		this.isLoading = true;
		this.emit("change", undefined);
		try {
			const data = await listSources();
			this.sources = data.sources;
			this.orphans = data.orphans;
			if (this.selected?.kind === "manifest") {
				const selectedId = this.selected.source.id;
				const updated = this.sources.find((s) => s.id === selectedId);
				this.selected = updated ? { kind: "manifest", source: updated } : null;
			} else if (this.selected?.kind === "orphan") {
				const selectedPath = this.selected.file.rawPath;
				const updated = this.orphans.find((f) => f.rawPath === selectedPath);
				this.selected = updated ? { kind: "orphan", file: updated } : null;
			}
		} catch (err) {
			this.sources = [];
			this.orphans = [];
			this.selected = null;
			const message = err instanceof Error ? err.message : "";
			this.error = message.includes("Unexpected token") || message.includes("<!doctype")
				? "load_stale_backend"
				: "load_failed";
		} finally {
			this.isLoading = false;
			this.emit("change", undefined);
		}
	}

	/** KM: upload files → store as raw (orphan until archived). */
	async uploadFiles(files: File[]): Promise<void> {
		if (files.length === 0) return;
		this.isUploading = true;
		this.error = null;
		this.notice = null;
		this.emit("change", undefined);
		try {
			const results = await Promise.all(files.map((file) => uploadRawFile(file)));
			await this.loadAll();
			const last = results.at(-1);
			if (last) {
				const orphan = this.orphans.find((f) => f.rawPath === last.rawPath);
				if (orphan) {
					this.selected = { kind: "orphan", file: orphan };
				}
			}
			this.notice = "upload_ok";
		} catch {
			this.error = "upload_failed";
		} finally {
			this.isUploading = false;
			this.emit("change", undefined);
		}
	}

	/** KM: import .md → create wiki pages directly. */
	async importMarkdownFiles(files: File[]): Promise<{ paths: string[] }> {
		const mdFiles = files.filter((f) => f.name.toLowerCase().endsWith(".md"));
		if (mdFiles.length === 0) return { paths: [] };

		this.isImporting = true;
		this.error = null;
		this.notice = null;
		this.emit("change", undefined);
		const paths: string[] = [];
		try {
			for (const file of mdFiles) {
				const raw = await file.text();
				const prepared = prepareWikiMarkdownImport(raw, file.name);
				await updateWikiPage(prepared.path, prepared.content);
				paths.push(prepared.path);
			}
			this.notice = "import_ok";
			void import("./notebook-store.js").then((m) => m.notebookStore.loadAll());
			return { paths };
		} catch {
			this.error = "import_failed";
			return { paths };
		} finally {
			this.isImporting = false;
			this.emit("change", undefined);
		}
	}

	/** Delete draft or archived user note (raw/notes/*.md). */
	async deleteSelectedNote(): Promise<boolean> {
		const rawPath =
			this.selected?.kind === "orphan" && this.selected.file.fileName.toLowerCase().endsWith(".md")
				? this.selected.file.rawPath
				: this.selected?.kind === "manifest" &&
					  this.selected.source.rawPath.replace(/^\/+/, "").startsWith("raw/notes/") &&
					  this.selected.source.rawPath.toLowerCase().endsWith(".md")
					? this.selected.source.rawPath
					: null;
		if (!rawPath) return false;

		this.isDeleting = true;
		this.error = null;
		this.notice = null;
		this.emit("change", undefined);
		try {
			await deleteRawFile(rawPath);
			this.selected = null;
			await this.loadAll();
			void import("./notebook-store.js").then((m) => m.notebookStore.loadAll());
			this.notice = "delete_ok";
			return true;
		} catch {
			this.error = "delete_failed";
			return false;
		} finally {
			this.isDeleting = false;
			this.emit("change", undefined);
		}
	}

	/** Delete unarchived raw file (orphan attachment only). */
	async deleteSelectedOrphan(): Promise<boolean> {
		if (this.selected?.kind !== "orphan") return false;
		if (this.selected.file.fileName.toLowerCase().endsWith(".md")) {
			return this.deleteSelectedNote();
		}
		const rawPath = this.selected.file.rawPath;
		this.isDeleting = true;
		this.error = null;
		this.notice = null;
		this.emit("change", undefined);
		try {
			await deleteRawFile(rawPath);
			this.selected = null;
			await this.loadAll();
			this.notice = "delete_ok";
			return true;
		} catch {
			this.error = "delete_failed";
			return false;
		} finally {
			this.isDeleting = false;
			this.emit("change", undefined);
		}
	}

	selectSource(source: SourceSummary): void {
		this.selected = { kind: "manifest", source };
		this.clearFlash();
		this.emit("change", undefined);
	}

	selectOrphan(file: OrphanRawFile): void {
		this.selected = { kind: "orphan", file };
		this.clearFlash();
		this.emit("change", undefined);
	}

	setSearchQuery(query: string): void {
		this.searchQuery = query;
		this.emit("change", undefined);
	}

	setFilterDraft(draft: SourceDraftFilter): void {
		this.filterDraft = draft;
		this.emit("change", undefined);
	}

	async createBlankNote(locale: string): Promise<string | null> {
		this.isCreating = true;
		this.clearFlash();
		this.emit("change", undefined);
		try {
			const language = locale.startsWith("zh") ? "zh" : "en";
			const prepared = buildBlankNote(language);
			const created = await createRawNote(prepared.content, prepared.fileName);
			await this.loadAll();
			this.filterDraft = "draft";
			const orphan = this.orphans.find((f) => f.rawPath === created.rawPath) ?? created;
			this.selected = { kind: "orphan", file: orphan };
			this.notice = "create_blank_ok";
			return created.rawPath;
		} catch {
			this.error = "create_failed";
			return null;
		} finally {
			this.isCreating = false;
			this.emit("change", undefined);
		}
	}

	async saveNoteContent(rawPath: string, content: string): Promise<boolean> {
		this.isSavingOrphan = true;
		this.error = null;
		this.emit("change", undefined);
		try {
			const wasOrphan = this.selected?.kind === "orphan";
			const result = await updateRawFile(rawPath, content);
			await this.loadAll();
			if (result.archived && result.source) {
				this.selected = { kind: "manifest", source: result.source };
				this.notice = wasOrphan ? "archive_ok" : "save_ok";
				if (wasOrphan) this.filterDraft = "all";
				void import("./notebook-store.js").then((m) => m.notebookStore.loadAll());
			} else if (result.orphan && this.selected?.kind === "orphan" && this.selected.file.rawPath === rawPath) {
				this.selected = { kind: "orphan", file: result.orphan };
				this.notice = "save_ok";
			} else {
				this.notice = "save_ok";
			}
			return true;
		} catch {
			this.error = "save_failed";
			return false;
		} finally {
			this.isSavingOrphan = false;
			this.emit("change", undefined);
		}
	}
}

export const sourcesStore = new SourcesStoreImpl();
