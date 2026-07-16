export type NoteTemplateSource = "system" | "custom";

export interface NoteTemplate {
	id: string;
	label: string;
	labelEn: string;
	description: string;
	descriptionEn: string;
	tags: string[];
	tagsEn: string[];
	body: string;
	defaultTitle: string;
	defaultTitleEn: string;
	hidden: boolean;
	source: NoteTemplateSource;
	editable: boolean;
}

export interface NoteTemplateInput {
	id: string;
	label: string;
	labelEn: string;
	description: string;
	descriptionEn: string;
	tags: string[];
	tagsEn: string[];
	body: string;
	defaultTitle: string;
	defaultTitleEn: string;
	hidden: boolean;
}

export interface NoteTemplatesResponse {
	templates: NoteTemplate[];
}
