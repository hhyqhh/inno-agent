import { writeFileSync } from "node:fs";
import path from "node:path";

/** Upper bound for source content shipped with a `run` event (256 KiB). */
export const MAX_RUN_FILE_CONTENT_LENGTH = 256 * 1024;

/**
 * Resolves where a `run` event's source content should be written. Only bare
 * filenames are accepted — anything with path segments, traversal, or a
 * Windows-style separator is rejected so the write can never escape `cwd`.
 * Returns null for an unusable name.
 */
export function resolveRunFilePath(cwd: string, sourceFile: string): string | null {
	const trimmed = sourceFile.trim();
	if (!trimmed || trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("\0")) return null;
	const name = path.basename(trimmed);
	if (!name || name === "." || name === ".." || name !== trimmed) return null;
	return path.join(cwd, name);
}

/**
 * Writes a `run` event's source content into the terminal's working directory.
 * Returns the absolute path written, or throws with a user-facing message.
 */
export function writeRunFile(cwd: string, sourceFile: string, content: string): string {
	if (content.length > MAX_RUN_FILE_CONTENT_LENGTH) {
		throw new Error("Run file content too large");
	}
	const target = resolveRunFilePath(cwd, sourceFile);
	if (!target) {
		throw new Error(`Invalid run file name: ${sourceFile}`);
	}
	writeFileSync(target, content, "utf8");
	return target;
}
