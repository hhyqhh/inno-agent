import { EventEmitter } from "./event-emitter.js";
import { getTodayRecordDate } from "../lib/note-frontmatter.js";
import {
	archiveNote,
	createNote,
	deleteNoteAttachment,
	deleteNoteItem,
	fetchNoteContent,
	fetchRawContent,
	listNotes,
	polishNote,
	saveNoteContent,
	saveRawMarkdownContent,
	unarchiveNote,
	uploadNoteAttachment,
	uploadNoteFile,
} from "../api/notes.js";
import type { NoteAttachment, NoteContent, NoteListBox, NoteSummary } from "../types/notes.js";

interface NotesStoreEvents {
	change: void;
}

export interface NotesTagSummary {
	displayName: string;
	usageCount: number;
}

class NotesStoreImpl extends EventEmitter<NotesStoreEvents> {
	readonly aiContextLimit = 20;
	notes: NoteSummary[] = [];
	aiContextRawPaths = new Set<string>();
	selected: NoteSummary | null = null;
	editorContent = "";
	editorTitle = "";
	editorTags: string[] = [];
	editorRecordDate = "";
	attachments: NoteAttachment[] = [];
	savedContent = "";
	savedTitle = "";
	savedTags: string[] = [];
	savedRecordDate = "";
	previewContent = "";
	savedPreviewContent = "";
	listBox: NoteListBox = "drafts";
	searchQuery = "";
	filterTag: string | null = null;
	isLoading = false;
	isLoadingContent = false;
	isLoadingPreview = false;
	isCreating = false;
	isSaving = false;
	isPolishing = false;
	isArchiving = false;
	isDeleting = false;
	isUploading = false;
	isUploadingAttachment = false;
	deletingAttachmentId: string | null = null;
	error: string | null = null;
	notice: string | null = null;
	polishTemplateLabel: string | null = null;

	get isDirty(): boolean {
		if (!this.selected) return false;
		if (this.selected.kind !== "markdown" && this.selected.contentType === "markdown") {
			return this.previewContent !== this.savedPreviewContent;
		}
		if (this.selected.kind !== "markdown") return false;
		return (
			this.editorContent !== this.savedContent ||
			this.editorTitle !== this.savedTitle ||
			this.editorTags.join(",") !== this.savedTags.join(",") ||
			this.editorRecordDate !== this.savedRecordDate
		);
	}

	get filteredNotes(): NoteSummary[] {
		const q = this.searchQuery.trim().toLowerCase();
		let result = this.notesForListBox();
		if (this.filterTag) {
			const tagKey = this.filterTag.toLocaleLowerCase();
			result = result.filter((note) => note.tags.some((tag) => tag.toLocaleLowerCase() === tagKey));
		}
		if (!q) return result;
		return result.filter(
			(note) =>
				note.title.toLowerCase().includes(q) ||
				note.rawPath.toLowerCase().includes(q) ||
				note.tags.some((tag) => tag.toLowerCase().includes(q)),
		);
	}

	get tagSummaries(): NotesTagSummary[] {
		const byKey = new Map<string, NotesTagSummary>();
		for (const note of this.notesForListBox()) {
			for (const tag of note.tags) {
				const displayName = tag.trim();
				const key = displayName.toLocaleLowerCase();
				if (!key) continue;
				const current = byKey.get(key);
				if (current) current.usageCount += 1;
				else byKey.set(key, { displayName, usageCount: 1 });
			}
		}
		return [...byKey.values()].sort(
			(a, b) => b.usageCount - a.usageCount || a.displayName.localeCompare(b.displayName, "zh-CN"),
		);
	}

	get aiContextNotes(): NoteSummary[] {
		return [...this.aiContextRawPaths]
			.map((rawPath) => this.notes.find((note) => note.rawPath === rawPath))
			.filter((note): note is NoteSummary => Boolean(note));
	}

	canUseAsAiContext(note: NoteSummary): boolean {
		return !["pdf", "word", "image"].includes(note.contentType) || Boolean(note.extractedPath);
	}

