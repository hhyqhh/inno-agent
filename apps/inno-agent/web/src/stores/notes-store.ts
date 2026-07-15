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

function errorDetail(error: unknown): string | null {
	if (!(error instanceof Error)) return null;
	const message = error.message.trim();
	return message || null;
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
	archivingRawPath: string | null = null;
	archivingRawPaths: string[] = [];
	isDeleting = false;
	isUploading = false;
	isUploadingAttachment = false;
	deletingAttachmentId: string | null = null;
	error: string | null = null;
	errorDetail: string | null = null;
	notice: string | null = null;
	polishTemplateLabel: string | null = null;
	polishSuggestedTags: string[] = [];
	private archiveQueue: Promise<unknown> = Promise.resolve();
	private archiveControllers = new Map<string, AbortController>();

	get isDirty(): boolean {
		if (!this.selected) return false;
		if (this.selected.kind === "archived") return false;
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
			const tagKey = this.filterTag.toLowerCase();
			result = result.filter((note) => note.tags.some((tag) => tag.toLowerCase() === tagKey));
		}
		if (!q) return result;
		return result.filter(
			(note) =>
				note.title.toLowerCase().includes(q) ||
				note.rawPath.toLowerCase().includes(q) ||
				note.tags.some((tag) => tag.toLowerCase().includes(q)),
		);
	}

	get draftCount(): number {
		return this.notes.filter((note) => this.isDraftBoxNote(note)).length;
	}

	get archivedCount(): number {
		return this.notes.filter((note) => this.isArchivedBoxNote(note)).length;
	}

	get tagSummaries(): NotesTagSummary[] {
		const byKey = new Map<string, NotesTagSummary>();
		for (const note of this.notesForListBox()) {
			for (const tag of note.tags) {
				const displayName = tag.trim();
				if (!displayName) continue;
				const key = displayName.toLowerCase();
				const current = byKey.get(key);
				if (current) {
					current.usageCount += 1;
					current.displayName = displayName;
				} else {
					byKey.set(key, { displayName, usageCount: 1 });
				}
			}
		}
		return [...byKey.values()].sort((a, b) => b.usageCount - a.usageCount || a.displayName.localeCompare(b.displayName, "zh-CN"));
	}

	get availableTags(): string[] {
		const byKey = new Map<string, NotesTagSummary>();
		for (const note of this.notes) {
			for (const tag of note.tags) {
				const displayName = tag.trim();
				if (!displayName) continue;
				const key = displayName.toLowerCase();
				const current = byKey.get(key);
				if (current) current.usageCount += 1;
				else byKey.set(key, { displayName, usageCount: 1 });
			}
		}
		return [...byKey.values()]
			.sort((a, b) => b.usageCount - a.usageCount || a.displayName.localeCompare(b.displayName, "zh-CN"))
			.map((tag) => tag.displayName);
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
		if (this.aiContextRawPaths.size === 0) return;
		this.aiContextRawPaths = new Set();
		this.emit("change", undefined);
	}

	clearMessages() {
		this.error = null;
		this.errorDetail = null;
		this.notice = null;
		this.polishTemplateLabel = null;
		this.polishSuggestedTags = [];
	}

	setSearchQuery(query: string) {
		this.searchQuery = query;
		this.emit("change", undefined);
	}

	setFilterTag(tag: string | null) {
		this.filterTag = tag;
		this.searchQuery = "";
		this.emit("change", undefined);
	}

	setListBox(listBox: NoteListBox) {
		this.listBox = listBox;
		this.emit("change", undefined);
	}

	private isUnarchivedFile(note: NoteSummary): boolean {
		return note.notebookType === "file" &&
			(note.status === "uploaded" || note.status === "extracting" || note.status === "extracted" || note.status === "error");
	}

	private isDraftBoxNote(note: NoteSummary): boolean {
		return note.kind === "orphan" || this.isUnarchivedFile(note) || (note.kind === "markdown" && note.status === "draft");
	}

	private isArchivedBoxNote(note: NoteSummary): boolean {
		return (note.kind === "archived" && note.status !== "uploaded" && note.status !== "extracting" && note.status !== "extracted" && note.status !== "error") ||
			(note.kind === "markdown" &&
				(note.status === "indexed" || note.status === "outdated" || note.status === "error"));
	}

	private notesForListBox(): NoteSummary[] {
		return this.notes.filter((note) => this.listBox === "drafts" ? this.isDraftBoxNote(note) : this.isArchivedBoxNote(note));
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
		} catch (error) {
			this.notes = [];
			this.error = "loadFailed";
			this.errorDetail = errorDetail(error);
		} finally {
			this.isLoading = false;
			this.emit("change", undefined);
		}
	}

	async reloadNoteIfSelected(rawPath: string): Promise<void> {
		if (this.selected?.rawPath !== rawPath) return;
		await this.loadAll();
		const note = this.notes.find((entry) => entry.rawPath === rawPath);
		if (note && this.selected?.rawPath === rawPath) await this.selectNote(note);
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
			} catch (error) {
				this.error = "loadContentFailed";
				this.errorDetail = errorDetail(error);
				this.editorContent = "";
				this.attachments = [];
			} finally {
				this.isLoadingContent = false;
				this.emit("change", undefined);
			}
			return;
		}

		if (note.notebookType === "note") {
			this.isLoadingContent = true;
			this.emit("change", undefined);
			try {
				const detail = await fetchNoteContent(note.rawPath);
				this.attachments = detail.attachments ?? [];
				this.selected = {
					...note,
					meetingId: detail.meetingId,
					meetingStatus: detail.meetingStatus,
				};
			} catch (error) {
				this.error = "loadContentFailed";
				this.errorDetail = errorDetail(error);
				this.attachments = [];
			} finally {
				this.isLoadingContent = false;
				this.emit("change", undefined);
			}
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
		} catch (error) {
			this.error = "createFailed";
			this.errorDetail = errorDetail(error);
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
		} catch (error) {
			this.error = "uploadFailed";
			this.errorDetail = errorDetail(error);
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
		} catch (error) {
			this.error = "attachmentUploadFailed";
			this.errorDetail = errorDetail(error);
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
		} catch (error) {
			this.error = "attachmentDeleteFailed";
			this.errorDetail = errorDetail(error);
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
		} catch (error) {
			this.error = "saveFailed";
			this.errorDetail = errorDetail(error);
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
			const tagsByKey = new Map(this.editorTags.map((tag) => [tag.trim().replace(/\s+/g, " ").toLowerCase(), tag.trim()]));
			for (const tag of result.suggestedTags) {
				const trimmed = tag.trim();
				const key = trimmed.replace(/\s+/g, " ").toLowerCase();
				if (key && !tagsByKey.has(key)) tagsByKey.set(key, trimmed);
			}
			this.editorTags = [...tagsByKey.values()].slice(0, 12);
			this.polishSuggestedTags = result.suggestedTags;
			this.notice = result.suggestedTags.length > 0
				? (result.templateLabel ? "polishedWithTemplateAndTags" : "polishedWithTags")
				: (result.templateLabel ? "polishedWithTemplate" : "polished");
		} catch (error) {
			if (this.selected?.rawPath === rawPath) {
				this.error = "polishFailed";
				this.errorDetail = errorDetail(error);
			}
		} finally {
			this.isPolishing = false;
			this.emit("change", undefined);
		}
	}

	async archiveSelected(): Promise<string | null> {
		if (!this.selected) return null;
		if (this.selected.kind === "markdown" && !this.editorContent.trim() && this.attachments.length === 0) {
			this.clearMessages();
			this.error = "emptyCannotArchive";
			this.emit("change", undefined);
			return null;
		}
		if (this.selected.kind === "markdown" && this.isDirty) {
			const saved = await this.saveSelected();
			if (!saved) return null;
		}
		const rawPath = this.selected.rawPath;
		if (this.archivingRawPaths.includes(rawPath)) return null;
		const controller = new AbortController();
		this.archiveControllers.set(rawPath, controller);
		const title = this.selected.kind === "markdown" ? this.editorTitle.trim() || this.selected.title : undefined;
		const tags = this.selected.kind === "markdown" ? [...this.editorTags] : undefined;
		this.isArchiving = true;
		this.archivingRawPaths = [...this.archivingRawPaths, rawPath];
		this.clearMessages();
		this.emit("change", undefined);

		const run = async (): Promise<string | null> => {
			this.archivingRawPath = rawPath;
			this.emit("change", undefined);
			controller.signal.throwIfAborted();
			const result = await archiveNote(rawPath, {
				title,
				tags,
			}, controller.signal);
			this.notice = "archived";
			this.listBox = "archived";
			await this.loadAll();
			const updated = this.notes.find((note) => note.rawPath === result.rawPath);
			if (updated) {
				await this.selectNote(updated);
			}
			return result.wikiPagePath;
		};

		const task = this.archiveQueue
			.catch(() => undefined)
			.then(run)
			.catch((error) => {
				if (controller.signal.aborted) {
					this.notice = "archiveStopped";
					return null;
				}
				this.error = "archiveFailed";
				this.errorDetail = errorDetail(error);
				return null;
			})
			.finally(() => {
				this.archiveControllers.delete(rawPath);
				this.archivingRawPaths = this.archivingRawPaths.filter((path) => path !== rawPath);
				this.archivingRawPath = this.archivingRawPaths[0] ?? null;
				this.isArchiving = this.archivingRawPaths.length > 0;
				this.emit("change", undefined);
			});
		this.archiveQueue = task;
		try {
			return await task;
		} finally {
			this.emit("change", undefined);
		}
	}

	stopArchive(rawPath: string | null = this.archivingRawPath): void {
		if (!rawPath) return;
		this.archiveControllers.get(rawPath)?.abort();
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
			this.notice = "deleted";
			await this.loadAll();
			return true;
		} catch (error) {
			this.error = "deleteFailed";
			this.errorDetail = errorDetail(error);
			return false;
		} finally {
			this.isDeleting = false;
			this.emit("change", undefined);
		}
	}

	async unarchiveSelected(): Promise<boolean> {
		if (!this.selected) return false;
		const rawPath = this.selected.rawPath;
		this.isArchiving = true;
		this.archivingRawPath = rawPath;
		this.clearMessages();
		this.emit("change", undefined);
		try {
			const result = await unarchiveNote(rawPath);
			this.notice = "unarchived";
			this.listBox = "drafts";
			await this.loadAll();
			const updated = this.notes.find((note) => note.rawPath === result.rawPath);
			if (updated) {
				await this.selectNote(updated);
			} else {
				this.selected = null;
			}
			return true;
		} catch (error) {
			this.error = "unarchiveFailed";
			this.errorDetail = errorDetail(error);
			return false;
		} finally {
			this.isArchiving = false;
			this.archivingRawPath = null;
			this.emit("change", undefined);
		}
	}

	findNoteById(noteId: string): NoteSummary | undefined {
		return this.notes.find((note) => note.noteId === noteId);
	}
}

export const notesStore = new NotesStoreImpl();
