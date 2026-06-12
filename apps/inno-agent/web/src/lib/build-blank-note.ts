function slugify(title: string): string {
	return (
		title
			.toLowerCase()
			.replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 50) || "note"
	);
}

function noteFileName(title: string): string {
	const date = new Date().toISOString().slice(0, 10);
	const suffix = crypto.randomUUID().slice(0, 6);
	return `${slugify(title)}-${date}-${suffix}.md`;
}

function serializeNoteMarkdown(title: string, body: string): string {
	const today = new Date().toISOString().slice(0, 10);
	return ["---", `title: ${title}`, `recordDate: ${today}`, "tags:", "---", "", body].join("\n");
}

/** Build a blank draft note stored under raw/notes/. */
export function buildBlankNote(language: "zh" | "en"): { fileName: string; content: string; title: string } {
	const title = language === "zh" ? "未命名笔记" : "Untitled note";
	const body = `# ${title}\n`;
	return {
		fileName: noteFileName(title),
		content: serializeNoteMarkdown(title, body),
		title,
	};
}
