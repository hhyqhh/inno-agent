/**
 * Symlink-aware path containment checks, shared by the HTTP file endpoints
 * (server/file-helpers.ts) and the agent-side workspace path guard
 * (agent/workspace-path-guard.ts).
 *
 * A purely lexical `resolve` + `relative` check is not enough for paths that
 * may contain symlinks: a symlink planted inside an allowed root (e.g. by the
 * agent's bash tool inside a workspace) lets a request escape to any file on
 * the host. The checks here resolve the closest *existing* ancestor through
 * `realpathSync` and project the non-existent suffix from there, so symlink
 * escapes are caught for both reads and writes.
 *
 * "Existing" is determined with `lstatSync`, not `existsSync`: `existsSync`
 * follows links, so a *dangling* symlink (target missing) would look like a
 * non-existent suffix and skip the realpath check — and a subsequent write
 * would follow the link and create the file outside the root. With lstat the
 * symlink itself counts as existing, and `realpathSync` on a dangling link
 * throws, which fails closed.
 */

import { lstatSync, realpathSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export function isWithin(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/**
 * Closest ancestor of `target` that exists, where a symlink itself counts as
 * existing even when its target does not (see module header). Returns null
 * when nothing exists or a component cannot be inspected.
 */
export function findExistingAncestor(target: string): string | null {
	let current = target;
	for (;;) {
		try {
			lstatSync(current);
			return current;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			// Only "not there" keeps the walk going; anything else (EACCES,
			// ELOOP, ...) fails closed instead of skipping past a component
			// we cannot inspect.
			if (code !== "ENOENT" && code !== "ENOTDIR") return null;
			const parent = dirname(current);
			if (parent === current) return null;
			current = parent;
		}
	}
}

/**
 * Canonicalize a containment root. The root itself may contain symlink
 * components (e.g. macOS /tmp → /private/tmp); children's realpaths never
 * match a non-canonical root, which would silently reject every legitimate
 * path. Falls back to the lexical path when the root does not exist yet.
 */
export function canonicalContainmentRoot(dir: string): string {
	try {
		return realpathSync(dir);
	} catch {
		return dir;
	}
}

/**
 * Canonicalize a path that may not exist yet: realpath the closest existing
 * ancestor and project the missing suffix from there. Unlike a bare
 * realpath-or-lexical fallback, this stays correct when the path is missing
 * but an ancestor contains a symlink (macOS /var → /private/var, symlinked
 * $HOME) — the mixed lexical/canonical comparison would otherwise reject
 * every legitimate path under the not-yet-created directory.
 */
function canonicalizePossiblyMissing(target: string): string | null {
	const ancestor = findExistingAncestor(target);
	if (!ancestor) return null;
	try {
		return resolve(realpathSync(ancestor), relative(ancestor, target));
	} catch {
		return null;
	}
}

/**
 * Resolve `userPath` against `baseDir` and verify that the canonical
 * (symlink-resolved) target stays inside the canonical base. Returns the
 * lexically resolved path (not the canonical one — callers keep their
 * existing path semantics) or null when the path escapes.
 */
export function resolveContainedPath(baseDir: string, userPath: string): string | null {
	try {
		const resolvedBase = resolve(baseDir);
		const resolvedPath = resolve(resolvedBase, userPath);
		// Fast lexical reject before touching the filesystem.
		if (!isWithin(resolvedBase, resolvedPath)) return null;

		// The base may not exist yet (e.g. the L2 dir before the first wiki
		// page is written); canonicalize it through its own existing ancestor
		// so a symlinked ancestor cannot make every legitimate path mismatch.
		const canonicalBase = canonicalizePossiblyMissing(resolvedBase);
		if (!canonicalBase) return null;
		const canonicalTarget = canonicalizePossiblyMissing(resolvedPath);
		if (!canonicalTarget) return null;
		if (!isWithin(canonicalBase, canonicalTarget)) return null;

		return resolvedPath;
	} catch {
		return null;
	}
}

/** Async counterpart for request-time reads; dangling links still fail closed. */
export async function resolveContainedPathAsync(baseDir: string, userPath: string): Promise<string | null> {
	const canonicalize = async (target: string): Promise<string | null> => {
		let ancestor = target;
		for (;;) {
			try {
				await lstat(ancestor);
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code !== "ENOENT" && code !== "ENOTDIR") return null;
				const parent = dirname(ancestor);
				if (parent === ancestor) return null;
				ancestor = parent;
				continue;
			}
			// lstat succeeded, so realpath failure (including a dangling link) fails closed.
			try { return resolve(await realpath(ancestor), relative(ancestor, target)); } catch { return null; }
		}
	};
	const base = resolve(baseDir);
	const target = resolve(base, userPath);
	if (!isWithin(base, target)) return null;
	const [canonicalBase, canonicalTarget] = await Promise.all([canonicalize(base), canonicalize(target)]);
	return canonicalBase && canonicalTarget && isWithin(canonicalBase, canonicalTarget) ? target : null;
}
