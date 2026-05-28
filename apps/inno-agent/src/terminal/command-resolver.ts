import { extname } from "node:path";

/**
 * Derive a default shell command for running a workspace file.
 * Returns null when the file kind is not directly runnable.
 */
export function defaultRunCommand(relPath: string): string | null {
	const ext = extname(relPath).toLowerCase();
	const quoted = relPath.includes(" ") || relPath.includes("'") ? `"${relPath.replace(/"/g, '\\"')}"` : relPath;
	switch (ext) {
		case ".py":
			return `python ${quoted}`;
		case ".js":
		case ".mjs":
		case ".cjs":
			return `node ${quoted}`;
		case ".ts":
		case ".tsx":
			return `npx tsx ${quoted}`;
		case ".sh":
		case ".bash":
		case ".zsh":
			return `bash ${quoted}`;
		default:
			return null;
	}
}

export function isRunnable(relPath: string): boolean {
	return defaultRunCommand(relPath) !== null;
}