	toggleAiContext(note: NoteSummary): void {
		if (!this.canUseAsAiContext(note)) return;
		const next = new Set(this.aiContextRawPaths);
		if (next.has(note.rawPath)) next.delete(note.rawPath);
		else if (next.size < this.aiContextLimit) next.add(note.rawPath);
		this.aiContextRawPaths = next;
		this.emit("change", undefined);
	}

	removeAiContext(rawPath: string): void {
		if (!this.aiContextRawPaths.has(rawPath)) return;
		const next = new Set(this.aiContextRawPaths);
		next.delete(rawPath);
		this.aiContextRawPaths = next;
		this.emit("change", undefined);
	}

	clearAiContext(): void {
		if (!this.aiContextRawPaths.size) return;
		this.aiContextRawPaths = new Set();
		this.emit("change", undefined);
	}

	get draftCount(): number {
		return this.notes.filter(
			(note) => note.kind === "orphan" || (note.kind === "markdown" && note.status === "draft"),
		).length;
	}

	get archivedCount(): number {
		return this.notes.filter(
			(note) =>
				note.kind === "archived" ||
				(note.kind === "markdown" &&
					(note.status === "indexed" || note.status === "outdated" || note.status === "error")),
		).length;
	}

	clearMessages() {
		this.error = null;
		this.notice = null;
		this.polishTemplateLabel = null;
	}

	setSearchQuery(query: string) {
		this.searchQuery = query;
		this.emit("change", undefined);
	}

	setFilterTag(tag: string | null) {
		this.filterTag = tag;
		this.emit("change", undefined);
	}

	setListBox(listBox: NoteListBox) {
		this.listBox = listBox;
		this.filterTag = null;
		this.emit("change", undefined);
	}

	private notesForListBox(): NoteSummary[] {
		return this.notes.filter((note) =>
			this.listBox === "drafts"
				? note.kind === "orphan" || (note.kind === "markdown" && note.status === "draft")
				: note.kind === "archived" ||
					(note.kind === "markdown" &&
						(note.status === "indexed" || note.status === "outdated" || note.status === "error")),
		);
	}

	updateEditorTitle(title: string) {
		this.editorTitle = title;
		this.emit("change", undefined);
	}

	updateEditorContent(content: string) {
		this.editorContent = content;
		this.emit("change", undefined);
	}

	updatePreviewContent(content: string) {
		this.previewContent = content;
		this.emit("change", undefined);
	}

	updateEditorTags(tags: string[]) {
		this.editorTags = tags;
		this.emit("change", undefined);
	}

	updateEditorRecordDate(recordDate: string) {
		this.editorRecordDate = recordDate;
		this.emit("change", undefined);
	}

	async loadPreview(rawPath: string, contentType: string) {
		if (contentType === "pdf" || contentType === "word" || contentType === "image") {
			this.previewContent = "";
			return;
		}
		this.isLoadingPreview = true;
		this.emit("change", undefined);
		try {
			this.previewContent = await fetchRawContent(rawPath, { full: contentType === "markdown" });
			this.savedPreviewContent = this.previewContent;
		} catch {
			this.previewContent = "";
			this.savedPreviewContent = "";
		} finally {
			this.isLoadingPreview = false;
			this.emit("change", undefined);
		}
	}

	async loadAll(): Promise<void> {
		this.isLoading = true;
		this.clearMessages();
		this.emit("change", undefined);
		try {
			const data = await listNotes();
			this.notes = data.notes;
			const availablePaths = new Set(this.notes.map((note) => note.rawPath));
			this.aiContextRawPaths = new Set([...this.aiContextRawPaths].filter((rawPath) => availablePaths.has(rawPath)));
			if (this.selected) {
				const updated = this.notes.find((note) => note.rawPath === this.selected?.rawPath);
				this.selected = updated ?? null;
			}
		} catch {
			this.notes = [];
			this.error = "loadFailed";
		} finally {
			this.isLoading = false;
			this.emit("change", undefined);
		}
	}

