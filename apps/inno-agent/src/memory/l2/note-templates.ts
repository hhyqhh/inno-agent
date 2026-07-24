import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { NoteTemplateDefinition, NoteTemplateInput } from "./types.js";
import { splitTagText } from "./l2-utils.js";

const TEMPLATE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_TEMPLATE_BYTES = 256 * 1024;

function readAttribute(lines: string[], keys: string[]): string {
	for (const line of lines) {
		const match = line.match(/^(\w+):\s*(.*)$/);
		if (match && keys.includes(match[1])) return match[2].trim();
	}
	return "";
}

function extractFirstHeading(body: string): string | null {
	return body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? null;
}

function loadTemplateFile(dir: string, fileName: string, source: "system" | "custom"): NoteTemplateDefinition | null {
	const absPath = join(dir, fileName);
	if (!existsSync(absPath)) return null;
	const raw = readFileSync(absPath, "utf8");
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?([\s\S]*)$/);
	if (!match) return null;

	const metaLines = match[1].split(/\r?\n/);
	const body = match[2];
	const id = basename(fileName, ".md");
	const heading = extractFirstHeading(body);
	const label = readAttribute(metaLines, ["label"]) || heading || id;
	const labelEn = source === "custom" ? label : readAttribute(metaLines, ["labelEn", "label_en"]) || label;
	const description = readAttribute(metaLines, ["description", "desc"]);
	const descriptionEn = readAttribute(metaLines, ["descriptionEn", "description_en"]) || description;
	const tags = splitTagText(readAttribute(metaLines, ["tags", "tag"]));
	const tagsEn = splitTagText(readAttribute(metaLines, ["tagsEn", "tags_en", "tagEn"]));
	const defaultTitle = source === "custom" ? label : readAttribute(metaLines, ["title"]) || heading || label;
	const defaultTitleEn = source === "custom" ? label : readAttribute(metaLines, ["titleEn", "title_en"]) || defaultTitle;
	// Custom templates are always available. Keep the metadata flag only for
	// special built-in entries such as the blank template.
	const hidden = source === "system" && readAttribute(metaLines, ["hidden"]).toLowerCase() === "true";

	return {
		id, label, labelEn, description, descriptionEn, tags,
		tagsEn: tagsEn.length > 0 ? tagsEn : tags,
		body, defaultTitle, defaultTitleEn, hidden, source, editable: source === "custom",
	};
}

function readTemplateDir(dir: string, source: "system" | "custom"): NoteTemplateDefinition[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".md"))
		.map((name) => loadTemplateFile(dir, name, source))
		.filter((item): item is NoteTemplateDefinition => item !== null);
}

function customDir(dataDir: string): string {
	return join(dataDir, "note-templates");
}

function validateId(id: string): string {
	const normalized = id.trim();
	if (!TEMPLATE_ID_PATTERN.test(normalized)) throw new Error("模板 ID 只能包含小写字母、数字和连字符，长度不超过 64 个字符");
	return normalized;
}

function cleanMeta(value: unknown, field: string): string {
	const text = typeof value === "string" ? value.trim() : "";
	if (/[\r\n]/.test(text)) throw new Error(`${field} 不能包含换行`);
	return text;
}

function normalizeInput(input: NoteTemplateInput): Required<NoteTemplateInput> {
	const id = validateId(input.id);
	const label = cleanMeta(input.label, "模板名称");
	const body = typeof input.body === "string" ? input.body : "";
	if (!label) throw new Error("模板名称不能为空");
	if (!body.trim()) throw new Error("模板正文不能为空");
	if (Buffer.byteLength(body, "utf8") > MAX_TEMPLATE_BYTES) throw new Error("模板正文不能超过 256KB");
	const tags = Array.isArray(input.tags) ? input.tags.map((tag) => cleanMeta(tag, "标签")).filter(Boolean) : [];
	const tagsEn = Array.isArray(input.tagsEn) ? input.tagsEn.map((tag) => cleanMeta(tag, "英文标签")).filter(Boolean) : [];
	return {
		id,
		label,
		labelEn: label,
		description: cleanMeta(input.description, "描述"),
		descriptionEn: cleanMeta(input.descriptionEn, "英文描述"),
		tags,
		tagsEn,
		body,
		defaultTitle: label,
		defaultTitleEn: label,
		hidden: false,
	};
}

