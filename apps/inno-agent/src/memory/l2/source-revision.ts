import { createHash } from "node:crypto";
import {
	closeSync,
	fstatSync,
	lstatSync,
	openSync,
	readFileSync,
	readSync,
	realpathSync,
	type BigIntStats,
} from "node:fs";

import type { RawSourcePathResolution } from "./source-path.js";

export type SourceRevisionResult =
	| { status: "ready"; rawContentHash: string; sourceRevision: string }
	| { status: "missing-file" | "unsafe-path" | "changed-during-read" };

export type SourceBytesResult =
	| {
		status: "ready";
		rawBytes: Buffer;
		rawContentHash: string;
		sourceRevision: string;
		rawSize: number;
		rawMtimeMs: number;
	}
	| { status: "missing-file" | "unsafe-path" | "changed-during-read" };

interface FileSnapshot {
	dev: bigint;
	ino: bigint;
	size: bigint;
	mtimeNs: bigint;
	ctimeNs: bigint;
}

function snapshot(stats: BigIntStats): FileSnapshot {
	return {
		dev: stats.dev,
		ino: stats.ino,
		size: stats.size,
		mtimeNs: stats.mtimeNs,
		ctimeNs: stats.ctimeNs,
	};
}

function sameSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
	return left.dev === right.dev
		&& left.ino === right.ino
		&& left.size === right.size
		&& left.mtimeNs === right.mtimeNs
		&& left.ctimeNs === right.ctimeNs;
}

function equalFilesystemPath(left: string, right: string): boolean {
	return process.platform === "win32"
		? left.toLowerCase() === right.toLowerCase()
		: left === right;
}

function snapshotKey(canonicalPath: string, value: FileSnapshot): string {
	return [
		canonicalPath,
		value.dev,
		value.ino,
		value.size,
		value.mtimeNs,
		value.ctimeNs,
	].join("\0");
}

function errno(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as NodeJS.ErrnoException).code)
		: undefined;
}

/** Read bytes only after the opened file handle is rebound to the validated raw path. */
export function readSourceBytes(paths: RawSourcePathResolution): SourceBytesResult {
	if (paths.status !== "ready") return { status: paths.status };

	let descriptor: number | undefined;
	try {
		descriptor = openSync(paths.rawAbsolutePath, "r");
		const beforeStats = fstatSync(descriptor, { bigint: true });
		if (!beforeStats.isFile()) return { status: "unsafe-path" };
		const before = snapshot(beforeStats);
		const pathStats = lstatSync(paths.rawAbsolutePath, { bigint: true });
		if (pathStats.isSymbolicLink() || !pathStats.isFile()) return { status: "unsafe-path" };
		if (!sameSnapshot(before, snapshot(pathStats))) return { status: "changed-during-read" };
		const canonicalPath = realpathSync.native(paths.rawAbsolutePath);
		if (!equalFilesystemPath(canonicalPath, paths.rawAbsolutePath)) return { status: "unsafe-path" };

		const rawBytes = readFileSync(descriptor);
		const afterStats = fstatSync(descriptor, { bigint: true });
		const finalPathStats = lstatSync(paths.rawAbsolutePath, { bigint: true });
		const finalCanonicalPath = realpathSync.native(paths.rawAbsolutePath);
		if (
			!afterStats.isFile()
			|| finalPathStats.isSymbolicLink()
			|| !finalPathStats.isFile()
			|| !sameSnapshot(before, snapshot(afterStats))
			|| !sameSnapshot(snapshot(afterStats), snapshot(finalPathStats))
			|| !equalFilesystemPath(canonicalPath, finalCanonicalPath)
		) {
			return { status: "changed-during-read" };
		}

		const rawContentHash = createHash("sha256").update(rawBytes).digest("hex");
		return {
			status: "ready",
			rawBytes,
			rawContentHash,
			sourceRevision: `sha256:${rawContentHash}`,
			rawSize: rawBytes.length,
			rawMtimeMs: Number(before.mtimeNs / 1_000_000n) + Number(before.mtimeNs % 1_000_000n) / 1_000_000,
		};
	} catch (error) {
		const code = errno(error);
		if (code === "ENOENT" || code === "ENOTDIR") {
			return { status: "changed-during-read" };
		}
		return { status: "unsafe-path" };
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

export class SourceRevisionReader {
	readonly #maxEntries: number;
	readonly #cache = new Map<string, SourceRevisionResult & { status: "ready" }>();

	constructor(maxEntries = 128) {
		this.#maxEntries = Math.max(1, Math.floor(maxEntries));
	}

	read(paths: RawSourcePathResolution): SourceRevisionResult {
		if (paths.status !== "ready") return { status: paths.status };

		let descriptor: number | undefined;
		try {
			descriptor = openSync(paths.rawAbsolutePath, "r");
			const beforeStats = fstatSync(descriptor, { bigint: true });
			if (!beforeStats.isFile()) return { status: "unsafe-path" };
			const before = snapshot(beforeStats);
			const pathStats = lstatSync(paths.rawAbsolutePath, { bigint: true });
			if (pathStats.isSymbolicLink() || !pathStats.isFile()) return { status: "unsafe-path" };
			if (!sameSnapshot(before, snapshot(pathStats))) {
				return { status: "changed-during-read" };
			}
			const canonicalPath = realpathSync.native(paths.rawAbsolutePath);
			if (!equalFilesystemPath(canonicalPath, paths.rawAbsolutePath)) return { status: "unsafe-path" };

			const key = snapshotKey(canonicalPath, before);
			const cached = this.#cache.get(key);
			if (cached) {
				this.#cache.delete(key);
				this.#cache.set(key, cached);
				return cached;
			}

			const digest = createHash("sha256");
			const buffer = Buffer.allocUnsafe(64 * 1024);
			for (;;) {
				const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
				if (bytesRead === 0) break;
				digest.update(buffer.subarray(0, bytesRead));
			}

			const afterStats = fstatSync(descriptor, { bigint: true });
			const after = snapshot(afterStats);
			const finalPathStats = lstatSync(paths.rawAbsolutePath, { bigint: true });
			const finalCanonicalPath = realpathSync.native(paths.rawAbsolutePath);
			if (
				!afterStats.isFile()
				|| finalPathStats.isSymbolicLink()
				|| !finalPathStats.isFile()
				|| !sameSnapshot(before, after)
				|| !sameSnapshot(after, snapshot(finalPathStats))
				|| !equalFilesystemPath(canonicalPath, finalCanonicalPath)
			) {
				return { status: "changed-during-read" };
			}

			const rawContentHash = digest.digest("hex");
			const result = {
				status: "ready" as const,
				rawContentHash,
				sourceRevision: `sha256:${rawContentHash}`,
			};
			this.#cache.set(key, result);
			while (this.#cache.size > this.#maxEntries) {
				const oldest = this.#cache.keys().next().value;
				if (oldest === undefined) break;
				this.#cache.delete(oldest);
			}
			return result;
		} catch (error) {
			const code = errno(error);
			if (code === "ENOENT" || code === "ENOTDIR") {
				return { status: "changed-during-read" };
			}
			return { status: "unsafe-path" };
		} finally {
			if (descriptor !== undefined) closeSync(descriptor);
		}
	}
}

const defaultReader = new SourceRevisionReader();

export function readSourceRevision(paths: RawSourcePathResolution): SourceRevisionResult {
	return defaultReader.read(paths);
}
