import type { WikiPageFrontmatter, WikiPageType } from "../types/wiki.js";
import { parseFrontmatter, serializeFrontmatter } from "../utils/frontmatter.js";

const TYPE_DIRS: Record<WikiPageType, string> = {
	"source-summary": "wiki/sources",
	entity: "wiki/entities",
	concept: "wiki/concepts",
	analysis: "wiki/analysis",
};

function slugify(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 50) || "import";
}

function titleFromFilename(filename: string): string {
	return filename.replace(/\.md$/i, "").trim() || "import";
}

function defaultFrontmatter(title: string, type: WikiPageType = "source-summary"): WikiPageFrontmatter {
	const today = new Date().toISOString().slice(0, 10);
	return {
		title,
		created: today,
		type,
		tags: [],
		sources: [],
		source_ids: [],
		updated: today,
		status: "draft",
		confidence: "medium",
	};
}

function newWikiPath(type: WikiPageType, title: string): string {
	const date = new Date().toISOString().slice(0, 10);
	const suffix = crypto.randomUUID().slice(0, 6);
	return `${TYPE_DIRS[type]}/${slugify(title)}-${date}-${suffix}.md`;
}

/** Prepare markdown file content and target wiki path for import (KM-style import .md). */
export function prepareWikiMarkdownImport(
	raw: string,
	filename: string,
): { path: string; content: string; title: string } {
	const text = raw.replace(/^\uFEFF/, "");
	const fallbackTitle = titleFromFilename(filename);
	const parsed = parseFrontmatter(text);

	if (parsed.frontmatter) {
		const type = parsed.frontmatter.type ?? "source-summary";
		const title = parsed.frontmatter.title || fallbackTitle;
		return { path: newWikiPath(type, title), content: text, title };
	}

	const title = fallbackTitle;
	const body = text.trim() ? text : `# ${title}\n\n`;
	const fm = defaultFrontmatter(title);
	const content = `${serializeFrontmatter(fm)}\n\n${body}`;
	return { path: newWikiPath(fm.type, title), content, title };
}
