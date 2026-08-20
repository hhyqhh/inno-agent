import { createHash } from "node:crypto";
import {
	linkSync,
	mkdirSync,
	mkdtempSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fsTrace = vi.hoisted(() => ({
	readCalls: 0,
	afterFirstRead: undefined as (() => void) | undefined,
	openTarget: undefined as string | undefined,
	beforeOpen: undefined as (() => void) | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		openSync(path: string, flags: string | number, mode?: number) {
			if (fsTrace.beforeOpen && (fsTrace.openTarget === undefined || fsTrace.openTarget === path)) {
				const beforeOpen = fsTrace.beforeOpen;
				fsTrace.beforeOpen = undefined;
				beforeOpen();
			}
			return actual.openSync(path, flags, mode);
		},
		readSync(...args: unknown[]) {
			const result = (actual.readSync as (...inner: unknown[]) => number)(...args);
			fsTrace.readCalls += 1;
			if (fsTrace.readCalls === 1) fsTrace.afterFirstRead?.();
			return result;
		},
	};
});

import type { ManifestEntry } from "./types.js";
import { resolveSourcePaths } from "./source-path.js";
import {
	readSourceRevision,
	SourceRevisionReader,
} from "./source-revision.js";

const tempDirs: string[] = [];

function makeRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "inno-source-revision-"));
	tempDirs.push(root);
	mkdirSync(join(root, "raw", "uploads"), { recursive: true });
	mkdirSync(join(root, "extracted", "evidence", "by-id"), { recursive: true });
	return root;
}

function entry(name: string): ManifestEntry {
	return {
		id: `l2src_${name}`,
		title: name,
		sourceType: "markdown",
		rawPath: `raw/uploads/${name}.md`,
		wikiPages: [],
		tags: [],
		contentHash: "legacy",
		status: "indexed",
		source: { origin: "user_upload" },
		createdAt: "2026-08-16T00:00:00.000Z",
		updatedAt: "2026-08-16T00:00:00.000Z",
	};
}

function ready(root: string, name: string) {
	const result = resolveSourcePaths(root, entry(name));
	if (result.status !== "ready") throw new Error(`expected ready path, got ${result.status}`);
	return result;
}

