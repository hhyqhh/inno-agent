import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ensureDir, writeText } from "../../storage/file-store.js";
import type { RawSourceType } from "./types.js";

/** Map source type to subdirectory under raw/. */
const TYPE_DIR_MAP: Record<RawSourceType, string> = {
	text: "uploads",
	markdown: "uploads",
	conversation: "conversations",
	pdf: "uploads",
	word: "uploads",
	image: "uploads",
};

function generateFilename(title: string, sourceType: RawSourceType): string {
	const date = new Date().toISOString().slice(0, 10);
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 50);
	const ext = sourceType === "markdown" ? "md" : "txt";
	return `${date}-${slug}-${randomUUID().slice(0, 6)}.${ext}`;
}

function rawFrontmatter(content: string, sourceType: RawSourceType, sourceUrl?: string): string {
	const today = new Date().toISOString().slice(0, 10);
	const sha256 = createHash("sha256").update(content).digest("hex");
	return [
		"---",
		...(sourceUrl ? [`source_url: ${JSON.stringify(sourceUrl)}`] : []),
		`source_type: ${sourceType}`,
		`ingested: ${today}`,
		`sha256: ${sha256}`,
		"---",
		"",
	].join("\n");
}

/**
 * Save raw content to data/l2/raw/<subdir>/<filename>.
 * Returns the relative path from l2DataDir.
 */
export function saveRaw(
	l2DataDir: string,
	title: string,
	content: string,
	sourceType: RawSourceType,
	sourceUrl?: string,
): string {
	const subdir = TYPE_DIR_MAP[sourceType];
	const dir = join(l2DataDir, "raw", subdir);
	ensureDir(dir);
	const filename = generateFilename(title, sourceType);
	writeText(join(dir, filename), rawFrontmatter(content, sourceType, sourceUrl) + content);
	return join("raw", subdir, filename);
}
