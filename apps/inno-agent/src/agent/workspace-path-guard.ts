import { existsSync, lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface WorkspacePathCheck {
	allowed: boolean;
	resolvedPath?: string;
	reason?: "invalid_path" | "outside_workspace" | "workspace_unavailable";
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** Match the normalization performed by PI's built-in file tools. */
function normalizeToolPath(input: string): string {
	let normalized = input.replace(UNICODE_SPACES, " ");
	if (normalized.startsWith("@")) normalized = normalized.slice(1);
	if (normalized === "~") return homedir();
	if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
		return join(homedir(), normalized.slice(2));
	}
	if (/^file:\/\//.test(normalized)) return fileURLToPath(normalized);
	return normalized;
}

function isWithin(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function findExistingAncestor(target: string): string | null {
	let current = target;
	while (true) {
		try {
			lstatSync(current);
			return current;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
		}
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

/** Resolve a path while ensuring existing symlinks cannot escape the root. */
export function checkPathWithinRoot(rootDir: string, requestedPath: string): WorkspacePathCheck {
	try {
		const canonicalRoot = realpathSync(rootDir);
		const resolvedPath = resolve(rootDir, requestedPath);
		const existingAncestor = findExistingAncestor(resolvedPath);
		if (!existingAncestor) {
			return { allowed: false, resolvedPath, reason: "invalid_path" };
		}

		const canonicalAncestor = realpathSync(existingAncestor);
		const unresolvedSuffix = relative(existingAncestor, resolvedPath);
		const canonicalTarget = resolve(canonicalAncestor, unresolvedSuffix);
		if (!isWithin(canonicalRoot, canonicalTarget)) {
			return { allowed: false, resolvedPath, reason: "outside_workspace" };
		}

		return { allowed: true, resolvedPath };
	} catch {
		return {
			allowed: false,
			reason: existsSync(rootDir) ? "invalid_path" : "workspace_unavailable",
		};
	}
}

/**
 * Check where a write/edit path will land after resolving existing symlinks.
 * Non-existent suffixes are projected from the closest existing ancestor.
 */
export function checkWorkspaceMutationPath(workspaceDir: string, requestedPath: string): WorkspacePathCheck {
	if (!requestedPath.trim()) return { allowed: false, reason: "invalid_path" };

	try {
		return checkPathWithinRoot(workspaceDir, normalizeToolPath(requestedPath));
	} catch {
		return {
			allowed: false,
			reason: existsSync(workspaceDir) ? "invalid_path" : "workspace_unavailable",
		};
	}
}
