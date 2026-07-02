import i18n from "../i18n/index.js";
import { getFrontmatterAttribute, parseNoteFrontmatter, parseTagList } from "./note-frontmatter.js";

export type NoteTemplateId = string;

export interface NoteTemplateMeta {
	id: NoteTemplateId;
	label: string;
	description: string;
	tags: string[];
	body: string;
	hidden: boolean;
	defaultTitle: string;
}

const templateModules = import.meta.glob("../../../note-templates/*.md", {
	query: "?raw",
	import: "default",
	eager: true,
}) as Record<string, string>;

function templateIdFromPath(path: string): string {
	return path.match(/\/([^/]+)\.md$/)?.[1] ?? "template";
}

function readAttribute(attributes: { key: string; value: string }[], keys: string[]): string {
	return getFrontmatterAttribute({ attributes, body: "", hasFrontmatter: true }, keys)?.value.trim() ?? "";
}

function extractFirstHeading(body: string): string | null {
	const match = body.match(/^#\s+(.+)$/m);
	return match?.[1]?.trim() ?? null;
}

function humanizeTemplateId(id: string): string {
	return id.replace(/-/g, " ");
}

function loadNoteTemplates(): NoteTemplateMeta[] {
	const language = i18n.language.startsWith("en") ? "en" : "zh";
	return Object.entries(templateModules)
		.map(([path, raw]) => {
			const id = templateIdFromPath(path);
			const parsed = parseNoteFrontmatter(raw);
			const body = parsed.hasFrontmatter ? parsed.body : raw;
			const attributes = parsed.attributes;
			const heading = extractFirstHeading(body);
			const labelZh = readAttribute(attributes, ["label"]) || heading || humanizeTemplateId(id);
			const labelEn = readAttribute(attributes, ["labelEn", "label_en"]) || labelZh;
			const descriptionZh = readAttribute(attributes, ["description", "desc"]);
			const descriptionEn = readAttribute(attributes, ["descriptionEn", "description_en"]) || descriptionZh;
			const tagsZh = parseTagList(readAttribute(attributes, ["tags", "tag"]));
			const tagsEn = parseTagList(readAttribute(attributes, ["tagsEn", "tags_en", "tagEn"]));
			const resolvedTagsEn = tagsEn.length > 0 ? tagsEn : tagsZh;
			const titleZh = readAttribute(attributes, ["title"]) || heading || labelZh;
			const titleEn = readAttribute(attributes, ["titleEn", "title_en"]) || titleZh;
			const hidden = readAttribute(attributes, ["hidden"]).toLowerCase() === "true";

			return {
				id,
				label: language === "en" ? labelEn : labelZh,
				description: language === "en" ? descriptionEn : descriptionZh,
				tags: language === "en" ? resolvedTagsEn : tagsZh,
				body,
				hidden,
				defaultTitle: language === "en" ? titleEn : titleZh,
			};
		})
		.sort((left, right) => left.label.localeCompare(right.label, language === "en" ? "en" : "zh"));
}

export const NOTE_TEMPLATES = loadNoteTemplates();

export function getNoteTemplate(templateId: NoteTemplateId): NoteTemplateMeta | undefined {
	return NOTE_TEMPLATES.find((template) => template.id === templateId);
}

export function getVisibleNoteTemplates(): NoteTemplateMeta[] {
	return NOTE_TEMPLATES.filter((template) => !template.hidden);
}

export function getDefaultNoteTemplate(): NoteTemplateMeta {
	return getNoteTemplate("blank") ?? NOTE_TEMPLATES[0];
}
