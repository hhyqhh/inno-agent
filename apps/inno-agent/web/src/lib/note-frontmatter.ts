export interface ParsedNoteFrontmatter {
	attributes: { key: string; value: string }[];
	body: string;
	hasFrontmatter: boolean;
}

const FRONTMATTER_PATTERN = /^(?:\uFEFF)?---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

export function parseNoteFrontmatter(markdown: string): ParsedNoteFrontmatter {
	const match = markdown.match(FRONTMATTER_PATTERN);
	if (!match) {
		return { attributes: [], body: markdown, hasFrontmatter: false };
	}

	const attributes: { key: string; value: string }[] = [];
	for (const line of match[1].split("\n")) {
		const property = line.match(/^(\w+):\s*(.*)$/);
		if (!property) continue;
		attributes.push({ key: property[1], value: property[2] });
	}

	return { attributes, body: match[2], hasFrontmatter: true };
}

export function getFrontmatterAttribute(
	parsed: ParsedNoteFrontmatter,
	keys: string[],
): { key: string; value: string } | undefined {
	for (const key of keys) {
		const found = parsed.attributes.find((item) => item.key === key);
		if (found) return found;
	}
	return undefined;
}

export function parseTagList(value: string): string[] {
	const trimmed = value.trim();
	if (!trimmed) return [];
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		return trimmed
			.slice(1, -1)
			.split(",")
			.map((tag) => tag.trim().replace(/^["']|["']$/g, ""))
			.filter(Boolean);
	}
	return trimmed
		.split(/[\s,\uFF0C;\uFF1B\u3001|]+/)
		.map((tag) => tag.trim())
		.filter(Boolean);
}

export function serializeTagList(tags: string[]): string {
	return tags.map((tag) => tag.trim()).filter(Boolean).join(", ");
}

export function getTodayRecordDate(): string {
	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

export function normalizeRecordDateValue(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) return "";
	if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
	const slashMatch = trimmed.match(/^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/);
	if (slashMatch) {
		return `${slashMatch[1]}-${slashMatch[2].padStart(2, "0")}-${slashMatch[3].padStart(2, "0")}`;
	}
	const parsed = new Date(trimmed);
	if (!Number.isNaN(parsed.getTime())) {
		return getTodayRecordDateFromDate(parsed);
	}
	return "";
}

export function getTodayRecordDateFromDate(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

export function parseRecordDate(value: string): Date | null {
	const normalized = normalizeRecordDateValue(value);
	const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (!match) return null;
	const year = Number(match[1]);
	const month = Number(match[2]) - 1;
	const day = Number(match[3]);
	const date = new Date(year, month, day);
	if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) {
		return null;
	}
	return date;
}

export function toRecordDateString(date: Date): string {
	return getTodayRecordDateFromDate(date);
}

export function formatRecordDateDisplay(value: string, language: "zh" | "en"): string {
	const date = parseRecordDate(value);
	if (!date) {
		return language === "en" ? "Select date" : "选择日期";
	}
	if (language === "en") {
		return date.toLocaleDateString("en-US", {
			weekday: "short",
			year: "numeric",
			month: "short",
			day: "numeric",
		});
	}
	const weekdayLabels = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
	return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${weekdayLabels[date.getDay()]}`;
}

export function extractNoteTitle(body: string, fallback: string): string {
	const match = body.match(/^#\s+(.+)$/m);
	return match?.[1]?.trim() || fallback;
}
