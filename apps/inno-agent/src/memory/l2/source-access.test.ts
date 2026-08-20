import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	renameSync,
	rmSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsRace = vi.hoisted(() => ({
	afterFirstRead: undefined as ((path: string) => void) | undefined,
	beforeResolveSourcePaths: undefined as (() => void) | undefined,
	closedPaths: [] as string[],
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		async open(path: Parameters<typeof actual.open>[0], flags: Parameters<typeof actual.open>[1]) {
			const handle = await actual.open(path, flags);
			const pathText = String(path);
			let firstRead = true;
			return new Proxy(handle, {
				get(target, property) {
					if (property === "read") {
						return async (...args: unknown[]) => {
							const result = await Reflect.apply(target.read, target, args);
							if (firstRead) {
								firstRead = false;
								fsRace.afterFirstRead?.(pathText);
							}
							return result;
						};
					}
					if (property === "close") {
						return async () => {
							fsRace.closedPaths.push(pathText);
							await target.close();
						};
					}
					const value = Reflect.get(target, property, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
		},
	};
});

vi.mock("./source-path.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./source-path.js")>();
	return {
		...actual,
		resolveSourcePaths(...args: Parameters<typeof actual.resolveSourcePaths>) {
			const hook = fsRace.beforeResolveSourcePaths;
			fsRace.beforeResolveSourcePaths = undefined;
			hook?.();
			return actual.resolveSourcePaths(...args);
		},
	};
});

import { upsertManifest } from "./manifest-store.js";
import { buildEvidenceIndex, writeEvidenceIndexAtomic } from "./evidence-index.js";
import { resolveWikiPageDetailFromContent } from "./provenance-resolver.js";
import { openSourceById, readEvidenceIndexForSource } from "./source-access.js";
import type { ManifestEntry, RawSourceType } from "./types.js";

const roots: string[] = [];

function makeRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "inno-source-access-"));
	roots.push(root);
	mkdirSync(join(root, "raw", "uploads"), { recursive: true });
	return root;
}

