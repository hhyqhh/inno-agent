import type { WikiPageFrontmatter, WikiPageType, WikiPageStatus, ConfidenceLevel } from "../types/wiki.js";

/**
 * Parse YAML frontmatter from markdown content.
 * Ported from backend src/memory/l2/wiki-maintainer.ts
 */
export function parseFrontmatter(content: string): { frontmatter: WikiPageFrontmatter | null; body: string } {
	const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (!match) return { frontmatter: null, body: content };

	const yamlBlock = match[1];
	const body = match[2];
	const fm: Record<string, unknown> = {};
	let currentKey = "";
	let currentArray: string[] = [];

	for (const line of yamlBlock.split("\n")) {
		const kvMatch = line.match(/^(\w+):\s*(.*)$/);
		if (kvMatch) {
			if (currentKey && currentArray.length > 0) {
				fm[currentKey] = currentArray;
				currentArray = [];
			}
			currentKey = kvMatch[1];
			const value = kvMatch[2].trim();
			if (value.startsWith("[") && value.endsWith("]")) {
				fm[currentKey] = value
					.slice(1, -1)
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean);
				currentKey = "";
			} else if (value === "") {
				// Array items follow
			} else {
				fm[currentKey] = value;
				currentKey = "";
			}
		} else {
			const itemMatch = line.match(/^\s+-\s+(.+)$/);
			if (itemMatch) {
				currentArray.push(itemMatch[1]);
			}
		}
	}
	if (currentKey && currentArray.length > 0) {
		fm[currentKey] = currentArray;
	}

	function parseScalar(value: unknown): string {
		if (typeof value !== "string") return "";
		if (!value.startsWith("\"")) return value;
		try {
			const parsed = JSON.parse(value) as unknown;
			return typeof parsed === "string" ? parsed : value;
		} catch {
			return value;
		}
	}

	return {
		frontmatter: {
			title: parseScalar(fm.title),
			created: (fm.created as string) ?? (fm.updated as string) ?? "",
			type: (fm.type as WikiPageType) ?? "source-summary",
			tags: (fm.tags as string[]) ?? [],
			sources: (fm.sources as string[]) ?? [],
			source_ids: (fm.source_ids as string[]) ?? [],
			updated: (fm.updated as string) ?? "",
			status: (fm.status as WikiPageStatus) ?? "draft",
			confidence: (fm.confidence as ConfidenceLevel) ?? "medium",
			contested: fm.contested === "true" ? true : fm.contested === "false" ? false : undefined,
			contradictions: (fm.contradictions as string[]) ?? [],
		},
		body,
	};
}

function yamlQuote(v: string): string {
	if (/[:\[\]{},#&*!|>'"%@`\n]/.test(v) || v.trim() !== v || v === "") {
		return JSON.stringify(v);
	}
	return v;
}

export function serializeFrontmatter(fm: WikiPageFrontmatter): string {
	const lines = [
		"---",
		`title: ${yamlQuote(fm.title)}`,
		`created: ${fm.created || fm.updated}`,
		`type: ${fm.type}`,
		`tags: [${fm.tags.map((t) => yamlQuote(t)).join(", ")}]`,
		"sources:",
		...fm.sources.map((s) => `  - ${yamlQuote(s)}`),
		"source_ids:",
		...fm.source_ids.map((id) => `  - ${id}`),
		`updated: ${fm.updated}`,
		`status: ${fm.status}`,
		`confidence: ${fm.confidence}`,
		...(fm.contested !== undefined ? [`contested: ${fm.contested ? "true" : "false"}`] : []),
		...(fm.contradictions && fm.contradictions.length > 0
			? ["contradictions:", ...fm.contradictions.map((id) => `  - ${yamlQuote(id)}`)]
			: []),
		"---",
	];
	return lines.join("\n");
}