function digest(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

afterEach(() => {
	fsTrace.readCalls = 0;
	fsTrace.afterFirstRead = undefined;
	fsTrace.openTarget = undefined;
	fsTrace.beforeOpen = undefined;
	for (const root of tempDirs.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("readSourceRevision", () => {
	it("reports a changed snapshot when a ready raw path is replaced by a missing junction", () => {
		const root = makeRoot();
		const outside = mkdtempSync(join(tmpdir(), "inno-source-revision-outside-"));
		tempDirs.push(outside);
		const rawPath = join(root, "raw", "uploads", "source.md");
		writeFileSync(rawPath, "original bytes", "utf8");
		const paths = ready(root, "source");
		const uploads = join(root, "raw", "uploads");
		const preservedUploads = join(root, "raw", "preserved-uploads");
		fsTrace.openTarget = paths.rawAbsolutePath;
		fsTrace.beforeOpen = () => {
			renameSync(uploads, preservedUploads);
			symlinkSync(outside, uploads, process.platform === "win32" ? "junction" : "dir");
		};

		expect(readSourceRevision(paths)).toEqual({ status: "changed-during-read" });
	});

	it("computes the complete lowercase SHA-256 from the current raw bytes", () => {
		const root = makeRoot();
		const content = "current raw bytes\n";
		writeFileSync(join(root, "raw", "uploads", "source.md"), content, "utf8");

		expect(readSourceRevision(ready(root, "source"))).toEqual({
			status: "ready",
			rawContentHash: digest(content),
			sourceRevision: `sha256:${digest(content)}`,
		});
	});

	it("passes missing and unsafe resolutions through without reading", () => {
		const root = makeRoot();
		const missing = resolveSourcePaths(root, entry("missing"));
		const unsafe = resolveSourcePaths(root, { ...entry("unsafe"), rawPath: "../unsafe.md" });

		expect(readSourceRevision(missing)).toEqual({ status: "missing-file" });
		expect(readSourceRevision(unsafe)).toEqual({ status: "unsafe-path" });
		expect(fsTrace.readCalls).toBe(0);
	});

	it("uses a stable snapshot cache and includes the canonical path in its key", () => {
		const root = makeRoot();
		const source = join(root, "raw", "uploads", "source.md");
		const alias = join(root, "raw", "uploads", "alias.md");
		writeFileSync(source, "same bytes", "utf8");
		linkSync(source, alias);
		const reader = new SourceRevisionReader(8);

		const first = reader.read(ready(root, "source"));
		const firstReadCount = fsTrace.readCalls;
		expect(reader.read(ready(root, "source"))).toEqual(first);
		expect(fsTrace.readCalls).toBe(firstReadCount);

		reader.read(ready(root, "alias"));
		expect(fsTrace.readCalls).toBeGreaterThan(firstReadCount);
	});

	it("rehashes when size, mtime, or file identity changes", () => {
		const root = makeRoot();
		const path = join(root, "raw", "uploads", "source.md");
		writeFileSync(path, "one", "utf8");
		const reader = new SourceRevisionReader(8);
		const paths = ready(root, "source");

		reader.read(paths);
		let previousReads = fsTrace.readCalls;

		writeFileSync(path, "different size", "utf8");
		expect(reader.read(paths)).toEqual(expect.objectContaining({ rawContentHash: digest("different size") }));
		expect(fsTrace.readCalls).toBeGreaterThan(previousReads);
		previousReads = fsTrace.readCalls;

		const current = statSync(path);
		utimesSync(path, current.atime, new Date(current.mtimeMs + 10_000));
		reader.read(paths);
		expect(fsTrace.readCalls).toBeGreaterThan(previousReads);
		previousReads = fsTrace.readCalls;

		const preserved = statSync(path);
		const replacement = join(root, "raw", "uploads", "replacement.md");
		writeFileSync(replacement, "replacement!!!", "utf8");
		expect(Buffer.byteLength("replacement!!!")).toBe(Buffer.byteLength("different size"));
		rmSync(path);
		renameSync(replacement, path);
		utimesSync(path, preserved.atime, preserved.mtime);
		expect(reader.read(paths)).toEqual(expect.objectContaining({ rawContentHash: digest("replacement!!!") }));
		expect(fsTrace.readCalls).toBeGreaterThan(previousReads);
	});

	it("keeps the cache bounded and evicts the least recently used snapshot", () => {
		const root = makeRoot();
		for (const name of ["one", "two", "three"]) {
			writeFileSync(join(root, "raw", "uploads", `${name}.md`), name, "utf8");
		}
		const reader = new SourceRevisionReader(2);

		reader.read(ready(root, "one"));
		reader.read(ready(root, "two"));
		reader.read(ready(root, "three"));
		const beforeRevisit = fsTrace.readCalls;
		reader.read(ready(root, "one"));

		expect(fsTrace.readCalls).toBeGreaterThan(beforeRevisit);
	});

	it("does not publish or cache a revision when the file changes during hashing", () => {
		const root = makeRoot();
		const path = join(root, "raw", "uploads", "source.md");
		writeFileSync(path, "original bytes", "utf8");
		const reader = new SourceRevisionReader(8);
		const paths = ready(root, "source");
		fsTrace.afterFirstRead = () => writeFileSync(path, "changed during read", "utf8");

		expect(reader.read(paths)).toEqual({ status: "changed-during-read" });
		const readsAfterFailure = fsTrace.readCalls;
		fsTrace.afterFirstRead = undefined;
		expect(reader.read(paths)).toEqual(expect.objectContaining({
			status: "ready",
			rawContentHash: digest("changed during read"),
		}));
		expect(fsTrace.readCalls).toBeGreaterThan(readsAfterFailure);
	});

	it("reports a changed snapshot when the opened file is renamed during hashing", () => {
		const root = makeRoot();
		const path = join(root, "raw", "uploads", "source.md");
		const moved = join(root, "raw", "uploads", "moved.md");
		writeFileSync(path, "original bytes", "utf8");
		const reader = new SourceRevisionReader(8);
		const paths = ready(root, "source");
		fsTrace.afterFirstRead = () => renameSync(path, moved);

		expect(reader.read(paths)).toEqual({ status: "changed-during-read" });
	});
});
