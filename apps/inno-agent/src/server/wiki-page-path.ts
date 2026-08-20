import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, resolve, win32 } from "node:path";

export type WikiPagePathIntent = "read" | "write" | "delete";

export interface AllowedWikiPagePath {
	relativePath: string;
	absolutePath: string;
}

const DRIVE_PREFIX = /^[A-Za-z]:/u;
const ALLOWED_WIKI_PAGE = /^wiki\/(?:sources|entities|concepts|analysis)\/[^/]+\.md$/u;
const WINDOWS_FORBIDDEN_OR_CONTROL = /[\u0000-\u001f<>:"|?*]/u;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

function sameFilesystemPath(left: string, right: string): boolean {
	return process.platform === "win32"
		? left.toLowerCase() === right.toLowerCase()
		: left === right;
}

function normalizeRequestedPath(requestedPath: string): string | null {
	if (
		requestedPath.length === 0
		|| requestedPath.includes("\0")
		|| isAbsolute(requestedPath)
		|| win32.isAbsolute(requestedPath)
		|| DRIVE_PREFIX.test(requestedPath)
	) {
		return null;
	}

	const normalized = requestedPath.replace(/\\/gu, "/");
	const segments = normalized.split("/");
	const fileName = segments[2] ?? "";
	if (
		segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
		|| !ALLOWED_WIKI_PAGE.test(normalized)
		|| fileName.length <= ".md".length
		|| WINDOWS_FORBIDDEN_OR_CONTROL.test(fileName)
		|| WINDOWS_RESERVED_NAME.test(fileName)
	) {
		return null;
	}
	return normalized;
}

function canonicalL2Root(l2DataDir: string): string | null {
	try {
		const inputPath = resolve(l2DataDir);
		const stats = lstatSync(inputPath);
		if (stats.isSymbolicLink() || !stats.isDirectory()) return null;
		const canonicalPath = realpathSync.native(inputPath);
		return sameFilesystemPath(inputPath, canonicalPath) ? canonicalPath : null;
	} catch {
		return null;
	}
}

function ensurePlainDirectory(candidate: string): string | null {
	try {
		mkdirSync(candidate);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") return null;
	}

	try {
		const stats = lstatSync(candidate);
		if (stats.isSymbolicLink() || !stats.isDirectory()) return null;
		const canonicalPath = realpathSync.native(candidate);
		return sameFilesystemPath(candidate, canonicalPath) ? canonicalPath : null;
	} catch {
		return null;
	}
}

/** Resolve the only file shape exposed by the Wiki page CRUD routes. */
export function resolveAllowedWikiPage(
	l2DataDir: string,
	requestedPath: string,
	intent: WikiPagePathIntent,
): AllowedWikiPagePath | null {
	if (intent !== "read" && intent !== "write" && intent !== "delete") return null;
	const relativePath = normalizeRequestedPath(requestedPath);
	const root = canonicalL2Root(l2DataDir);
	if (relativePath === null || root === null) return null;

	const segments = relativePath.split("/");
	let parent = root;
	for (const [ordinal, segment] of segments.entries()) {
		const candidate = join(parent, segment);
		let stats;
		try {
			stats = lstatSync(candidate);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				if (ordinal === segments.length - 1) return { relativePath, absolutePath: candidate };
				if (intent !== "write") {
					return {
						relativePath,
						absolutePath: resolve(parent, ...segments.slice(ordinal)),
					};
				}
				const createdDirectory = ensurePlainDirectory(candidate);
				if (createdDirectory === null) return null;
				parent = createdDirectory;
				continue;
			}
			return null;
		}

		if (stats.isSymbolicLink()) return null;
		const target = ordinal === segments.length - 1;
		if ((target && !stats.isFile()) || (!target && !stats.isDirectory())) return null;

		let canonical: string;
		try {
			canonical = realpathSync.native(candidate);
		} catch {
			return null;
		}
		if (!sameFilesystemPath(candidate, canonical)) return null;
		parent = canonical;
	}

	return {
		relativePath: `${segments[0]}/${segments[1]}/${basename(parent)}`,
		absolutePath: parent,
	};
}
