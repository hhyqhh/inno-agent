/**
 * Normalize AI-generated Markdown into a conservative shape that Milkdown/Crepe
 * can open reliably. This does not change the storage format: files are still
 * Markdown, but we avoid common LLM output patterns that break rich editors.
 */
export function normalizeMarkdownForMilkdown(markdown: string): string {
	let text = markdown
		.replace(/\r\n?/g, "\n")
		.replace(/\u0000/g, "")
		.replace(/\t/g, "  ")
		.trim();

	// LLMs sometimes wrap the whole answer in a markdown fence.
	const fenced = text.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i);
	if (fenced) {
		text = fenced[1].trim();
	}

	// Keep content editable in Milkdown by avoiding raw HTML where possible.
	text = text
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p>\s*<p>/gi, "\n\n")
		.replace(/^<p>/i, "")
		.replace(/<\/p>$/i, "")
		.replace(/<!--[\s\S]*?-->/g, "");

	// Ensure headings/lists are separated from adjacent paragraphs.
	text = text
		.split("\n")
		.map((line) => line.replace(/[ \u00a0]+$/g, ""))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/([^\n])\n(#{1,6}\s+)/g, "$1\n\n$2")
		.replace(/([^\n])\n([-*+]\s+)/g, "$1\n\n$2");

	return `${text.trim()}\n`;
}
