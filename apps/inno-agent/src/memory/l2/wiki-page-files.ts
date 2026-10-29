import { readdirSync, type Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { resolveContainedPathAsync } from "../../utils/path-safety.js";
import { join } from "node:path";

const ROOT_NON_PAGE_FILES = new Set([
	"wiki/index.md",
	"wiki/log.md",
	"wiki/overview.md",
	"wiki/SCHEMA.md",
	"wiki/PURPOSE.md",
]);

/**
 * Enumerate wiki content recursively instead of assuming a fixed set of
 * built-in folders. Schema-defined page types may live in arbitrary safe
 * subdirectories beneath `wiki/`.
 */
export function listWikiPagePaths(l2DataDir: string): string[] {
	const root = join(l2DataDir, "wiki");
	const paths: string[] = [];
	const visit = (absoluteDir: string, relativeDir: string): void => {
		let entries: Dirent[];
		try {
			entries = readdirSync(absoluteDir, { withFileTypes: true }) as Dirent[];
		} catch {
			return;
		}
		for (const entry of entries) {
			const relativePath = `${relativeDir}/${entry.name}`.replaceAll("\\", "/");
			if (entry.isDirectory()) {
				visit(join(absoluteDir, entry.name), relativePath);
			} else if (entry.isFile() && entry.name.endsWith(".md") && !ROOT_NON_PAGE_FILES.has(relativePath)) {
				paths.push(relativePath);
			}
		}
	};
	visit(root, "wiki");
	return paths.sort((a, b) => a.localeCompare(b, "zh-CN"));
}

/** Non-blocking enumeration for HTTP search and index backfill. */
export async function listWikiPagePathsAsync(l2DataDir: string): Promise<string[]> {
	const paths: string[] = [];
	const visit = async (relativeDir: string): Promise<void> => {
		const dir = await resolveContainedPathAsync(l2DataDir, relativeDir);
		if (!dir) return;
		let entries: Dirent[];
		try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
		for (const entry of entries) {
			const relativePath = `${relativeDir}/${entry.name}`;
			if (entry.isDirectory()) await visit(relativePath);
			else if (entry.isFile() && entry.name.endsWith(".md") && !ROOT_NON_PAGE_FILES.has(relativePath)) paths.push(relativePath);
		}
	};
	await visit("wiki");
	return paths.sort((a, b) => a.localeCompare(b, "zh-CN"));
}
