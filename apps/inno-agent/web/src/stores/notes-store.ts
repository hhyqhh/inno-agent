import { createNoteDraft, deleteNoteItem, fetchNoteDraft, listNoteDrafts, saveNoteDraft } from "../api/notes.js";
import type { NoteDraft, NoteDraftSummary } from "../types/notes.js";
import { EventEmitter } from "./event-emitter.js";

interface NotesStoreEvents {
	change: void;
}

export class NotesStore extends EventEmitter<NotesStoreEvents> {
	drafts: NoteDraftSummary[] = [];
	selected: NoteDraftSummary | null = null;
	editorTitle = "";
	editorContent = "";
	savedTitle = "";
	savedContent = "";
	searchQuery = "";
	isLoading = false;
	isLoadingContent = false;
	isCreating = false;
	isSaving = false;
	isDeleting = false;
	error: "loadFailed" | "loadContentFailed" | "createFailed" | "saveFailed" | "deleteFailed" | null = null;
	notice: "created" | "saved" | "deleted" | null = null;
	private selectionVersion = 0;

	get filteredDrafts(): NoteDraftSummary[] {
		const query = this.searchQuery.trim().toLowerCase();
		if (!query) return this.drafts;
		return this.drafts.filter((draft) =>
			draft.title.toLowerCase().includes(query) || draft.rawPath.toLowerCase().includes(query),
		);
	}

	get isDirty(): boolean {
		return Boolean(this.selected) && (
			this.editorTitle !== this.savedTitle || this.editorContent !== this.savedContent
		);
	}

	private clearMessages(): void {
		this.error = null;
		this.notice = null;
	}

	setSearchQuery(searchQuery: string): void {
		this.searchQuery = searchQuery;
		this.emit("change", undefined);
	}

	updateTitle(title: string): void {
		this.editorTitle = title;
		this.notice = null;
		this.emit("change", undefined);
	}

	updateContent(content: string): void {
		this.editorContent = content;
		this.notice = null;
		this.emit("change", undefined);
	}

	discardChanges(): void {
		this.editorTitle = this.savedTitle;
		this.editorContent = this.savedContent;
		this.notice = null;
		this.emit("change", undefined);
	}

	async loadAll(): Promise<void> {
		this.isLoading = true;
		this.error = null;
		this.emit("change", undefined);
		try {
			const response = await listNoteDrafts();
			this.drafts = response.notes;
			if (this.selected) {
				this.selected = this.drafts.find((draft) => draft.rawPath === this.selected?.rawPath) ?? null;
			}
		} catch {
			this.error = "loadFailed";
		} finally {
			this.isLoading = false;
			this.emit("change", undefined);
		}
	}

	async selectDraft(draft: NoteDraftSummary): Promise<void> {
		const version = ++this.selectionVersion;
		this.selected = draft;
		this.isLoadingContent = true;
		this.clearMessages();
		this.editorTitle = "";
		this.editorContent = "";
		this.savedTitle = "";
		this.savedContent = "";
		this.emit("change", undefined);
		try {
			const detail = await fetchNoteDraft(draft.rawPath);
			if (version !== this.selectionVersion) return;
			this.applyDetail(detail);
		} catch {
			if (version === this.selectionVersion) this.error = "loadContentFailed";
		} finally {
			if (version === this.selectionVersion) {
				this.isLoadingContent = false;
				this.emit("change", undefined);
			}
		}
	}

	async createDraft(title: string): Promise<void> {
		this.isCreating = true;
		this.clearMessages();
		this.emit("change", undefined);
		try {
			const created = await createNoteDraft({ title });
			this.drafts = [created, ...this.drafts.filter((draft) => draft.rawPath !== created.rawPath)];
			this.selectionVersion += 1;
			this.isLoadingContent = false;
			this.applyDetail(created);
			this.notice = "created";
		} catch {
			this.error = "createFailed";
		} finally {
			this.isCreating = false;
			this.emit("change", undefined);
		}
	}

	async saveSelected(): Promise<boolean> {
		if (!this.selected || !this.isDirty) return true;
		const savingPath = this.selected.rawPath;
		this.isSaving = true;
		this.clearMessages();
		this.emit("change", undefined);
		try {
			const saved = await saveNoteDraft({
				rawPath: this.selected.rawPath,
				title: this.editorTitle,
				content: this.editorContent,
			});
			this.drafts = [saved, ...this.drafts.filter((draft) => draft.rawPath !== saved.rawPath)];
			if (this.selected?.rawPath === savingPath) {
				this.applyDetail(saved);
				this.notice = "saved";
			}
			return true;
		} catch {
			this.error = "saveFailed";
			return false;
		} finally {
			this.isSaving = false;
			this.emit("change", undefined);
		}
	}

	async deleteSelected(): Promise<boolean> {
		if (!this.selected) return false;
		this.selectionVersion += 1;
		this.isDeleting = true;
		this.clearMessages();
		this.emit("change", undefined);
		try {
			await deleteNoteItem(this.selected.rawPath);
			this.selected = null;
			this.editorTitle = "";
			this.editorContent = "";
			this.savedTitle = "";
			this.savedContent = "";
			this.isLoadingContent = false;
			this.notice = "deleted";
			await this.loadAll();
			return true;
		} catch {
			this.error = "deleteFailed";
			return false;
		} finally {
			this.isDeleting = false;
			this.emit("change", undefined);
		}
	}

	private applyDetail(detail: NoteDraft): void {
		this.selected = detail;
		this.editorTitle = detail.title;
		this.editorContent = detail.content;
		this.savedTitle = detail.title;
		this.savedContent = detail.content;
	}
}

export const notesStore = new NotesStore();

let beforeUnloadProtectionInstalled = false;

/** Keep protecting an unsaved draft even when the user opens another workspace tab. */
export function ensureNotesBeforeUnloadProtection(): void {
	if (beforeUnloadProtectionInstalled || typeof window === "undefined") return;
	beforeUnloadProtectionInstalled = true;
	window.addEventListener("beforeunload", (event) => {
		if (!notesStore.isDirty) return;
		event.preventDefault();
		event.returnValue = "";
	});
}