function hash(bytes: string | Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function samePath(left: string, right: string): boolean {
	return process.platform === "win32"
		? left.toLowerCase() === right.toLowerCase()
		: left === right;
}

function manifest(
	id: string,
	rawPath: string,
	sourceType: RawSourceType = "markdown",
): ManifestEntry {
	return {
		id,
		title: "Source title",
		sourceType,
		rawPath,
		wikiPages: [],
		tags: [],
		contentHash: "legacy",
		status: "indexed",
		source: { origin: "user_upload" },
		createdAt: "2026-08-16T00:00:00.000Z",
		updatedAt: "2026-08-16T00:00:00.000Z",
	};
}

function pageFor(sourceId: string): string {
	return `---\nsource_ids:\n  - ${sourceId}\nsources: []\nevidence_refs: []\n---\nBody\n`;
}

beforeEach(() => {
	fsRace.afterFirstRead = undefined;
	fsRace.beforeResolveSourcePaths = undefined;
	fsRace.closedPaths.length = 0;
});

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("openSourceById", () => {
	it("opens the exact manifest source and verifies its revision on the returned handle", async () => {
		const root = makeRoot();
		const id = "l2src_opened";
		const rawPath = "raw/uploads/lesson.md";
		const bytes = "# Lesson\n\nEvidence.\n";
		writeFileSync(join(root, rawPath), bytes, "utf8");
		upsertManifest(root, { ...manifest(id, rawPath), rawContentHash: hash(bytes) });
		const revision = `sha256:${hash(bytes)}`;

		const opened = await openSourceById(root, id, revision);
		try {
			expect(opened.entry.id).toBe(id);
			expect(opened.sourceRevision).toBe(revision);
			expect(opened.mimeType).toBe("text/markdown; charset=utf-8");
			expect(opened.displayName).toBe("Source title.md");
			expect(opened.stat.size).toBe(Buffer.byteLength(bytes));
			const buffer = Buffer.alloc(Buffer.byteLength(bytes));
			const result = await opened.handle.read(buffer, 0, buffer.length, 0);
			expect(result.bytesRead).toBe(buffer.length);
			expect(buffer.toString("utf8")).toBe(bytes);
		} finally {
			await opened.handle.close();
		}
	});

	it("forces the display name to retain the controlled raw extension", async () => {
		const root = makeRoot();
		const id = "l2src_display_name";
		const rawPath = "raw/uploads/source.md";
		const bytes = "content";
		writeFileSync(join(root, rawPath), bytes, "utf8");
		upsertManifest(root, {
			...manifest(id, rawPath),
			title: "report.html",
		});

		const opened = await openSourceById(root, id, `sha256:${hash(bytes)}`);
		try {
			expect(opened.displayName).toBe("report.html.md");
		} finally {
			await opened.handle.close();
		}
	});

	it("distinguishes an unknown source, a missing raw file, and a stale revision", async () => {
		const root = makeRoot();
		const id = "l2src_failures";
		const rawPath = "raw/uploads/source.md";
		const bytes = "current bytes";
		writeFileSync(join(root, rawPath), bytes, "utf8");
		upsertManifest(root, manifest(id, rawPath));

		await expect(openSourceById(root, "l2src_unknown", `sha256:${"0".repeat(64)}`)).rejects.toMatchObject({
			code: "source_not_found",
		});
		await expect(openSourceById(root, id, `sha256:${"0".repeat(64)}`)).rejects.toMatchObject({
			code: "source_revision_mismatch",
		});

		rmSync(join(root, rawPath));
		await expect(openSourceById(root, id, `sha256:${hash(bytes)}`)).rejects.toMatchObject({
			code: "source_file_not_found",
		});
	});

	it("detects an in-place raw mutation during hashing and closes the failed handle", async () => {
		const root = makeRoot();
		const id = "l2src_mutated_during_hash";
		const rawPath = "raw/uploads/source.md";
		const absolutePath = join(root, rawPath);
		const original = "original";
		writeFileSync(absolutePath, original, "utf8");
		upsertManifest(root, manifest(id, rawPath));
		fsRace.afterFirstRead = (openedPath) => {
			if (samePath(openedPath, absolutePath)) writeFileSync(absolutePath, "modified", "utf8");
		};

		await expect(openSourceById(root, id, `sha256:${hash(original)}`)).rejects.toMatchObject({
			code: "source_changed",
		});
		expect(fsRace.closedPaths.some((path) => samePath(path, absolutePath))).toBe(true);
	});

	it("detects replacement of the raw pathname after opening and closes the old handle", async () => {
		const root = makeRoot();
		const id = "l2src_replaced_after_open";
		const rawPath = "raw/uploads/source.md";
		const absolutePath = join(root, rawPath);
		const relocatedPath = join(root, "raw", "uploads", "relocated.md");
		const original = "original";
		writeFileSync(absolutePath, original, "utf8");
		upsertManifest(root, manifest(id, rawPath));
		fsRace.afterFirstRead = (openedPath) => {
			if (!samePath(openedPath, absolutePath)) return;
			renameSync(absolutePath, relocatedPath);
			writeFileSync(absolutePath, original, "utf8");
		};

		await expect(openSourceById(root, id, `sha256:${hash(original)}`)).rejects.toMatchObject({
			code: "source_changed",
		});
		expect(fsRace.closedPaths.some((path) => samePath(path, absolutePath))).toBe(true);
	});

	it("rejects a source above the archive size limit and closes its handle", async () => {
		const root = makeRoot();
		const id = "l2src_oversized";
		const rawPath = "raw/uploads/oversized.md";
		const absolutePath = join(root, rawPath);
		writeFileSync(absolutePath, "", "utf8");
		truncateSync(absolutePath, 100 * 1024 * 1024 + 1);
		upsertManifest(root, manifest(id, rawPath));

		await expect(openSourceById(root, id, `sha256:${"0".repeat(64)}`)).rejects.toMatchObject({
			code: "source_too_large",
		});
		expect(fsRace.closedPaths.some((path) => samePath(path, absolutePath))).toBe(true);
	});

	it("rejects evidence access when the raw pathname is replaced after opening", async () => {
		const root = makeRoot();
		const id = "l2src_raw_replaced_before_evidence";
		const rawPath = "raw/uploads/source.md";
		const absolutePath = join(root, rawPath);
		const relocatedPath = join(root, "raw", "uploads", "relocated.md");
		const original = "Evidence.";
		writeFileSync(absolutePath, original, "utf8");
		upsertManifest(root, manifest(id, rawPath));
		writeEvidenceIndexAtomic(root, buildEvidenceIndex({
			sourceId: id,
			sourceType: "markdown",
			rawContentHash: hash(original),
			parsed: { text: original, pageCount: 1, pages: [{ pageNumber: 1, text: original }] },
		}));

		const opened = await openSourceById(root, id, `sha256:${hash(original)}`);
		try {
			renameSync(absolutePath, relocatedPath);
			writeFileSync(absolutePath, original, "utf8");

			await expect(readEvidenceIndexForSource(root, opened)).rejects.toMatchObject({
				code: "source_changed",
			});
		} finally {
			await opened.handle.close();
		}
	});

	it("reports source_changed without leaking the path when an opened raw pathname disappears", async () => {
		const root = makeRoot();
		const id = "l2src_raw_removed_before_evidence";
		const rawPath = "raw/uploads/source.md";
		const absolutePath = join(root, rawPath);
		const original = "Evidence.";
		writeFileSync(absolutePath, original, "utf8");
		upsertManifest(root, manifest(id, rawPath));

		const opened = await openSourceById(root, id, `sha256:${hash(original)}`);
		try {
			rmSync(absolutePath);
			const failure = await readEvidenceIndexForSource(root, opened).catch((error: unknown) => error);

			expect(failure).toMatchObject({ code: "source_changed", message: "source_changed" });
			expect(String(failure)).not.toContain(root);
			expect(String(failure)).not.toContain(absolutePath);
		} finally {
			await opened.handle.close();
		}
	});

	it("rechecks the opened raw handle before returning an unresolved evidence path", async () => {
		const root = makeRoot();
		const id = "l2src_raw_removed_during_evidence_resolution";
		const rawPath = "raw/uploads/source.md";
		const absolutePath = join(root, rawPath);
		const original = "Evidence.";
		writeFileSync(absolutePath, original, "utf8");
		upsertManifest(root, manifest(id, rawPath));

		const opened = await openSourceById(root, id, `sha256:${hash(original)}`);
		fsRace.beforeResolveSourcePaths = () => rmSync(absolutePath);
		try {
			await expect(readEvidenceIndexForSource(root, opened)).rejects.toMatchObject({
				code: "source_changed",
			});
		} finally {
			await opened.handle.close();
		}
	});

	it("reports a corrupt index when its pathname disappears after the handle is opened", async () => {
		const root = makeRoot();
		const id = "l2src_index_removed_during_read";
		const rawPath = "raw/uploads/source.md";
		const absolutePath = join(root, rawPath);
		const original = "Evidence.";
		writeFileSync(absolutePath, original, "utf8");
		upsertManifest(root, manifest(id, rawPath));
		writeEvidenceIndexAtomic(root, buildEvidenceIndex({
			sourceId: id,
			sourceType: "markdown",
			rawContentHash: hash(original),
			parsed: { text: original, pageCount: 1, pages: [{ pageNumber: 1, text: original }] },
		}));
		const indexPath = join(root, "extracted", "evidence", "by-id", `${hash(id)}.json`);
		const opened = await openSourceById(root, id, `sha256:${hash(original)}`);
		fsRace.afterFirstRead = (openedPath) => {
			if (samePath(openedPath, indexPath)) rmSync(indexPath);
		};

		try {
			await expect(readEvidenceIndexForSource(root, opened)).resolves.toEqual({ status: "corrupt-index" });
			expect(fsRace.closedPaths.some((path) => samePath(path, indexPath))).toBe(true);
		} finally {
			await opened.handle.close();
		}
	});

	it.each([
		["wiki page", "wiki/concepts/private.md"],
		["manifest", "manifest.jsonl"],
		["parent traversal", "raw/../wiki/private.md"],
		["absolute path", "C:\\private\\source.md"],
		["drive-relative path", "C:private\\source.md"],
		["alternate data stream", "raw/uploads/source.md:private"],
		["Windows device name", "raw/uploads/NUL.md"],
		["Windows-forbidden character", "raw/uploads/bad?.md"],
		["Windows trailing dot", "raw/uploads/source.md."],
		["Windows trailing space", "raw/uploads/source.md "],
	])("rejects a manifest rawPath targeting %s with the same safe result as page detail", async (_label, rawPath) => {
		const root = makeRoot();
		const id = "l2src_unsafe";
		mkdirSync(join(root, "wiki", "concepts"), { recursive: true });
		writeFileSync(join(root, "wiki", "concepts", "private.md"), "private", "utf8");
		writeFileSync(join(root, "manifest.jsonl"), "", "utf8");
		upsertManifest(root, manifest(id, rawPath));

		await expect(openSourceById(root, id, `sha256:${"0".repeat(64)}`)).rejects.toMatchObject({
			code: "source_file_unavailable",
		});
		const detail = resolveWikiPageDetailFromContent(root, "wiki/concepts/page.md", pageFor(id));
		expect(detail.provenance.sourceGroups[0]).toMatchObject({
			availability: "missing-file",
			sourceId: id,
		});
		expect(detail.provenance.sourceGroups[0]).not.toHaveProperty("rawRelativePath");
	});

	it("rejects a raw path redirected through a junction", async () => {
		const root = makeRoot();
		const outside = mkdtempSync(join(tmpdir(), "inno-source-access-outside-"));
		roots.push(outside);
		const id = "l2src_junction";
		writeFileSync(join(outside, "source.md"), "outside secret", "utf8");
		symlinkSync(outside, join(root, "raw", "linked"), process.platform === "win32" ? "junction" : "dir");
		upsertManifest(root, manifest(id, "raw/linked/source.md"));

		await expect(openSourceById(root, id, `sha256:${hash("outside secret")}`)).rejects.toMatchObject({
			code: "source_file_unavailable",
		});
		const detail = resolveWikiPageDetailFromContent(root, "wiki/concepts/page.md", pageFor(id));
		expect(detail.provenance.sourceGroups[0]).toMatchObject({
			availability: "missing-file",
			sourceId: id,
		});
	});
});