	async selectNote(note: NoteSummary): Promise<void> {
		this.selected = note;
		this.previewContent = "";
		this.savedPreviewContent = "";
		this.attachments = [];
		this.clearMessages();
		this.emit("change", undefined);

		if (note.kind === "markdown") {
			this.isLoadingContent = true;
			this.emit("change", undefined);
			try {
				const detail: NoteContent = await fetchNoteContent(note.rawPath);
				this.editorTitle = detail.title;
				this.editorTags = detail.tags;
				this.editorRecordDate = detail.recordDate || getTodayRecordDate();
				this.editorContent = detail.content;
				this.attachments = detail.attachments ?? [];
				this.savedTitle = detail.title;
				this.savedTags = [...detail.tags];
				this.savedRecordDate = detail.recordDate || getTodayRecordDate();
				this.savedContent = detail.content;
				this.selected = { ...note, ...detail };
			} catch {
				this.error = "loadContentFailed";
				this.editorContent = "";
				this.attachments = [];
			} finally {
				this.isLoadingContent = false;
				this.emit("change", undefined);
			}
			return;
		}

		await this.loadPreview(note.rawPath, note.contentType);
	}

	async createFromTemplate(templateId: string): Promise<void> {
		this.isCreating = true;
		this.clearMessages();
		this.emit("change", undefined);
		try {
			const result = await createNote({ templateId });
			this.notice = templateId === "blank" ? "created" : "createdFromTemplate";
			this.listBox = "drafts";
			await this.loadAll();
			const created = this.notes.find((note) => note.rawPath === result.rawPath);
			if (created) {
				await this.selectNote(created);
			}
		} catch {
			this.error = "createFailed";
		} finally {
			this.isCreating = false;
			this.emit("change", undefined);
		}
	}

	async uploadFiles(files: FileList | File[]): Promise<void> {
		const list = Array.from(files);
		if (list.length === 0) return;
		this.isUploading = true;
		this.clearMessages();
		this.emit("change", undefined);
		try {
			for (const file of list) {
				await uploadNoteFile(file);
			}
			this.notice = "uploaded";
			this.listBox = "drafts";
			await this.loadAll();
		} catch {
			this.error = "uploadFailed";
		} finally {
			this.isUploading = false;
			this.emit("change", undefined);
		}
	}

	async uploadAttachments(files: FileList | File[]): Promise<void> {
		if (!this.selected || this.selected.kind !== "markdown") return;
		const list = Array.from(files);
		if (list.length === 0) return;
		this.isUploadingAttachment = true;
		this.clearMessages();
		this.emit("change", undefined);
		try {
			for (const file of list) {
				const result = await uploadNoteAttachment(this.selected.rawPath, file);
				this.attachments = [result.attachment, ...this.attachments.filter((item) => item.id !== result.attachment.id)];
			}
			this.notice = "attachmentUploaded";
		} catch {
			this.error = "attachmentUploadFailed";
		} finally {
			this.isUploadingAttachment = false;
			this.emit("change", undefined);
		}
	}

	async deleteAttachment(attachmentId: string): Promise<void> {
		if (!this.selected || this.selected.kind !== "markdown") return;
		this.deletingAttachmentId = attachmentId;
		this.clearMessages();
		this.emit("change", undefined);
		try {
			await deleteNoteAttachment(attachmentId);
			this.attachments = this.attachments.filter((item) => item.id !== attachmentId);
			this.notice = "attachmentDeleted";
		} catch {
			this.error = "attachmentDeleteFailed";
		} finally {
			this.deletingAttachmentId = null;
			this.emit("change", undefined);
		}
	}

