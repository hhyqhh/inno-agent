export interface FrontmatterAttribute {
	key: string;
	value: string;
}

export interface ParsedMarkdownFrontmatter {
	attributes: FrontmatterAttribute[];
	body: string;
	hasFrontmatter: boolean;
}

const FRONTMATTER_PATTERN = /^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n)?([\s\S]*)$/;

export function parseFrontmatter(markdown: string): ParsedMarkdownFrontmatter {
	const match = markdown.match(FRONTMATTER_PATTERN);
	if (!match) {
		return { attributes: [], body: markdown, hasFrontmatter: false };
	}

	const attributes: FrontmatterAttribute[] = [];
	for (const line of match[1].split(/\r?\n/)) {
		const property = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!property) {
			if (line.trim() && attributes.length > 0) {
				attributes[attributes.length - 1].value = `${attributes[attributes.length - 1].value}\n${line.trim()}`;
			}
			continue;
		}
		attributes.push({ key: property[1], value: property[2] });
	}

	return { attributes, body: match[2], hasFrontmatter: true };
}

export function serializeFrontmatter(parsed: ParsedMarkdownFrontmatter, body: string): string {
	if (!parsed.hasFrontmatter && parsed.attributes.length === 0) {
		return body;
	}
	const lines = parsed.attributes
		.filter((attribute) => attribute.key.trim())
		.map((attribute) => `${attribute.key.trim()}: ${attribute.value}`);
	const bodySeparator = body ? "\n" : "";
	return `---\n${lines.join("\n")}\n---${bodySeparator}${body}`;
}

export function parseTagList(value: string): string[] {
	const trimmed = value.trim();
	if (!trimmed) return [];
	const normalizedValue = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
	return normalizedValue
		.split(/[,，;；、|/\n]/)
		.map((tag) => tag.trim().replace(/^#+/, "").replace(/^-+\s*/, ""))
		.filter(Boolean);
}

export function serializeTagList(tags: string[]): string {
	return tags.map((tag) => tag.trim().replace(/^#+/, "")).filter(Boolean).join(", ");
}

export function isTagsKey(key: string): boolean {
	const normalized = key.trim().toLowerCase();
	return normalized === "tags" || normalized === "tag";
}

export function isTitleKey(key: string): boolean {
	const normalized = key.trim().toLowerCase();
	return normalized === "name" || normalized === "title";
}

export function isRecordDateKey(key: string): boolean {
	return key.trim().toLowerCase().replace(/_/g, "") === "recorddate";
}

export function getTodayRecordDate(): string {
	const now = new Date();
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function createDefaultNoteAttributes(
	title: string,
	tags: string[] = [],
	recordDate: string = getTodayRecordDate(),
): FrontmatterAttribute[] {
	return [
		{ key: "title", value: title },
		{ key: "recordDate", value: recordDate },
		{ key: "tags", value: serializeTagList(tags) },
	];
}

export function ensureRecordDateAttribute(parsed: ParsedMarkdownFrontmatter): ParsedMarkdownFrontmatter {
	if (parsed.attributes.some((attribute) => isRecordDateKey(attribute.key))) {
		return parsed;
	}
	const titleIndex = parsed.attributes.findIndex((attribute) => isTitleKey(attribute.key));
	const insertIndex = titleIndex >= 0 ? titleIndex + 1 : parsed.attributes.length;
	const attributes = [...parsed.attributes];
	attributes.splice(insertIndex, 0, { key: "recordDate", value: getTodayRecordDate() });
	return { ...parsed, attributes };
}

type EditorFrontmatter = ParsedMarkdownFrontmatter & { implicit?: boolean };

export type { EditorFrontmatter };

export function ensureTagsAttribute(parsed: ParsedMarkdownFrontmatter): ParsedMarkdownFrontmatter {
	if (parsed.attributes.some((attribute) => isTagsKey(attribute.key))) {
		return parsed;
	}
	const recordDateIndex = parsed.attributes.findIndex((attribute) => isRecordDateKey(attribute.key));
	const titleIndex = parsed.attributes.findIndex((attribute) => isTitleKey(attribute.key));
	const insertIndex =
		recordDateIndex >= 0 ? recordDateIndex + 1 : titleIndex >= 0 ? titleIndex + 1 : parsed.attributes.length;
	const attributes = [...parsed.attributes];
	attributes.splice(insertIndex, 0, { key: "tags", value: "" });
	return { ...parsed, attributes };
}

export function parseEditorFrontmatter(markdown: string): EditorFrontmatter {
	const parsed = parseFrontmatter(markdown);
	if (parsed.hasFrontmatter || parsed.attributes.length > 0) {
		return ensureTagsAttribute(ensureRecordDateAttribute(parsed));
	}
	return {
		...parsed,
		attributes: createDefaultNoteAttributes(""),
		implicit: true,
	};
}

export function serializeEditorFrontmatter(parsed: EditorFrontmatter, body: string): string {
	if (parsed.implicit) return body;
	return serializeFrontmatter(parsed, body);
}
