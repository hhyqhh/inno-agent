/**
 * Normalize AI-generated Markdown into a conservative shape that Milkdown/Crepe
 * can open reliably. Files remain Markdown; this only removes common wrappers
 * and raw HTML fragments that make rich-text editing unreliable.
 */
export function normalizeMarkdownForMilkdown(markdown: string): string {
	let text = markdown
		.replace(/\r\n?/g, "\n")
		.replace(/\u0000/g, "")
		.replace(/\t/g, "  ")
		.trim();

	const fenced = text.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i);
	if (fenced) text = fenced[1].trim();

	text = text
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p>\s*<p>/gi, "\n\n")
		.replace(/<\/?p>/gi, "")
		.replace(/<!--[\s\S]*?-->/g, "")
		.split("\n")
		.map((line) => line.replace(/[ \u00a0]+$/g, ""))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/([^\n])\n(#{1,6}\s+)/g, "$1\n\n$2")
		.replace(/([^\n])\n([-*+]\s+)/g, "$1\n\n$2");

	return `${text.trim()}\n`;
}
