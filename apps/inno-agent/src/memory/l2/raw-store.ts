import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeSync,
	type BigIntStats,
} from "node:fs";
import { ensureDir } from "../../storage/file-store.js";
import type { RawSourceType } from "./types.js";
import { validateSourceBytes, type ArchivableFileType } from "./source-format.js";

const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;
const COPY_BUFFER_SIZE = 1024 * 1024;

/** Map source type to subdirectory under raw/. */
const TYPE_DIR_MAP: Record<RawSourceType, string> = {
	text: "uploads",
	markdown: "uploads",
	conversation: "conversations",
	pdf: "uploads",
	word: "uploads",
	image: "uploads",
};

function titleSlug(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 50) || "source";
}

function generateFilename(title: string, sourceType: RawSourceType): string {
	const date = new Date().toISOString().slice(0, 10);
	const ext = sourceType === "markdown" ? "md" : "txt";
	return `${date}-${titleSlug(title)}-${randomUUID()}.${ext}`;
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

export interface ArchivedRaw {
	rawPath: string;
	absolutePath: string;
	rawContentHash: string;
	rawSize: number;
	rawMtimeMs: number;
	originLabel: "uploaded-original" | "archived-text";
}

export type RawArchiveErrorCode =
	| "SOURCE_READ_FAILED"
	| "FILE_TOO_LARGE"
	| "UNSAFE_RAW_PATH"
	| "ARCHIVE_COLLISION"
	| "STAGING_CHANGED";

export class RawArchiveError extends Error {
	constructor(
		public readonly code: RawArchiveErrorCode,
		message: string,
	) {
		super(message);
		this.name = "RawArchiveError";
	}
}

interface ArchiveDirectories {
	l2Root: string;
	rawRoot: string;
	rawRootReal: string;
	stagingDir: string;
	stagingDirReal: string;
	finalDir: string;
	finalDirReal: string;
}

function comparablePath(filePath: string): string {
	const normalized = resolve(filePath);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function samePath(left: string, right: string): boolean {
	return comparablePath(left) === comparablePath(right);
}

function sameFileObject(left: BigIntStats, right: BigIntStats): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function sameFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
	return sameFileObject(left, right)
		&& left.size === right.size
		&& left.mtimeNs === right.mtimeNs
		&& left.ctimeNs === right.ctimeNs;
}

function samePublishedSnapshot(left: BigIntStats, right: BigIntStats): boolean {
	return sameFileObject(left, right)
		&& left.size === right.size
		&& left.mtimeNs === right.mtimeNs
		&& left.birthtimeNs === right.birthtimeNs;
}

function assertSameSnapshot(actual: BigIntStats, expected: BigIntStats): void {
	if (!sameFileSnapshot(actual, expected)) {
		throw new RawArchiveError("STAGING_CHANGED", "The staging file changed while it was being archived.");
	}
}

function preciseMtimeMs(stat: BigIntStats): number {
	return Number(stat.mtimeNs / 1_000_000n) + Number(stat.mtimeNs % 1_000_000n) / 1_000_000;
}

function ensurePlainDirectory(directory: string, expectedParentReal?: string): string {
	if (!existsSync(directory)) {
		try {
			mkdirSync(directory);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
	const stat = lstatSync(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		throw new RawArchiveError("UNSAFE_RAW_PATH", "The raw archive path contains a reparse link.");
	}
	const real = realpathSync.native(directory);
	if (expectedParentReal && !samePath(real, join(expectedParentReal, basename(directory)))) {
		throw new RawArchiveError("UNSAFE_RAW_PATH", "The raw archive directory escapes its parent.");
	}
	return real;
}

function prepareArchiveDirectories(l2DataDir: string, finalSubdir: string): ArchiveDirectories {
	const l2Root = resolve(l2DataDir);
	ensureDir(l2Root);
	const l2RootReal = ensurePlainDirectory(l2Root);
	const rawRoot = join(l2Root, "raw");
	const rawRootReal = ensurePlainDirectory(rawRoot, l2RootReal);
	const stagingDir = join(rawRoot, ".staging");
	const stagingDirReal = ensurePlainDirectory(stagingDir, rawRootReal);
	const finalDir = join(rawRoot, finalSubdir);
	const finalDirReal = ensurePlainDirectory(finalDir, rawRootReal);
	return { l2Root, rawRoot, rawRootReal, stagingDir, stagingDirReal, finalDir, finalDirReal };
}

function verifyDirectory(directory: string, expectedReal: string): void {
	const stat = lstatSync(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(realpathSync.native(directory), expectedReal)) {
		throw new RawArchiveError("UNSAFE_RAW_PATH", "A raw archive directory changed during archival.");
	}
}

function verifyStagingFile(directories: ArchiveDirectories, stagingPath: string): BigIntStats {
	verifyDirectory(directories.rawRoot, directories.rawRootReal);
	verifyDirectory(directories.stagingDir, directories.stagingDirReal);
	if (!samePath(dirname(stagingPath), directories.stagingDir)) {
		throw new RawArchiveError("UNSAFE_RAW_PATH", "The staging file is outside the staging directory.");
	}
	const stat = lstatSync(stagingPath, { bigint: true });
	if (!stat.isFile() || stat.isSymbolicLink()) {
		throw new RawArchiveError("UNSAFE_RAW_PATH", "The staging path is not a regular file.");
	}
	if (!samePath(realpathSync.native(stagingPath), join(directories.stagingDirReal, basename(stagingPath)))) {
		throw new RawArchiveError("UNSAFE_RAW_PATH", "The staging file escapes the staging directory.");
	}
	return stat;
}

function cleanupVerifiedStagingFile(
	directories: ArchiveDirectories,
	stagingPath: string,
	ownedIdentity: BigIntStats | undefined,
): void {
	if (!ownedIdentity) return;
	try {
		const current = verifyStagingFile(directories, stagingPath);
		if (!sameFileObject(current, ownedIdentity)) return;
		unlinkSync(stagingPath);
	} catch {
		// Cleanup is deliberately best-effort and never follows a changed link/reparse point.
	}
}

function closeQuietly(descriptor: number | undefined): void {
	if (descriptor === undefined) return;
	try {
		closeSync(descriptor);
	} catch {
		// Preserve the archive failure that led to cleanup.
	}
}

function openSourceDescriptor(inputFilePath: string): number {
	try {
		return openSync(inputFilePath, "r");
	} catch {
		throw new RawArchiveError("SOURCE_READ_FAILED", "The source file could not be read.");
	}
}

function openStagingDescriptor(stagingPath: string): number {
	try {
		return openSync(stagingPath, "wx+", 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new RawArchiveError("ARCHIVE_COLLISION", "The staging archive name already exists.");
		}
		throw error;
	}
}

function writeAll(descriptor: number, bytes: Uint8Array, initialPosition = 0): number {
	let offset = 0;
	while (offset < bytes.byteLength) {
		const written = writeSync(descriptor, bytes, offset, bytes.byteLength - offset, initialPosition + offset);
		if (written <= 0) {
			throw new RawArchiveError("STAGING_CHANGED", "The staging file could not be written completely.");
		}
		offset += written;
	}
	return initialPosition + offset;
}

function copySourceToStaging(sourceDescriptor: number, stagingDescriptor: number): void {
	const buffer = Buffer.allocUnsafe(COPY_BUFFER_SIZE);
	let sourcePosition = 0;
	let stagingPosition = 0;
	while (true) {
		let bytesRead: number;
		try {
			bytesRead = readSync(sourceDescriptor, buffer, 0, buffer.length, sourcePosition);
		} catch {
			throw new RawArchiveError("SOURCE_READ_FAILED", "The source file could not be read.");
		}
		if (bytesRead === 0) return;
		if (stagingPosition + bytesRead > MAX_FILE_SIZE_BYTES) {
			throw new RawArchiveError("FILE_TOO_LARGE", "The source file exceeds the 100 MB limit.");
		}
		stagingPosition = writeAll(stagingDescriptor, buffer.subarray(0, bytesRead), stagingPosition);
		sourcePosition += bytesRead;
	}
}

function readStagingBytes(descriptor: number, snapshot: BigIntStats): Buffer {
	if (snapshot.size > BigInt(MAX_FILE_SIZE_BYTES)) {
		throw new RawArchiveError("FILE_TOO_LARGE", "The source file exceeds the 100 MB limit.");
	}
	const size = Number(snapshot.size);
	const bytes = Buffer.allocUnsafe(size);
	let offset = 0;
	while (offset < size) {
		const bytesRead = readSync(descriptor, bytes, offset, size - offset, offset);
		if (bytesRead <= 0) {
			throw new RawArchiveError("STAGING_CHANGED", "The staging file changed while it was being read.");
		}
		offset += bytesRead;
	}
	return bytes;
}

function verifyDescriptorSnapshot(
	directories: ArchiveDirectories,
	stagingPath: string,
	descriptor: number,
	expected?: BigIntStats,
): BigIntStats {
	const descriptorStat = fstatSync(descriptor, { bigint: true });
	if (expected) assertSameSnapshot(descriptorStat, expected);
	const pathStat = verifyStagingFile(directories, stagingPath);
	assertSameSnapshot(pathStat, descriptorStat);
	return descriptorStat;
}

function makeArchivePaths(
	directories: ArchiveDirectories,
	filenameFactory: () => string,
): { stagingPath: string; absolutePath: string } {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const filename = filenameFactory();
		const stagingPath = join(directories.stagingDir, filename);
		const absolutePath = join(directories.finalDir, filename);
		if (!existsSync(stagingPath) && !existsSync(absolutePath)) return { stagingPath, absolutePath };
	}
	throw new RawArchiveError("ARCHIVE_COLLISION", "Unable to allocate a unique raw archive name.");
}

function publishStagingFile(
	directories: ArchiveDirectories,
	stagingPath: string,
	absolutePath: string,
	expectedSnapshot: BigIntStats,
): number {
	assertSameSnapshot(verifyStagingFile(directories, stagingPath), expectedSnapshot);
	verifyDirectory(directories.finalDir, directories.finalDirReal);
	if (!samePath(dirname(absolutePath), directories.finalDir) || existsSync(absolutePath)) {
		throw new RawArchiveError("ARCHIVE_COLLISION", "The raw archive destination already exists.");
	}
	renameSync(stagingPath, absolutePath);
	const finalStat = lstatSync(absolutePath, { bigint: true });
	if (
		!finalStat.isFile()
		|| finalStat.isSymbolicLink()
		|| !samePath(realpathSync.native(absolutePath), join(directories.finalDirReal, basename(absolutePath)))
	) {
		throw new RawArchiveError("UNSAFE_RAW_PATH", "The published raw archive escaped its destination.");
	}
	if (!samePublishedSnapshot(finalStat, expectedSnapshot)) {
		throw new RawArchiveError("STAGING_CHANGED", "The published raw archive does not match the staged file.");
	}
	return preciseMtimeMs(finalStat);
}

export function archiveRawContent(
	l2DataDir: string,
	title: string,
	content: string,
	sourceType: RawSourceType,
	sourceUrl?: string,
): ArchivedRaw {
	const subdir = TYPE_DIR_MAP[sourceType];
	const directories = prepareArchiveDirectories(l2DataDir, subdir);
	const { stagingPath, absolutePath } = makeArchivePaths(
		directories,
		() => generateFilename(title, sourceType),
	);
	const savedContent = rawFrontmatter(content, sourceType, sourceUrl) + content;
	const savedBytes = Buffer.from(savedContent, "utf8");
	let descriptor: number | undefined;
	let ownedIdentity: BigIntStats | undefined;

	try {
		verifyDirectory(directories.stagingDir, directories.stagingDirReal);
		descriptor = openStagingDescriptor(stagingPath);
		ownedIdentity = fstatSync(descriptor, { bigint: true });
		writeAll(descriptor, savedBytes);
		const stagingStat = verifyDescriptorSnapshot(directories, stagingPath, descriptor);
		ownedIdentity = stagingStat;
		const bytes = readStagingBytes(descriptor, stagingStat);
		verifyDescriptorSnapshot(directories, stagingPath, descriptor, stagingStat);
		const rawContentHash = createHash("sha256").update(bytes).digest("hex");
		const rawSize = Number(stagingStat.size);
		fsyncSync(descriptor);
		verifyDescriptorSnapshot(directories, stagingPath, descriptor, stagingStat);
		closeSync(descriptor);
		descriptor = undefined;
		const rawMtimeMs = publishStagingFile(directories, stagingPath, absolutePath, stagingStat);
		return {
			rawPath: relative(directories.l2Root, absolutePath),
			absolutePath,
			rawContentHash,
			rawSize,
			rawMtimeMs,
			originLabel: "archived-text",
		};
	} catch (error) {
		closeQuietly(descriptor);
		cleanupVerifiedStagingFile(directories, stagingPath, ownedIdentity);
		throw error;
	}
}

export function archiveRawFile(
	l2DataDir: string,
	title: string,
	inputFilePath: string,
	sourceType: ArchivableFileType,
): ArchivedRaw;
export function archiveRawFile(
	l2DataDir: string,
	title: string,
	inputFilePath: string,
	sourceType: "image",
): ArchivedRaw;
export function archiveRawFile(
	l2DataDir: string,
	title: string,
	inputFilePath: string,
	sourceType: ArchivableFileType | "image",
): ArchivedRaw {
	const directories = prepareArchiveDirectories(l2DataDir, "uploads");
	const date = new Date().toISOString().slice(0, 10);
	const extension = extname(inputFilePath).toLowerCase();
	const { stagingPath, absolutePath } = makeArchivePaths(
		directories,
		() => `${date}-${titleSlug(title)}-${randomUUID()}${extension}`,
	);
	let sourceDescriptor: number | undefined;
	let stagingDescriptor: number | undefined;
	let ownedIdentity: BigIntStats | undefined;

	try {
		sourceDescriptor = openSourceDescriptor(inputFilePath);
		verifyDirectory(directories.stagingDir, directories.stagingDirReal);
		stagingDescriptor = openStagingDescriptor(stagingPath);
		ownedIdentity = fstatSync(stagingDescriptor, { bigint: true });
		copySourceToStaging(sourceDescriptor, stagingDescriptor);
		closeSync(sourceDescriptor);
		sourceDescriptor = undefined;

		const stagingStat = verifyDescriptorSnapshot(directories, stagingPath, stagingDescriptor);
		ownedIdentity = stagingStat;
		const bytes = readStagingBytes(stagingDescriptor, stagingStat);
		if (sourceType !== "image") validateSourceBytes(extname(stagingPath), bytes, sourceType);
		verifyDescriptorSnapshot(directories, stagingPath, stagingDescriptor, stagingStat);
		const rawContentHash = createHash("sha256").update(bytes).digest("hex");
		const rawSize = Number(stagingStat.size);
		fsyncSync(stagingDescriptor);
		verifyDescriptorSnapshot(directories, stagingPath, stagingDescriptor, stagingStat);
		closeSync(stagingDescriptor);
		stagingDescriptor = undefined;
		const rawMtimeMs = publishStagingFile(directories, stagingPath, absolutePath, stagingStat);
		return {
			rawPath: relative(directories.l2Root, absolutePath),
			absolutePath,
			rawContentHash,
			rawSize,
			rawMtimeMs,
			originLabel: "uploaded-original",
		};
	} catch (error) {
		closeQuietly(sourceDescriptor);
		closeQuietly(stagingDescriptor);
		cleanupVerifiedStagingFile(directories, stagingPath, ownedIdentity);
		throw error;
	}
}
