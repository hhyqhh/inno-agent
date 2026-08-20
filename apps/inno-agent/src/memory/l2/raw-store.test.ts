import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmdirSync,
	rmSync,
	statSync,
	symlinkSync,
	truncateSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fsTrace = vi.hoisted(() => ({
	recording: false,
	afterCopy: undefined as ((source: string, destination: string) => void) | undefined,
	beforeFsync: undefined as ((path: string) => void) | undefined,
	failFsync: false,
	events: [] as Array<{ op: string; path?: string; from?: string; to?: string }>,
	descriptorPaths: new Map<number, string>(),
	stagingBytesWritten: 0,
	pendingSource: undefined as { descriptor: number; path: string } | undefined,
	activeCopy: undefined as {
		sourceDescriptor: number;
		destinationDescriptor: number;
		source: string;
		destination: string;
	} | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		readFileSync(path: string, ...args: unknown[]) {
			if (fsTrace.recording) fsTrace.events.push({ op: "read", path });
			return (actual.readFileSync as (...innerArgs: unknown[]) => unknown)(path, ...args);
		},
		statSync(path: string, ...args: unknown[]) {
			if (fsTrace.recording) fsTrace.events.push({ op: "stat", path });
			return (actual.statSync as (...innerArgs: unknown[]) => unknown)(path, ...args);
		},
		lstatSync(path: string, ...args: unknown[]) {
			if (fsTrace.recording) fsTrace.events.push({ op: "stat", path });
			return (actual.lstatSync as (...innerArgs: unknown[]) => unknown)(path, ...args);
		},
		openSync(path: string, flags: string | number, mode?: number) {
			const descriptor = actual.openSync(path, flags, mode);
			fsTrace.descriptorPaths.set(descriptor, path);
			if (flags === "r") fsTrace.pendingSource = { descriptor, path };
			if (flags === "wx+" && fsTrace.pendingSource) {
				fsTrace.activeCopy = {
					sourceDescriptor: fsTrace.pendingSource.descriptor,
					destinationDescriptor: descriptor,
					source: fsTrace.pendingSource.path,
					destination: path,
				};
				fsTrace.pendingSource = undefined;
			}
			if (fsTrace.recording) fsTrace.events.push({ op: "open", path });
			return descriptor;
		},
		readSync(descriptor: number, buffer: Buffer, offset: number, length: number, position: number | null) {
			if (fsTrace.recording) fsTrace.events.push({ op: "read", path: fsTrace.descriptorPaths.get(descriptor) });
			return actual.readSync(descriptor, buffer, offset, length, position);
		},
		writeSync(descriptor: number, buffer: Uint8Array, offset: number, length: number, position: number | null) {
			const written = actual.writeSync(descriptor, buffer, offset, length, position);
			const descriptorPath = fsTrace.descriptorPaths.get(descriptor);
			if (descriptorPath?.includes(join("raw", ".staging")) && position !== null) {
				fsTrace.stagingBytesWritten = Math.max(fsTrace.stagingBytesWritten, position + written);
			}
			return written;
		},
		fstatSync(descriptor: number, options?: { bigint?: boolean }) {
			if (fsTrace.recording) fsTrace.events.push({ op: "stat", path: fsTrace.descriptorPaths.get(descriptor) });
			return (actual.fstatSync as (...args: unknown[]) => unknown)(descriptor, options);
		},
		fsyncSync(descriptor: number) {
			if (fsTrace.recording) fsTrace.events.push({ op: "fsync", path: fsTrace.descriptorPaths.get(descriptor) });
			fsTrace.beforeFsync?.(fsTrace.descriptorPaths.get(descriptor) ?? "");
			if (fsTrace.failFsync) throw new Error("injected fsync failure");
			actual.fsyncSync(descriptor);
		},
		closeSync(descriptor: number) {
			if (fsTrace.recording) fsTrace.events.push({ op: "close", path: fsTrace.descriptorPaths.get(descriptor) });
			actual.closeSync(descriptor);
			fsTrace.descriptorPaths.delete(descriptor);
			if (fsTrace.pendingSource?.descriptor === descriptor) fsTrace.pendingSource = undefined;
			if (fsTrace.activeCopy?.sourceDescriptor === descriptor) {
				const copy = fsTrace.activeCopy;
				fsTrace.activeCopy = undefined;
				if (fsTrace.recording) fsTrace.events.push({ op: "copy", from: copy.source, to: copy.destination });
				fsTrace.afterCopy?.(copy.source, copy.destination);
			}
		},
		renameSync(from: string, to: string) {
			if (fsTrace.recording) fsTrace.events.push({ op: "rename", from, to });
			actual.renameSync(from, to);
		},
	};
});

