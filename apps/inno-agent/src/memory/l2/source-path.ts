import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve, win32 } from "node:path";

import type { ManifestEntry } from "./types.js";

declare const validatedRawPathBrand: unique symbol;
declare const validatedEvidencePathBrand: unique symbol;

export type ValidatedRawPath = string & { readonly [validatedRawPathBrand]: true };
export type ValidatedEvidencePath = string & { readonly [validatedEvidencePathBrand]: true };

export type RawSourcePathResolution =
	| {
		status: "ready";
		rawAbsolutePath: ValidatedRawPath;
		rawRelativePath: string;
	}
	| { status: "missing-file"; rawRelativePath: string }
	| { status: "unsafe-path" };

export type SourcePathResolution =
	| {
		status: "ready";
		rawAbsolutePath: ValidatedRawPath;
		rawRelativePath: string;
		evidenceIndexAbsolutePath: ValidatedEvidencePath;
	}
	| {
		status: "missing-file";
		rawRelativePath: string;
		evidenceIndexAbsolutePath: ValidatedEvidencePath;
	}
	| { status: "unsafe-path" };

type CheckedPath =
	| { status: "ready"; canonicalPath: string }
	| { status: "missing"; projectedPath: string }
	| { status: "unsafe" };

const DRIVE_PREFIX = /^[A-Za-z]:/u;
const WINDOWS_FORBIDDEN_OR_CONTROL = /[\u0000-\u001f<>:"|?*]/u;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

function sourceIdHash(sourceId: string): string {
	return createHash("sha256").update(sourceId, "utf8").digest("hex");
}

function equalFilesystemPath(left: string, right: string): boolean {
	return process.platform === "win32"
		? left.toLowerCase() === right.toLowerCase()
		: left === right;
}

function normalizeRawRelativePath(value: unknown): string | null {
	if (typeof value !== "string" || value.length === 0 || value.includes("\0")) return null;
	if (isAbsolute(value) || win32.isAbsolute(value) || DRIVE_PREFIX.test(value)) return null;

	const normalized = value.replace(/\\/gu, "/");
	const segments = normalized.split("/");
	if (
		segments.length < 2
		|| segments[0] !== "raw"
		|| segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
		|| segments.some((segment) => WINDOWS_FORBIDDEN_OR_CONTROL.test(segment))
		|| segments.some((segment) => WINDOWS_RESERVED_NAME.test(segment))
		|| segments.some((segment) => segment.endsWith(".") || segment.endsWith(" "))
		|| segments.some((segment) => segment.toLowerCase() === ".staging")
	) {
		return null;
	}
	return segments.join("/");
}

function checkPathFromRoot(
	rootCanonicalPath: string,
	segments: readonly string[],
): CheckedPath {
	let parentCanonicalPath = rootCanonicalPath;

	for (const [ordinal, segment] of segments.entries()) {
		const candidatePath = join(parentCanonicalPath, segment);
		let stats;
		try {
			stats = lstatSync(candidatePath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return {
					status: "missing",
					projectedPath: resolve(parentCanonicalPath, ...segments.slice(ordinal)),
				};
			}
			return { status: "unsafe" };
		}

		if (stats.isSymbolicLink()) return { status: "unsafe" };
		const isTarget = ordinal === segments.length - 1;
		if (isTarget) {
			if (!stats.isFile()) return { status: "unsafe" };
		} else if (!stats.isDirectory()) {
			return { status: "unsafe" };
		}

		let canonicalPath: string;
		try {
			canonicalPath = realpathSync.native(candidatePath);
		} catch {
			return { status: "unsafe" };
		}
		if (!equalFilesystemPath(canonicalPath, candidatePath)) return { status: "unsafe" };
		parentCanonicalPath = canonicalPath;
	}

	return { status: "ready", canonicalPath: parentCanonicalPath };
}

function canonicalL2Root(l2DataDir: string): string | null {
	try {
		const rootInputPath = resolve(l2DataDir);
		const rootStats = lstatSync(rootInputPath);
		if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) return null;
		const rootCanonicalPath = realpathSync.native(rootInputPath);
		return equalFilesystemPath(rootInputPath, rootCanonicalPath) ? rootCanonicalPath : null;
	} catch {
		return null;
	}
}

/** Resolve only the immutable raw path, without coupling it to derived evidence state. */
export function resolveRawSourcePath(l2DataDir: string, entry: ManifestEntry): RawSourcePathResolution {
	const rawRelativePath = normalizeRawRelativePath(entry.rawPath);
	const rootCanonicalPath = canonicalL2Root(l2DataDir);
	if (rawRelativePath === null || rootCanonicalPath === null) return { status: "unsafe-path" };

	const raw = checkPathFromRoot(rootCanonicalPath, rawRelativePath.split("/"));
	if (raw.status === "unsafe") return { status: "unsafe-path" };
	if (raw.status === "missing") return { status: "missing-file", rawRelativePath };
	return {
		status: "ready",
		rawAbsolutePath: raw.canonicalPath as ValidatedRawPath,
		rawRelativePath,
	};
}

/** Resolve the only raw and evidence paths trusted by provenance readers. */
export function resolveSourcePaths(l2DataDir: string, entry: ManifestEntry): SourcePathResolution {
	const rawRelativePath = normalizeRawRelativePath(entry.rawPath);
	const rootCanonicalPath = canonicalL2Root(l2DataDir);
	if (rawRelativePath === null || rootCanonicalPath === null) return { status: "unsafe-path" };

	const rawSegments = rawRelativePath.split("/");
	const evidenceSegments = [
		"extracted",
		"evidence",
		"by-id",
		`${sourceIdHash(entry.id)}.json`,
	];
	const raw = checkPathFromRoot(rootCanonicalPath, rawSegments);
	const evidence = checkPathFromRoot(rootCanonicalPath, evidenceSegments);
	if (raw.status === "unsafe" || evidence.status === "unsafe") return { status: "unsafe-path" };

	const evidenceIndexAbsolutePath = (
		evidence.status === "ready" ? evidence.canonicalPath : evidence.projectedPath
	) as ValidatedEvidencePath;
	if (raw.status === "missing") {
		return { status: "missing-file", rawRelativePath, evidenceIndexAbsolutePath };
	}

	return {
		status: "ready",
		rawAbsolutePath: raw.canonicalPath as ValidatedRawPath,
		rawRelativePath,
		evidenceIndexAbsolutePath,
	};
}
