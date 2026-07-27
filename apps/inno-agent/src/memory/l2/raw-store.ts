import { join, extname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync } from "node:fs";
import { ensureDir, writeText } from "../../storage/file-store.js";
import type { RawSourceType } from "./types.js";
import { slugifyTitle } from "./l2-utils.js";

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
	const slug = slugifyTitle(title, 50, "source");
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

/**
 * Copy an original binary file to data/l2/raw/<subdir>/<filename>.
 * Used for PDF/Word/Image files where we preserve the original.
 * Returns the relative path from l2DataDir.
 */
export function saveRawFile(
	l2DataDir: string,
	title: string,
	originalFilePath: string,
	sourceType: RawSourceType,
): string {
	const subdir = TYPE_DIR_MAP[sourceType];
	const dir = join(l2DataDir, "raw", subdir);
	ensureDir(dir);
	const date = new Date().toISOString().slice(0, 10);
	const slug = slugifyTitle(title, 50, "source");
	const ext = extname(originalFilePath);
	const filename = `${date}-${slug}-${randomUUID().slice(0, 6)}${ext}`;
	copyFileSync(originalFilePath, join(dir, filename));
	return join("raw", subdir, filename);
}