import { archiveRawContent, archiveRawFile } from "./raw-store.js";
import { parseDocument } from "./document-parser.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "inno-raw-store-"));
	tempDirs.push(dir);
	return dir;
}

function isDescendant(root: string, candidate: string): boolean {
	const rel = relative(resolve(root), resolve(candidate));
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

afterEach(() => {
	fsTrace.recording = false;
	fsTrace.afterCopy = undefined;
	fsTrace.beforeFsync = undefined;
	fsTrace.failFsync = false;
	fsTrace.events.length = 0;
	fsTrace.descriptorPaths.clear();
	fsTrace.stagingBytesWritten = 0;
	fsTrace.pendingSource = undefined;
	fsTrace.activeCopy = undefined;
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("archiveRawContent", () => {
	it("reports hash and size from the exact archived bytes", () => {
		const root = makeTempDir();
		const archived = archiveRawContent(root, "Learning Notes", "# 你好\n", "markdown", "https://example.test/note");
		const savedBytes = readFileSync(archived.absolutePath);

		expect(archived).toMatchObject({
			rawPath: expect.any(String),
			originLabel: "archived-text",
			rawContentHash: createHash("sha256").update(savedBytes).digest("hex"),
			rawSize: savedBytes.length,
		});
		expect(archived.absolutePath).toBe(resolve(root, archived.rawPath));
		expect(isDescendant(join(root, "raw"), archived.absolutePath)).toBe(true);
		expect(archived.rawMtimeMs).toBe(statSync(archived.absolutePath).mtimeMs);
		expect(savedBytes.toString("utf8")).toContain("# 你好\n");
		expect(readdirSync(join(root, "raw", ".staging"))).toEqual([]);
	});
});

describe("archiveRawFile", () => {
	it("maps source open failures to a stable path-safe error", () => {
		const root = makeTempDir();
		const sourcePath = join(makeTempDir(), "missing.pdf");
		let thrown: unknown;

		try {
			archiveRawFile(root, "Missing", sourcePath, "pdf");
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toMatchObject({ code: "SOURCE_READ_FAILED" });
		expect((thrown as Error).message).not.toContain(sourcePath);
		expect(readdirSync(join(root, "raw", "uploads"))).toEqual([]);
	});

	it("copies first and observes only that staging snapshot through validation, hashing, sizing, and rename", () => {
		const root = makeTempDir();
		const sourcePath = join(makeTempDir(), "lesson.pdf");
		const originalBytes = Buffer.from("%PDF-original-controlled-snapshot", "utf8");
		const mutatedBytes = Buffer.from("no longer a PDF in the workspace", "utf8");
		writeFileSync(sourcePath, originalBytes);
		fsTrace.afterCopy = (source, destination) => {
			expect(source).toBe(sourcePath);
			expect(destination).toContain(`${join("raw", ".staging")}${process.platform === "win32" ? "\\" : "/"}`);
			writeFileSync(sourcePath, mutatedBytes);
		};
		fsTrace.recording = true;

		const archived = archiveRawFile(root, "Immutable Lesson", sourcePath, "pdf");
		fsTrace.recording = false;
		const archivedBytes = readFileSync(archived.absolutePath);
		const copyEvent = fsTrace.events.find((event) => event.op === "copy")!;
		const copyIndex = fsTrace.events.findIndex((event) => event.op === "copy");
		const renameIndex = fsTrace.events.findIndex((event) => event.op === "rename");
		const closeIndex = fsTrace.events.findIndex(
			(event) => event.op === "close" && event.path === copyEvent.to,
		);
		const stagingObservations = fsTrace.events
			.slice(copyIndex + 1, renameIndex)
			.filter((event) => event.op === "read" || event.op === "stat");

		expect(readFileSync(sourcePath)).toEqual(mutatedBytes);
		expect(archivedBytes).toEqual(originalBytes);
		expect(archived).toMatchObject({
			originLabel: "uploaded-original",
			rawContentHash: createHash("sha256").update(originalBytes).digest("hex"),
			rawSize: originalBytes.length,
		});
		expect(stagingObservations.filter((event) => event.path === copyEvent.to).length).toBeGreaterThanOrEqual(3);
		expect(stagingObservations.some((event) => event.path === sourcePath)).toBe(false);
		expect(closeIndex).toBeGreaterThan(-1);
		expect(renameIndex).toBeGreaterThan(closeIndex);
		expect(fsTrace.events.slice(closeIndex + 1, renameIndex).some((event) => event.op === "open")).toBe(false);
		expect((fsTrace.events[renameIndex].to ?? "").startsWith(join(root, "raw", "uploads"))).toBe(true);
	});

	it("does not publish a final file when staging validation or flush fails", () => {
		const invalidRoot = makeTempDir();
		const invalidSource = join(makeTempDir(), "invalid.pdf");
		writeFileSync(invalidSource, "not a PDF");

		expect(() => archiveRawFile(invalidRoot, "Invalid", invalidSource, "pdf")).toThrowError(
			expect.objectContaining({ code: "INVALID_PDF_SIGNATURE" }),
		);
		expect(readdirSync(join(invalidRoot, "raw", ".staging"))).toEqual([]);
		expect(readdirSync(join(invalidRoot, "raw", "uploads"))).toEqual([]);

		const failedWriteRoot = makeTempDir();
		const validSource = join(makeTempDir(), "valid.pdf");
		writeFileSync(validSource, "%PDF-valid");
		fsTrace.failFsync = true;
		expect(() => archiveRawFile(failedWriteRoot, "Flush Failure", validSource, "pdf")).toThrow("injected fsync failure");
		fsTrace.failFsync = false;
		expect(readdirSync(join(failedWriteRoot, "raw", ".staging"))).toEqual([]);
		expect(readdirSync(join(failedWriteRoot, "raw", "uploads"))).toEqual([]);
	});

	it("rejects a staging junction before copying through it", () => {
		const root = makeTempDir();
		const outside = makeTempDir();
		const rawDir = join(root, "raw");
		const stagingDir = join(rawDir, ".staging");
		const sourcePath = join(makeTempDir(), "lesson.pdf");
		mkdirSync(rawDir, { recursive: true });
		symlinkSync(outside, stagingDir, process.platform === "win32" ? "junction" : "dir");
		writeFileSync(sourcePath, "%PDF-valid");

		try {
			expect(() => archiveRawFile(root, "Unsafe", sourcePath, "pdf")).toThrowError(
				expect.objectContaining({ code: "UNSAFE_RAW_PATH" }),
			);
			expect(readdirSync(outside)).toEqual([]);
		} finally {
			if (existsSync(stagingDir) && lstatSync(stagingDir).isSymbolicLink()) unlinkSync(stagingDir);
		}
	});

	it("never cleans up through a staging directory replaced by a junction after copy", () => {
		const root = makeTempDir();
		const outside = makeTempDir();
		const sourcePath = join(makeTempDir(), "lesson.pdf");
		writeFileSync(sourcePath, "%PDF-valid");
		let stagingDir = "";
		let outsideVictim = "";
		fsTrace.afterCopy = (_source, destination) => {
			stagingDir = dirname(destination);
			unlinkSync(destination);
			rmdirSync(stagingDir);
			symlinkSync(outside, stagingDir, process.platform === "win32" ? "junction" : "dir");
			outsideVictim = join(outside, basename(destination));
			writeFileSync(outsideVictim, "outside data must survive");
			throw new Error("injected post-copy failure");
		};

		try {
			expect(() => archiveRawFile(root, "Race", sourcePath, "pdf")).toThrow("injected post-copy failure");
			expect(readFileSync(outsideVictim, "utf8")).toBe("outside data must survive");
			expect(readdirSync(join(root, "raw", "uploads"))).toEqual([]);
		} finally {
			fsTrace.afterCopy = undefined;
			if (stagingDir && existsSync(stagingDir) && lstatSync(stagingDir).isSymbolicLink()) unlinkSync(stagingDir);
		}
	});

	it("rejects a same-size staging file replacement between hashing and flush", () => {
		const root = makeTempDir();
		const sourcePath = join(makeTempDir(), "lesson.pdf");
		const originalBytes = Buffer.from("%PDF-original-snapshot", "utf8");
		const attackerBytes = Buffer.from("%PDF-attacker-snapshot", "utf8");
		expect(attackerBytes.length).toBe(originalBytes.length);
		writeFileSync(sourcePath, originalBytes);
		fsTrace.beforeFsync = (stagingPath) => {
			unlinkSync(stagingPath);
			writeFileSync(stagingPath, attackerBytes);
		};

		expect(() => archiveRawFile(root, "Identity", sourcePath, "pdf")).toThrowError(
			expect.objectContaining({ code: "STAGING_CHANGED" }),
		);
		expect(readdirSync(join(root, "raw", "uploads"))).toEqual([]);
	});

	it("archives a read-only source into a writable owned staging file", () => {
		const root = makeTempDir();
		const sourcePath = join(makeTempDir(), "readonly.pdf");
		const originalBytes = Buffer.from("%PDF-read-only-source", "utf8");
		writeFileSync(sourcePath, originalBytes);
		chmodSync(sourcePath, 0o444);

		try {
			const archived = archiveRawFile(root, "Read Only", sourcePath, "pdf");
			expect(readFileSync(archived.absolutePath)).toEqual(originalBytes);
		} finally {
			chmodSync(sourcePath, 0o666);
		}
	});

	it("rejects a sparse file over 100MB before reading staging bytes or publishing", () => {
		const root = makeTempDir();
		const sourcePath = join(makeTempDir(), "oversized.pdf");
		writeFileSync(sourcePath, "%PDF-");
		truncateSync(sourcePath, 100 * 1024 * 1024 + 1);
		fsTrace.recording = true;

		expect(() => archiveRawFile(root, "Oversized", sourcePath, "pdf")).toThrowError(
			expect.objectContaining({ code: "FILE_TOO_LARGE" }),
		);
		fsTrace.recording = false;
		expect(
			fsTrace.events.some((event) => event.op === "read" && event.path?.includes(join("raw", ".staging"))),
		).toBe(false);
		expect(fsTrace.stagingBytesWritten).toBeLessThanOrEqual(100 * 1024 * 1024);
		expect(readdirSync(join(root, "raw", ".staging"))).toEqual([]);
		expect(readdirSync(join(root, "raw", "uploads"))).toEqual([]);
	});
});

describe("parseDocument Markdown", () => {
	it("strictly decodes a controlled Markdown file into the standard single-page result", async () => {
		const filePath = join(makeTempDir(), "lesson.md");
		const text = "# 标题\r\n\r\n正文 🌱\n";
		writeFileSync(filePath, text, "utf8");

		await expect(parseDocument(filePath)).resolves.toEqual({
			text,
			pageCount: 1,
			pages: [{ pageNumber: 1, text }],
		});
	});

	it("rejects malformed UTF-8 instead of decoding replacement characters", async () => {
		const filePath = join(makeTempDir(), "lesson.markdown");
		writeFileSync(filePath, Buffer.from([0x23, 0x20, 0xc3, 0x28]));

		await expect(parseDocument(filePath)).rejects.toMatchObject({ code: "PARSE_ERROR" });
	});
});
