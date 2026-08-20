import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ManifestEntry } from "./types.js";
import { resolveRawSourcePath, resolveSourcePaths } from "./source-path.js";

const tempDirs: string[] = [];

function makeTempDir(prefix = "inno-source-path-"): string {
	const path = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(path);
	return path;
}

function makeRoot(): string {
	const root = makeTempDir();
	mkdirSync(join(root, "raw", "uploads"), { recursive: true });
	mkdirSync(join(root, "extracted", "evidence", "by-id"), { recursive: true });
	return root;
}

function entry(rawPath = "raw/uploads/source.md", id = "l2src_source"): ManifestEntry {
	return {
		id,
		title: "Source",
		sourceType: "markdown",
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

function sourceIdHash(sourceId: string): string {
	return createHash("sha256").update(sourceId, "utf8").digest("hex");
}

function directoryLink(target: string, link: string): void {
	symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

afterEach(() => {
	for (const path of tempDirs.splice(0).reverse()) {
		try {
			rmSync(path, { recursive: true, force: true });
		} catch {
			// Windows can retain a junction briefly; cleanup is best effort in tests.
		}
	}
});

describe("resolveSourcePaths", () => {
	it("resolves a safe raw independently from an unsafe evidence directory", () => {
		const root = makeRoot();
		const outside = makeTempDir("inno-evidence-outside-");
		const rawPath = join(root, "raw", "uploads", "source.md");
		writeFileSync(rawPath, "source", "utf8");
		const byId = join(root, "extracted", "evidence", "by-id");
		rmSync(byId, { recursive: true });
		directoryLink(outside, byId);

		try {
			expect(resolveRawSourcePath(root, entry())).toEqual({
				status: "ready",
				rawAbsolutePath: realpathSync.native(rawPath),
				rawRelativePath: "raw/uploads/source.md",
			});
			expect(resolveSourcePaths(root, entry())).toEqual({ status: "unsafe-path" });
		} finally {
			if (existsSync(byId) && lstatSync(byId).isSymbolicLink()) unlinkSync(byId);
		}
	});

	it("returns canonical ready paths and a full SHA-256 evidence filename", () => {
		const root = makeRoot();
		const rawPath = join(root, "raw", "uploads", "source.md");
		writeFileSync(rawPath, "# Source\n", "utf8");

		const result = resolveSourcePaths(root, entry("raw\\uploads\\source.md", "l2src_../../visible"));

		expect(result).toEqual({
			status: "ready",
			rawAbsolutePath: realpathSync.native(rawPath),
			rawRelativePath: "raw/uploads/source.md",
			evidenceIndexAbsolutePath: resolve(
				realpathSync.native(root),
				"extracted",
				"evidence",
				"by-id",
				`${sourceIdHash("l2src_../../visible")}.json`,
			),
		});
		expect(result.status === "ready" && result.evidenceIndexAbsolutePath).toMatch(/[\\/][0-9a-f]{64}\.json$/u);
	});

	it("returns missing-file for a normal absent raw without creating anything", () => {
		const root = makeRoot();
		const before = existsSync(join(root, "raw", "uploads", "missing.md"));

		const result = resolveSourcePaths(root, entry("raw/uploads/missing.md"));

		expect(before).toBe(false);
		expect(result).toEqual({
			status: "missing-file",
			rawRelativePath: "raw/uploads/missing.md",
			evidenceIndexAbsolutePath: resolve(
				realpathSync.native(root),
				"extracted",
				"evidence",
				"by-id",
				`${sourceIdHash("l2src_source")}.json`,
			),
		});
		expect(existsSync(join(root, "raw", "uploads", "missing.md"))).toBe(false);
	});

	it.each([
		["POSIX absolute", "/raw/uploads/source.md"],
		["drive absolute", "C:\\raw\\uploads\\source.md"],
		["drive relative", "C:raw\\uploads\\source.md"],
		["UNC", "\\\\server\\share\\source.md"],
		["device path", "\\\\?\\C:\\raw\\source.md"],
		["parent traversal", "../raw/uploads/source.md"],
		["collapsing traversal", "raw/uploads/../uploads/source.md"],
		["wrong directory", "wiki/sources/source.md"],
		["evidence directory", "extracted/evidence/by-id/source.json"],
		["staging", "raw/.staging/source.md"],
		["case-variant staging", "raw/.STAGING/source.md"],
		["raw root", "raw"],
	] as const)("rejects %s without echoing the malicious path", (_label, rawPath) => {
		const root = makeRoot();
		expect(resolveSourcePaths(root, entry(rawPath))).toEqual({ status: "unsafe-path" });
	});

	it("rejects an absolute path even when it points inside the raw root", () => {
		const root = makeRoot();
		const rawPath = join(root, "raw", "uploads", "source.md");
		writeFileSync(rawPath, "source", "utf8");

		expect(resolveSourcePaths(root, entry(rawPath))).toEqual({ status: "unsafe-path" });
	});

	it("rejects directories and non-file raw targets", () => {
		const root = makeRoot();
		mkdirSync(join(root, "raw", "uploads", "directory.md"));

		expect(resolveSourcePaths(root, entry("raw/uploads/directory.md"))).toEqual({ status: "unsafe-path" });
	});

	it.each(["inward", "outward"] as const)("rejects an %s raw parent junction", (direction) => {
		const root = makeRoot();
		const realUploads = direction === "inward"
			? join(root, "raw", "real-uploads")
			: makeTempDir("inno-source-outside-");
		mkdirSync(realUploads, { recursive: true });
		writeFileSync(join(realUploads, "source.md"), "source", "utf8");
		rmSync(join(root, "raw", "uploads"), { recursive: true });
		directoryLink(realUploads, join(root, "raw", "uploads"));

		try {
			expect(resolveSourcePaths(root, entry())).toEqual({ status: "unsafe-path" });
		} finally {
			const link = join(root, "raw", "uploads");
			if (existsSync(link) && lstatSync(link).isSymbolicLink()) unlinkSync(link);
		}
	});

	it("rejects a junction used as the L2 root", () => {
		const realRoot = makeRoot();
		writeFileSync(join(realRoot, "raw", "uploads", "source.md"), "source", "utf8");
		const linkParent = makeTempDir("inno-source-root-link-");
		const linkedRoot = join(linkParent, "l2-link");
		directoryLink(realRoot, linkedRoot);

		try {
			expect(resolveSourcePaths(linkedRoot, entry())).toEqual({ status: "unsafe-path" });
		} finally {
			if (existsSync(linkedRoot) && lstatSync(linkedRoot).isSymbolicLink()) unlinkSync(linkedRoot);
		}
	});

	it("rejects a junction in the parent chain used to reach the L2 root", () => {
		const realRoot = makeRoot();
		writeFileSync(join(realRoot, "raw", "uploads", "source.md"), "source", "utf8");
		const linkContainer = makeTempDir("inno-source-parent-link-");
		const linkedParent = join(linkContainer, "parent-link");
		directoryLink(dirname(realRoot), linkedParent);
		const rootReachedThroughLink = join(linkedParent, basename(realRoot));

		try {
			expect(resolveSourcePaths(rootReachedThroughLink, entry())).toEqual({ status: "unsafe-path" });
		} finally {
			if (existsSync(linkedParent) && lstatSync(linkedParent).isSymbolicLink()) unlinkSync(linkedParent);
		}
	});

	it.each(["raw-root", "raw-target", "extracted-root", "evidence-root", "by-id", "index-target"] as const)(
		"rejects a junction at the %s",
		(component) => {
			const root = makeRoot();
			const outside = makeTempDir("inno-evidence-outside-");
			let link: string;
			if (component === "raw-root") {
				link = join(root, "raw");
				rmSync(link, { recursive: true });
				mkdirSync(join(outside, "uploads"), { recursive: true });
				writeFileSync(join(outside, "uploads", "source.md"), "source", "utf8");
			} else if (component === "raw-target") {
				link = join(root, "raw", "uploads", "source.md");
			} else if (component === "extracted-root") {
				link = join(root, "extracted");
				rmSync(link, { recursive: true });
			} else if (component === "evidence-root") {
				link = join(root, "extracted", "evidence");
				rmSync(link, { recursive: true });
			} else if (component === "by-id") {
				link = join(root, "extracted", "evidence", "by-id");
				rmSync(link, { recursive: true });
			} else {
				link = join(root, "extracted", "evidence", "by-id", `${sourceIdHash("l2src_source")}.json`);
			}
			if (component !== "raw-root") {
				writeFileSync(join(root, "raw", "uploads", "source.md"), "source", "utf8");
			}
			if (component === "raw-target") rmSync(link);
			directoryLink(outside, link);

			try {
				expect(resolveSourcePaths(root, entry())).toEqual({ status: "unsafe-path" });
			} finally {
				if (existsSync(link) && lstatSync(link).isSymbolicLink()) unlinkSync(link);
			}
		},
	);
});