	async saveSelected(): Promise<boolean> {
		if (!this.selected || !this.isDirty) return true;
		this.isSaving = true;
		this.clearMessages();
		this.emit("change", undefined);
		try {
			if (this.selected.kind !== "markdown" && this.selected.contentType === "markdown") {
				const result = await saveRawMarkdownContent({
					rawPath: this.selected.rawPath,
					content: this.previewContent,
				});
				this.savedPreviewContent = this.previewContent;
				this.notice = "saved";
				await this.loadAll();
				this.selected = this.notes.find((note) => note.rawPath === result.rawPath) ?? this.selected;
				return true;
			}

			const result = await saveNoteContent({
				rawPath: this.selected.rawPath,
				title: this.editorTitle.trim() || this.selected.title,
				tags: this.editorTags,
				recordDate: this.editorRecordDate,
				content: this.editorContent,
			});
			this.savedTitle = this.editorTitle.trim() || this.selected.title;
			this.savedTags = [...this.editorTags];
			this.savedRecordDate = this.editorRecordDate;
			this.savedContent = this.editorContent;
			this.notice = "saved";
			await this.loadAll();
			if (this.selected) {
				this.selected = this.notes.find((note) => note.rawPath === result.rawPath) ?? this.selected;
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

	async polishSelected(): Promise<void> {
		if (!this.selected || this.selected.kind !== "markdown" || !this.editorContent.trim() || this.isPolishing) return;
		const rawPath = this.selected.rawPath;
		this.isPolishing = true;
		this.clearMessages();
		this.emit("change", undefined);
		try {
			const result = await polishNote({
				rawPath,
				title: this.editorTitle.trim() || this.selected.title,
				tags: [...this.editorTags],
				content: this.editorContent,
			});
			if (this.selected?.rawPath !== rawPath) return;
			this.editorContent = result.content;
			this.polishTemplateLabel = result.templateLabel;
			this.notice = result.templateLabel ? "polishedWithTemplate" : "polished";
		} catch {
			if (this.selected?.rawPath === rawPath) this.error = "polishFailed";
		} finally {
			this.isPolishing = false;
			this.emit("change", undefined);
		}
	}

	async archiveSelected(): Promise<string | null> {
		if (!this.selected) return null;
		if (this.isDirty) {
			const saved = await this.saveSelected();
			if (!saved) return null;
		}
		this.isArchiving = true;
		this.clearMessages();
		this.emit("change", undefined);
		try {
			const result = await archiveNote(this.selected.rawPath, {
				title: this.selected.kind === "markdown" ? this.editorTitle.trim() || this.selected.title : undefined,
				tags: this.selected.kind === "markdown" ? this.editorTags : undefined,
			});
			this.listBox = "archived";
			await this.loadAll();
			const updated = this.notes.find((note) => note.rawPath === result.rawPath);
			if (updated) {
				await this.selectNote(updated);
			}
			this.notice = "archived";
			return result.wikiPagePath;
		} catch {
			this.error = "archiveFailed";
			return null;
		} finally {
			this.isArchiving = false;
			this.emit("change", undefined);
		}
	}

	findNoteById(noteId: string): NoteSummary | undefined {
		return this.notes.find((note) => note.noteId === noteId || note.sourceId === noteId);
	}

	async deleteSelected(): Promise<boolean> {
		if (!this.selected) return false;
		this.isDeleting = true;
		this.clearMessages();
		this.emit("change", undefined);
		try {
			await deleteNoteItem(this.selected.rawPath);
			this.selected = null;
			this.editorContent = "";
			this.editorTitle = "";
			this.editorTags = [];
			this.attachments = [];
			this.previewContent = "";
			this.savedPreviewContent = "";
			await this.loadAll();
			this.notice = "deleted";
			return true;
		} catch {
			this.error = "deleteFailed";
			return false;
		} finally {
			this.isDeleting = false;
			this.emit("change", undefined);
		}
	}

	async unarchiveSelected(): Promise<boolean> {
		if (!this.selected) return false;
		this.isArchiving = true;
		this.clearMessages();
		this.emit("change", undefined);
		try {
			const result = await unarchiveNote(this.selected.rawPath);
			this.listBox = "drafts";
			await this.loadAll();
			const updated = this.notes.find((note) => note.rawPath === result.rawPath);
			if (updated) await this.selectNote(updated);
			else this.selected = null;
			this.notice = "unarchived";
			return true;
		} catch {
			this.error = "unarchiveFailed";
			return false;
		} finally {
			this.isArchiving = false;
			this.emit("change", undefined);
		}
	}
}

export const notesStore = new NotesStoreImpl();
