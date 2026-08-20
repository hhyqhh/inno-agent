import { createHash } from "node:crypto";
import type { BigIntStats, Stats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { basename, extname } from "node:path";

import { findManifestById } from "./manifest-store.js";
import {
	decodeEvidenceIndexBytes,
	type EvidenceIndexReadResult,
} from "./evidence-index.js";
import { resolveRawSourcePath, resolveSourcePaths } from "./source-path.js";
import type { ManifestEntry, RawSourceType } from "./types.js";

const SHA256_REVISION = /^sha256:[0-9a-f]{64}$/u;
const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
const MAX_EVIDENCE_INDEX_BYTES = 128 * 1024 * 1024;
const HASH_CACHE_LIMIT = 128;
const revisionHashCache = new Map<string, string>();
const openedSourceStates = new WeakMap<FileHandle, {
	rawAbsolutePath: string;
	canonicalPath: string;
	snapshot: FileSnapshot;
}>();

export type SourceAccessErrorCode =
	| "source_not_found"
	| "source_file_not_found"
	| "source_file_unavailable"
	| "source_changed"
	| "source_revision_mismatch"
	| "source_too_large";

export class SourceAccessError extends Error {
	constructor(public readonly code: SourceAccessErrorCode) {
		super(code);
		this.name = "SourceAccessError";
	}
}

export interface OpenedSource {
	entry: ManifestEntry;
	handle: FileHandle;
	stat: Stats;
	sourceRevision: string;
	mimeType: string;
	displayName: string;
}

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

function sameFilesystemPath(left: string, right: string): boolean {
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

function cachedHash(key: string): string | undefined {
	const value = revisionHashCache.get(key);
	if (value === undefined) return undefined;
	revisionHashCache.delete(key);
	revisionHashCache.set(key, value);
	return value;
}

function cacheHash(key: string, value: string): void {
	revisionHashCache.set(key, value);
	while (revisionHashCache.size > HASH_CACHE_LIMIT) {
		const oldest = revisionHashCache.keys().next().value;
		if (oldest === undefined) return;
		revisionHashCache.delete(oldest);
	}
}

function errno(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as NodeJS.ErrnoException).code)
		: undefined;
}

function mimeTypeFor(sourceType: RawSourceType, rawRelativePath: string): string {
	if (sourceType === "pdf") return "application/pdf";
	if (sourceType === "word") {
		return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
	}
	if (sourceType === "markdown") return "text/markdown; charset=utf-8";
	if (sourceType === "text" || sourceType === "conversation") return "text/plain; charset=utf-8";
	if (sourceType === "image") {
		switch (extname(rawRelativePath).toLowerCase()) {
			case ".png": return "image/png";
			case ".jpg":
			case ".jpeg": return "image/jpeg";
			case ".gif": return "image/gif";
			case ".webp": return "image/webp";
			default: return "application/octet-stream";
		}
	}
	return "application/octet-stream";
}

function displayNameFor(entry: ManifestEntry, rawRelativePath: string): string {
	const rawName = basename(rawRelativePath)
		.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/gu, "_")
		.slice(0, 180) || "source";
	const extension = extname(rawName);
	const rawTitle = typeof entry.title === "string" ? entry.title.trim() : "";
	const sanitizedTitle = rawTitle
		.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/gu, "_")
		.slice(0, 180)
		.trim();
	if (!sanitizedTitle) return rawName;
	return !extension || sanitizedTitle.toLowerCase().endsWith(extension.toLowerCase())
		? sanitizedTitle
		: `${sanitizedTitle}${extension}`;
}

async function verifyOpenedPath(
	handle: FileHandle,
	rawAbsolutePath: string,
	canonicalPath: string,
	expected: FileSnapshot,
): Promise<void> {
	try {
		const descriptorStats = await handle.stat({ bigint: true });
		const pathStats = await lstat(rawAbsolutePath, { bigint: true });
		if (
			!descriptorStats.isFile()
			|| pathStats.isSymbolicLink()
			|| !pathStats.isFile()
			|| !sameSnapshot(snapshot(descriptorStats), expected)
			|| !sameSnapshot(snapshot(pathStats), expected)
			|| !sameFilesystemPath(await realpath(rawAbsolutePath), canonicalPath)
		) {
			throw new SourceAccessError("source_changed");
		}
	} catch {
		throw new SourceAccessError("source_changed");
	}
}

async function hashOpenedFile(handle: FileHandle, expectedSize: number): Promise<string> {
	const digest = createHash("sha256");
	const buffer = Buffer.allocUnsafe(64 * 1024);
	let position = 0;
	while (position < expectedSize) {
		const length = Math.min(buffer.length, expectedSize - position);
		const { bytesRead } = await handle.read(buffer, 0, length, position);
		if (bytesRead <= 0) throw new SourceAccessError("source_changed");
		digest.update(buffer.subarray(0, bytesRead));
		position += bytesRead;
	}
	return digest.digest("hex");
}

async function readOpenedBytes(
	handle: FileHandle,
	expectedSize: number,
	start = 0,
): Promise<Buffer> {
	const bytes = Buffer.allocUnsafe(expectedSize);
	let offset = 0;
	while (offset < expectedSize) {
		const { bytesRead } = await handle.read(bytes, offset, expectedSize - offset, start + offset);
		if (bytesRead <= 0) throw new SourceAccessError("source_changed");
		offset += bytesRead;
	}
	return bytes;
}

async function verifyOpenedSource(openedSource: OpenedSource): Promise<void> {
	const state = openedSourceStates.get(openedSource.handle);
	if (state === undefined) throw new SourceAccessError("source_changed");
	await verifyOpenedPath(
		openedSource.handle,
		state.rawAbsolutePath,
		state.canonicalPath,
		state.snapshot,
	);
}

