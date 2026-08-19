/** Read the small subset of SKILL.md frontmatter needed by the UI. */
export function extractFrontmatterFields(content: string): { description: string; category: string } {
	const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const fmMatch = normalized.match(/^---\n([\s\S]*?)\n---/);
	if (!fmMatch) return { description: "", category: "" };
	const lines = fmMatch[1].split("\n");
	const extractField = (key: string): string => {
		const re = new RegExp(`^${key}:\\s*(.*)$`);
		for (let i = 0; i < lines.length; i++) {
			const match = lines[i].match(re);
			if (!match) continue;
			const inline = match[1].trim();
			if (/^[>|][+-]?\s*$/.test(inline)) {
				const block: string[] = [];
				for (let j = i + 1; j < lines.length; j++) {
					if (/^\s+\S/.test(lines[j]) || lines[j].trim() === "") block.push(lines[j].trim());
					else break;
				}
				return block.join(" ").replace(/\s+/g, " ").trim();
			}
			return inline.replace(/^["']|["']$/g, "").trim();
		}
		return "";
	};
	return { description: extractField("description"), category: extractField("category") };
}