function serializeTemplate(input: Required<NoteTemplateInput>): string {
	const lines = [
		"---",
		`label: ${input.label}`,
		`labelEn: ${input.labelEn}`,
		`description: ${input.description}`,
		`descriptionEn: ${input.descriptionEn}`,
		`tags: ${input.tags.join(", ")}`,
		`tagsEn: ${input.tagsEn.join(", ")}`,
		`title: ${input.defaultTitle}`,
		`titleEn: ${input.defaultTitleEn}`,
		`hidden: ${input.hidden}`,
		"---",
		"",
	];
	return `${lines.join("\n")}${input.body.replace(/^\s+/, "")}`;
}

function templatePath(dataDir: string, id: string): string {
	const dir = resolve(customDir(dataDir));
	const path = resolve(dir, `${validateId(id)}.md`);
	if (!path.startsWith(`${dir}\\`) && !path.startsWith(`${dir}/`)) throw new Error("Invalid template path");
	return path;
}

function writeAtomic(path: string, content: string): void {
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true });
	const temp = join(dir, `.${basename(path)}.${randomUUID()}.tmp`);
	writeFileSync(temp, content, "utf8");
	renameSync(temp, path);
}

export function listNoteTemplates(codeDir: string, dataDir?: string): NoteTemplateDefinition[] {
	const system = readTemplateDir(join(codeDir, "note-templates"), "system");
	const custom = dataDir ? readTemplateDir(customDir(dataDir), "custom") : [];
	return [...system, ...custom].sort((a, b) => {
		if (a.id === "blank") return -1;
		if (b.id === "blank") return 1;
		if (a.source !== b.source) return a.source === "custom" ? -1 : 1;
		return a.label.localeCompare(b.label, "zh");
	});
}

export function getNoteTemplate(codeDir: string, dataDir: string | undefined, templateId: string): NoteTemplateDefinition | undefined {
	return listNoteTemplates(codeDir, dataDir).find((item) => item.id === templateId);
}

export function createCustomNoteTemplate(codeDir: string, dataDir: string, input: NoteTemplateInput): NoteTemplateDefinition {
	const normalized = normalizeInput(input);
	if (getNoteTemplate(codeDir, dataDir, normalized.id)) throw new Error("模板 ID 已存在");
	writeAtomic(templatePath(dataDir, normalized.id), serializeTemplate(normalized));
	return getNoteTemplate(codeDir, dataDir, normalized.id)!;
}

export function updateCustomNoteTemplate(codeDir: string, dataDir: string, id: string, input: NoteTemplateInput): NoteTemplateDefinition {
	const existing = getNoteTemplate(codeDir, dataDir, id);
	if (!existing) throw new Error("模板不存在");
	if (!existing.editable) throw new Error("内置模板不能修改");
	const normalized = normalizeInput({ ...input, id });
	writeAtomic(templatePath(dataDir, id), serializeTemplate(normalized));
	return getNoteTemplate(codeDir, dataDir, id)!;
}

export function deleteCustomNoteTemplate(codeDir: string, dataDir: string, id: string): void {
	const existing = getNoteTemplate(codeDir, dataDir, id);
	if (!existing) throw new Error("模板不存在");
	if (!existing.editable) throw new Error("内置模板不能删除");
	unlinkSync(templatePath(dataDir, id));
}

export function duplicateNoteTemplate(codeDir: string, dataDir: string, id: string, newId: string): NoteTemplateDefinition {
	const existing = getNoteTemplate(codeDir, dataDir, id);
	if (!existing) throw new Error("模板不存在");
	return createCustomNoteTemplate(codeDir, dataDir, {
		...existing,
		id: newId,
		label: `${existing.label}副本`,
		labelEn: `${existing.labelEn} copy`,
	});
}

export function resolveNoteTemplateContent(
	codeDir: string,
	dataDir: string | undefined,
	options: { templateId?: string; title?: string; tags?: string[]; content?: string },
): { title: string; tags: string[]; body: string } {
	if (options.content?.trim()) return { title: options.title?.trim() || "未命名笔记", tags: options.tags ?? [], body: options.content };
	const template = options.templateId
		? getNoteTemplate(codeDir, dataDir, options.templateId)
		: getNoteTemplate(codeDir, dataDir, "blank");
	if (template) return { title: options.title?.trim() || template.defaultTitle, tags: options.tags ?? template.tags, body: template.body };
	return { title: options.title?.trim() || "未命名笔记", tags: options.tags ?? [], body: "# 未命名笔记\n\n" };
}