/** Open one manifest source by ID and verify its revision on the returned handle. */
export async function openSourceById(
	l2DataDir: string,
	sourceId: string,
	expectedRevision: string,
): Promise<OpenedSource> {
	let entry: ManifestEntry | undefined;
	try {
		entry = findManifestById(l2DataDir, sourceId);
	} catch {
		throw new SourceAccessError("source_file_unavailable");
	}
	if (entry === undefined) throw new SourceAccessError("source_not_found");

	const paths = resolveRawSourcePath(l2DataDir, entry);
	if (paths.status === "missing-file") throw new SourceAccessError("source_file_not_found");
	if (paths.status !== "ready") throw new SourceAccessError("source_file_unavailable");

	let handle: FileHandle | undefined;
	try {
		handle = await open(paths.rawAbsolutePath, "r");
		const canonicalPath = await realpath(paths.rawAbsolutePath);
		if (!sameFilesystemPath(canonicalPath, paths.rawAbsolutePath)) {
			throw new SourceAccessError("source_file_unavailable");
		}
		const beforeStats = await handle.stat({ bigint: true });
		if (!beforeStats.isFile()) throw new SourceAccessError("source_file_unavailable");
		const before = snapshot(beforeStats);
		if (before.size > BigInt(MAX_SOURCE_BYTES)) throw new SourceAccessError("source_too_large");
		await verifyOpenedPath(handle, paths.rawAbsolutePath, canonicalPath, before);

		const key = snapshotKey(canonicalPath, before);
		const cached = cachedHash(key);
		const rawContentHash = cached ?? await hashOpenedFile(handle, Number(before.size));
		await verifyOpenedPath(handle, paths.rawAbsolutePath, canonicalPath, before);
		if (cached === undefined) cacheHash(key, rawContentHash);
		const sourceRevision = `sha256:${rawContentHash}`;
		if (!SHA256_REVISION.test(expectedRevision) || sourceRevision !== expectedRevision) {
			throw new SourceAccessError("source_revision_mismatch");
		}

		const stat = await handle.stat();
		await verifyOpenedPath(handle, paths.rawAbsolutePath, canonicalPath, before);
		const opened: OpenedSource = {
			entry,
			handle,
			stat,
			sourceRevision,
			mimeType: mimeTypeFor(entry.sourceType, paths.rawRelativePath),
			displayName: displayNameFor(entry, paths.rawRelativePath),
		};
		openedSourceStates.set(handle, {
			rawAbsolutePath: paths.rawAbsolutePath,
			canonicalPath,
			snapshot: before,
		});
		handle = undefined;
		return opened;
	} catch (error) {
		if (error instanceof SourceAccessError) throw error;
		const code = errno(error);
		if (code === "ENOENT" || code === "ENOTDIR") {
			throw new SourceAccessError(handle === undefined ? "source_file_not_found" : "source_changed");
		}
		throw new SourceAccessError("source_file_unavailable");
	} finally {
		if (handle !== undefined) await handle.close().catch(() => undefined);
	}
}

/** Buffer source bytes from the verified handle, then prove the source snapshot is still unchanged. */
export async function readSourceBytes(
	openedSource: OpenedSource,
	start: number,
	length: number,
): Promise<Buffer> {
	if (
		!Number.isSafeInteger(start)
		|| !Number.isSafeInteger(length)
		|| start < 0
		|| length < 0
		|| start + length > openedSource.stat.size
	) {
		throw new SourceAccessError("source_changed");
	}
	await verifyOpenedSource(openedSource);
	const bytes = await readOpenedBytes(openedSource.handle, length, start);
	await verifyOpenedSource(openedSource);
	return bytes;
}

/** Read and decode the evidence index through a verified index file handle. */
export async function readEvidenceIndexForSource(
	l2DataDir: string,
	openedSource: OpenedSource,
): Promise<EvidenceIndexReadResult> {
	await verifyOpenedSource(openedSource);
	const paths = resolveSourcePaths(l2DataDir, openedSource.entry);
	await verifyOpenedSource(openedSource);
	if (paths.status !== "ready") {
		return paths.status === "missing-file"
			? { status: "stale-source" }
			: { status: "corrupt-index" };
	}

	let indexHandle: FileHandle | undefined;
	let result: EvidenceIndexReadResult;
	try {
		indexHandle = await open(paths.evidenceIndexAbsolutePath, "r");
		const canonicalPath = await realpath(paths.evidenceIndexAbsolutePath);
		if (!sameFilesystemPath(canonicalPath, paths.evidenceIndexAbsolutePath)) {
			throw new Error("Evidence index path changed.");
		}
		const beforeStats = await indexHandle.stat({ bigint: true });
		if (!beforeStats.isFile() || beforeStats.size > BigInt(MAX_EVIDENCE_INDEX_BYTES)) {
			throw new Error("Evidence index file is invalid.");
		}
		const before = snapshot(beforeStats);
		await verifyOpenedPath(indexHandle, paths.evidenceIndexAbsolutePath, canonicalPath, before);
		const bytes = await readOpenedBytes(indexHandle, Number(before.size));
		await verifyOpenedPath(indexHandle, paths.evidenceIndexAbsolutePath, canonicalPath, before);
		result = decodeEvidenceIndexBytes(
			bytes,
			openedSource.entry.id,
			openedSource.sourceRevision.slice("sha256:".length),
		);
	} catch (error) {
		result = errno(error) === "ENOENT" && indexHandle === undefined
			? { status: "missing-index" }
			: { status: "corrupt-index" };
	} finally {
		if (indexHandle !== undefined) await indexHandle.close().catch(() => undefined);
	}
	await verifyOpenedSource(openedSource);
	return result;
}
