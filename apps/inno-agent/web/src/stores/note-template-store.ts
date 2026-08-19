import { EventEmitter } from "./event-emitter.js";
import {
	createNoteTemplate,
	deleteNoteTemplate,
	duplicateNoteTemplate,
	listNoteTemplates,
	updateNoteTemplate,
} from "../api/note-templates.js";
import type { NoteTemplate, NoteTemplateInput } from "../types/note-templates.js";

interface NoteTemplateStoreEvents { change: void }

function emptyTemplate(): NoteTemplateInput {
	return {
		id: `template-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
		label: "",
		labelEn: "",
		description: "",
		descriptionEn: "",
		tags: [],
		tagsEn: [],
		defaultTitle: "",
		defaultTitleEn: "",
		hidden: false,
		body: "# 新笔记\n\n",
	};
}

function toInput(template: NoteTemplate): NoteTemplateInput {
	const { source: _source, editable: _editable, ...input } = template;
	return input;
}

class NoteTemplateStore extends EventEmitter<NoteTemplateStoreEvents> {
	templates: NoteTemplate[] = [];
	selectedId: string | null = null;
	draft: NoteTemplateInput | null = null;
	isNew = false;
	isLoading = false;
	isSaving = false;
	error: string | null = null;
	query = "";
	private savedDraft = "";

	get selected(): NoteTemplate | null {
		return this.templates.find((template) => template.id === this.selectedId) ?? null;
	}

	get isDirty(): boolean {
		return this.draft !== null && JSON.stringify(this.draft) !== this.savedDraft;
	}

	get filteredTemplates(): NoteTemplate[] {
		const query = this.query.trim().toLowerCase();
		if (!query) return this.templates;
		return this.templates.filter((template) =>
			template.label.toLowerCase().includes(query) ||
			template.labelEn.toLowerCase().includes(query) ||
			template.description.toLowerCase().includes(query) ||
			template.id.toLowerCase().includes(query),
		);
	}

	async load(): Promise<void> {
		this.isLoading = true;
		this.error = null;
		this.emit("change", undefined);
		try {
			this.templates = (await listNoteTemplates()).templates;
			if (this.selectedId && !this.templates.some((template) => template.id === this.selectedId)) {
				this.selectedId = null;
				this.draft = null;
			}
		} catch (error) {
			this.error = error instanceof Error ? error.message : "Failed to load templates";
		} finally {
			this.isLoading = false;
			this.emit("change", undefined);
		}
	}

	setQuery(query: string): void {
		this.query = query;
		this.emit("change", undefined);
	}

	select(id: string): void {
		const template = this.templates.find((item) => item.id === id);
		if (!template) return;
		this.selectedId = id;
		this.isNew = false;
		this.draft = toInput(template);
		this.savedDraft = JSON.stringify(this.draft);
		this.error = null;
		this.emit("change", undefined);
	}

	startCreate(): void {
		this.selectedId = null;
		this.isNew = true;
		this.draft = emptyTemplate();
		this.savedDraft = "";
		this.error = null;
		this.emit("change", undefined);
	}

	updateDraft(patch: Partial<NoteTemplateInput>): void {
		if (!this.draft) return;
		this.draft = { ...this.draft, ...patch };
		this.emit("change", undefined);
	}

	/** Apply editor-only normalization without turning a clean draft dirty. */
	syncDraft(patch: Partial<NoteTemplateInput>): void {
		if (!this.draft) return;
		const wasDirty = this.isDirty;
		this.draft = { ...this.draft, ...patch };
		if (!wasDirty) this.savedDraft = JSON.stringify(this.draft);
		this.emit("change", undefined);
	}

	async save(): Promise<boolean> {
		if (!this.draft || !this.draft.id.trim() || !this.draft.label.trim() || !this.draft.body.trim()) return false;
		this.isSaving = true;
		this.error = null;
		this.emit("change", undefined);
		try {
			const saved = this.isNew
				? await createNoteTemplate(this.draft)
				: await updateNoteTemplate(this.selectedId!, this.draft);
			await this.load();
			this.select(saved.id);
			return true;
		} catch (error) {
			this.error = error instanceof Error ? error.message : "Failed to save template";
			return false;
		} finally {
			this.isSaving = false;
			this.emit("change", undefined);
		}
	}

	async duplicate(id: string): Promise<void> {
		const base = `${id}-copy`;
		let nextId = base;
		let suffix = 2;
		while (this.templates.some((template) => template.id === nextId)) nextId = `${base}-${suffix++}`;
		this.isSaving = true;
		this.error = null;
		this.emit("change", undefined);
		try {
			const copied = await duplicateNoteTemplate(id, nextId);
			await this.load();
			this.select(copied.id);
		} catch (error) {
			this.error = error instanceof Error ? error.message : "Failed to duplicate template";
		} finally {
			this.isSaving = false;
			this.emit("change", undefined);
		}
	}

	async remove(id: string): Promise<boolean> {
		this.isSaving = true;
		this.error = null;
		this.emit("change", undefined);
		try {
			await deleteNoteTemplate(id);
			this.selectedId = null;
			this.draft = null;
			await this.load();
			return true;
		} catch (error) {
			this.error = error instanceof Error ? error.message : "Failed to delete template";
			return false;
		} finally {
			this.isSaving = false;
			this.emit("change", undefined);
		}
	}
}

export const noteTemplateStore = new NoteTemplateStore();
