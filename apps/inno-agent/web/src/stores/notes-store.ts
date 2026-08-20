import { EventEmitter } from "./event-emitter.js";
import { getTodayRecordDate } from "../lib/note-frontmatter.js";
import {
	archiveNote,
	createNote,
	deleteNoteAttachment,
	fetchNoteContent,
	fetchRawContent,
	listNotes,
	saveNoteContent,
	uploadNoteAttachment,
	uploadNoteFile,
} from "../api/notes.js";
import type { NoteAttachment, NoteContent, NoteListBox, NoteSummary } from "../types/notes.js";

interface NotesStoreEvents {
	change: void;
}

class NotesStoreImpl extends EventEmitter<NotesStoreEvents> {
	notes: NoteSummary[] = [];
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
	listBox: NoteListBox = "drafts";
	searchQuery = "";
	isLoading = false;
	isLoadingContent = false;
	isLoadingPreview = false;
	isCreating = false;
	isSaving = false;
	isArchiving = false;
	isUploading = false;
	isUploadingAttachment = false;
	deletingAttachmentId: string | null = null;
	error: string | null = null;
	notice: string | null = null;

	get isDirty(): boolean {
		if (!this.selected || this.selected.kind !== "markdown") return false;
		return (
			this.editorContent !== this.savedContent ||
			this.editorTitle !== this.savedTitle ||
			this.editorTags.join(",") !== this.savedTags.join(",") ||
			this.editorRecordDate !== this.savedRecordDate
		);
	}

	get filteredNotes(): NoteSummary[] {
		const q = this.searchQuery.trim().toLowerCase();
		const byBox = this.notes.filter((note) =>
			this.listBox === "drafts"
				? note.kind === "orphan" || (note.kind === "markdown" && note.status === "draft")
				: note.kind === "archived" ||
					(note.kind === "markdown" &&
						(note.status === "indexed" || note.status === "outdated" || note.status === "error")),
		);
		if (!q) return byBox;
		return byBox.filter(
			(note) =>
				note.title.toLowerCase().includes(q) ||
				note.rawPath.toLowerCase().includes(q) ||
				note.tags.some((tag) => tag.toLowerCase().includes(q)),
		);
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
	}

	setSearchQuery(query: string) {
		this.searchQuery = query;
		this.emit("change", undefined);
	}

	setListBox(listBox: NoteListBox) {
		this.listBox = listBox;
		this.emit("change", undefined);
	}

	updateEditorTitle(title: string) {
		this.editorTitle = title;
		this.emit("change", undefined);
	}

	updateEditorContent(content: string) {
		this.editorContent = content;
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
			this.previewContent = await fetchRawContent(rawPath);
		} catch {
			this.previewContent = "";
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
		if (!this.selected || this.selected.kind !== "markdown" || !this.isDirty) return true;
		this.isSaving = true;
		this.clearMessages();
		this.emit("change", undefined);
		try {
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

	async archiveSelected(): Promise<string | null> {
		if (!this.selected) return null;
		if (this.selected.kind === "markdown" && this.isDirty) {
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
			this.notice = "archived";
			this.listBox = "archived";
			await this.loadAll();
			const updated = this.notes.find((note) => note.rawPath === result.rawPath);
			if (updated) {
				await this.selectNote(updated);
			}
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
		return this.notes.find((note) => note.noteId === noteId);
	}
}

export const notesStore = new NotesStoreImpl();
