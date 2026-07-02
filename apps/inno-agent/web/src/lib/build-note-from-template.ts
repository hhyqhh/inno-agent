import {
	getDefaultNoteTemplate,
	getNoteTemplate,
	getVisibleNoteTemplates,
	NOTE_TEMPLATES,
	type NoteTemplateId,
	type NoteTemplateMeta,
} from "./note-template-loader.js";

export type { NoteTemplateId, NoteTemplateMeta };
export { getVisibleNoteTemplates, NOTE_TEMPLATES };

export function buildNoteFromTemplate(templateId: NoteTemplateId): {
	title: string;
	tags: string[];
	body: string;
} {
	const template = getNoteTemplate(templateId) ?? getDefaultNoteTemplate();
	return {
		title: template.defaultTitle || template.label,
		tags: template.tags,
		body: template.body,
	};
}
