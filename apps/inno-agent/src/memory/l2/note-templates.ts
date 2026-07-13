import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

export interface NoteTemplateDefinition {
	id: string;
	label: string;
	labelEn: string;
	description: string;
	descriptionEn: string;
	tags: string[];
	body: string;
	defaultTitle: string;
	hidden: boolean;
}

function readAttribute(lines: string[], keys: string[]): string {
	for (const line of lines) {
		const match = line.match(/^(\w+):\s*(.*)$/);
		if (!match) continue;
		if (keys.includes(match[1])) return match[2].trim();
	}
	return "";
}

function parseTagList(value: string): string[] {
	if (!value.trim()) return [];
	return value
		.split(/[\s,\uFF0C;\uFF1B\u3001|]+/)
		.map((tag) => tag.trim())
		.filter(Boolean);
}

function extractFirstHeading(body: string): string | null {
	const match = body.match(/^#\s+(.+)$/m);
	return match?.[1]?.trim() ?? null;
}

function loadTemplateFile(codeDir: string, fileName: string): NoteTemplateDefinition | null {
	const absPath = join(codeDir, "note-templates", fileName);
	if (!existsSync(absPath)) return null;
	const raw = readFileSync(absPath, "utf8");
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?([\s\S]*)$/);
	if (!match) return null;

	const metaLines = match[1].split(/\r?\n/);
	const body = match[2];
	const id = basename(fileName, ".md");
	const heading = extractFirstHeading(body);
	const label = readAttribute(metaLines, ["label"]) || heading || id;
	const labelEn = readAttribute(metaLines, ["labelEn", "label_en"]) || label;
	const description = readAttribute(metaLines, ["description", "desc"]);
	const descriptionEn = readAttribute(metaLines, ["descriptionEn", "description_en"]) || description;
	const tags = parseTagList(readAttribute(metaLines, ["tags", "tag"]));
	const defaultTitle = readAttribute(metaLines, ["title"]) || heading || label;
	const hidden = readAttribute(metaLines, ["hidden"]).toLowerCase() === "true";

	return { id, label, labelEn, description, descriptionEn, tags, body, defaultTitle, hidden };
}

export function listNoteTemplates(codeDir: string): NoteTemplateDefinition[] {
	const dir = join(codeDir, "note-templates");
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".md"))
		.map((name) => loadTemplateFile(codeDir, name))
		.filter((item): item is NoteTemplateDefinition => item !== null)
		.sort((a, b) => a.label.localeCompare(b.label, "zh"));
}

export function getNoteTemplate(codeDir: string, templateId: string): NoteTemplateDefinition | undefined {
	return listNoteTemplates(codeDir).find((item) => item.id === templateId);
}

export function resolveNoteTemplateContent(
	codeDir: string,
	options: { templateId?: string; title?: string; tags?: string[]; content?: string },
): { title: string; tags: string[]; body: string } {
	if (options.content?.trim()) {
		return {
			title: options.title?.trim() || "未命名笔记",
			tags: options.tags ?? [],
			body: options.content,
		};
	}

	const template = options.templateId ? getNoteTemplate(codeDir, options.templateId) : getNoteTemplate(codeDir, "blank");
	if (template) {
		return {
			title: options.title?.trim() || template.defaultTitle,
			tags: options.tags ?? template.tags,
			body: template.body,
		};
	}

	return {
		title: options.title?.trim() || "未命名笔记",
		tags: options.tags ?? [],
		body: "# 未命名笔记\n\n",
	};
}
