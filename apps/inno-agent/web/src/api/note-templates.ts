import { apiFetch } from "./client.js";
import type { NoteTemplate, NoteTemplateInput, NoteTemplatesResponse } from "../types/note-templates.js";

type LegacyTemplate = Partial<NoteTemplate> & Pick<NoteTemplate, "id" | "label">;

function normalizeTemplate(template: LegacyTemplate): NoteTemplate {
	const source = template.source === "custom" ? "custom" : "system";
	return {
		id: template.id,
		label: template.label,
		labelEn: template.labelEn ?? template.label,
		description: template.description ?? "",
		descriptionEn: template.descriptionEn ?? template.description ?? "",
		tags: template.tags ?? [],
		tagsEn: template.tagsEn ?? template.tags ?? [],
		body: template.body ?? "",
		defaultTitle: template.defaultTitle ?? template.label,
		defaultTitleEn: template.defaultTitleEn ?? template.defaultTitle ?? template.labelEn ?? template.label,
		hidden: template.hidden === true,
		source,
		editable: template.editable ?? source === "custom",
	};
}

export async function listNoteTemplates(): Promise<NoteTemplatesResponse> {
	const response = await apiFetch<{ templates: LegacyTemplate[] }>("/api/l2/notes/templates");
	return { templates: response.templates.map(normalizeTemplate) };
}

export async function createNoteTemplate(input: NoteTemplateInput): Promise<NoteTemplate> {
	const result = await apiFetch<LegacyTemplate>("/api/l2/notes/templates", {
		method: "POST",
		body: JSON.stringify(input),
	});
	return normalizeTemplate(result);
}

export async function updateNoteTemplate(id: string, input: NoteTemplateInput): Promise<NoteTemplate> {
	const result = await apiFetch<LegacyTemplate>(`/api/l2/notes/templates/${encodeURIComponent(id)}`, {
		method: "PUT",
		body: JSON.stringify(input),
	});
	return normalizeTemplate(result);
}

export async function deleteNoteTemplate(id: string): Promise<void> {
	await apiFetch(`/api/l2/notes/templates/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function duplicateNoteTemplate(id: string, newId: string): Promise<NoteTemplate> {
	const result = await apiFetch<LegacyTemplate>(`/api/l2/notes/templates/${encodeURIComponent(id)}/duplicate`, {
		method: "POST",
		body: JSON.stringify({ id: newId }),
	});
	return normalizeTemplate(result);
}
