import { Document as YamlDocument, parse as parseYaml } from "yaml";

export interface NoteDraftFrontmatter {
	note_id: string;
	title: string;
	status: "draft";
	created: string;
	updated: string;
}

export interface ParsedNoteDraft {
	frontmatter: NoteDraftFrontmatter | null;
	body: string;
}

function asString(value: unknown): string {
	return typeof value === "string" ? value : value == null ? "" : String(value);
}

/** Parse the minimal metadata needed by an editable note draft. */
export function parseNoteDraft(content: string): ParsedNoteDraft {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
	if (!match) return { frontmatter: null, body: content };

	let raw: Record<string, unknown>;
	try {
		const parsed = parseYaml(match[1]) as unknown;
		raw = parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? parsed as Record<string, unknown>
			: {};
	} catch {
		return { frontmatter: null, body: match[2] };
	}

	const noteId = asString(raw.note_id).trim();
	const created = asString(raw.created).trim();
	const updated = asString(raw.updated).trim();
	if (!noteId || !created || !updated || raw.status !== "draft") {
		return { frontmatter: null, body: match[2] };
	}

	return {
		frontmatter: {
			note_id: noteId,
			title: asString(raw.title).trim(),
			status: "draft",
			created,
			updated,
		},
		body: match[2],
	};
}

/** Serialize draft metadata in a stable on-disk order. */
export function serializeNoteDraft(frontmatter: NoteDraftFrontmatter, body: string): string {
	const document = new YamlDocument({
		note_id: frontmatter.note_id,
		title: frontmatter.title,
		status: frontmatter.status,
		created: frontmatter.created,
		updated: frontmatter.updated,
	});
	return `---\n${document.toString({ lineWidth: 0 })}---\n${body}`;
}

export function extractNoteDraftTitle(body: string, fallback: string): string {
	const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
	return heading || fallback;
}
