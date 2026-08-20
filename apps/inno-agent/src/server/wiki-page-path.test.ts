import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveAllowedWikiPage } from "./wiki-page-path.js";

const roots: string[] = [];

function temporaryDirectory(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	roots.push(directory);
	return directory;
}

function makeL2Root(): string {
	const root = temporaryDirectory("inno-wiki-path-");
	for (const directory of ["sources", "entities", "concepts", "analysis"]) {
		mkdirSync(join(root, "wiki", directory), { recursive: true });
	}
	return root;
}

function removeLink(path: string): void {
	if (!existsSync(path)) return;
	if (lstatSync(path).isSymbolicLink()) rmSync(path, { force: true });
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("resolveAllowedWikiPage", () => {
	it.each(["sources", "entities", "concepts", "analysis"])(
		"allows one Markdown page below wiki/%s for every intent",
		(directory) => {
			const root = makeL2Root();
			const relativePath = `wiki/${directory}/Topic 一.md`;
			for (const intent of ["read", "write", "delete"] as const) {
				expect(resolveAllowedWikiPage(root, relativePath, intent)).toEqual({
					relativePath,
					absolutePath: resolve(realpathSync.native(root), "wiki", directory, "Topic 一.md"),
				});
			}
		},
	);

	it("normalizes accepted backslashes to a canonical Wiki path", () => {
		const root = makeL2Root();

		expect(resolveAllowedWikiPage(root, "wiki\\concepts\\topic.md", "write")).toEqual({
			relativePath: "wiki/concepts/topic.md",
			absolutePath: resolve(realpathSync.native(root), "wiki", "concepts", "topic.md"),
		});
	});

	it("creates only the fixed Wiki parent chain for an allowed write", () => {
		const root = temporaryDirectory("inno-wiki-path-empty-");

		expect(resolveAllowedWikiPage(root, "wiki/concepts/new.md", "write")).toEqual({
			relativePath: "wiki/concepts/new.md",
			absolutePath: join(realpathSync.native(root), "wiki", "concepts", "new.md"),
		});
		expect(lstatSync(join(root, "wiki")).isDirectory()).toBe(true);
		expect(lstatSync(join(root, "wiki", "concepts")).isDirectory()).toBe(true);
		expect(existsSync(join(root, "wiki", "sources"))).toBe(false);
	});

	it("returns the on-disk filename casing for an existing Windows page", () => {
		if (process.platform !== "win32") return;
		const root = makeL2Root();
		writeFileSync(join(root, "wiki", "concepts", "Actual.md"), "body", "utf8");

		expect(resolveAllowedWikiPage(root, "wiki/concepts/actual.md", "read")).toEqual({
			relativePath: "wiki/concepts/Actual.md",
			absolutePath: join(realpathSync.native(root), "wiki", "concepts", "Actual.md"),
		});
	});

	it.each([
		"",
		"raw/uploads/secret.md",
		"extracted/evidence/by-id/private.json",
		"manifest.jsonl",
		"wiki/index.md",
		"wiki/log.md",
		"wiki/schema.md",
		"wiki/unknown/page.md",
		"wiki/concepts/nested/page.md",
		"wiki/concepts/page.txt",
		"wiki/concepts/page.MD",
		"wiki/concepts/.md",
		"wiki/concepts/page.md:secret.md",
		"wiki/concepts/CON.md",
		"wiki/concepts/bad?.md",
		"wiki//concepts/page.md",
		"wiki/./concepts/page.md",
		"wiki/concepts/../analysis/page.md",
		"../wiki/concepts/page.md",
		"/wiki/concepts/page.md",
		"C:\\wiki\\concepts\\page.md",
		"C:wiki\\concepts\\page.md",
		"C:/wiki/concepts/page.md",
		"\\\\server\\share\\wiki\\concepts\\page.md",
		"\\\\?\\C:\\wiki\\concepts\\page.md",
		"wiki/concepts/page.md\0suffix",
	])("rejects a non-page or platform path: %s", (requestedPath) => {
		const root = makeL2Root();

		for (const intent of ["read", "write", "delete"] as const) {
			expect(resolveAllowedWikiPage(root, requestedPath, intent)).toBeNull();
		}
	});

	it.each(["inside", "outside"] as const)("rejects a Wiki category junction pointing %s the L2 root", (direction) => {
		const root = makeL2Root();
		const outside = temporaryDirectory("inno-wiki-path-junction-");
		const realDirectory = direction === "inside" ? join(root, "wiki", "real-concepts") : outside;
		const linkedDirectory = join(root, "wiki", "concepts");
		if (direction === "inside") mkdirSync(realDirectory);
		rmSync(linkedDirectory, { recursive: true });
		symlinkSync(realDirectory, linkedDirectory, process.platform === "win32" ? "junction" : "dir");

		try {
			for (const intent of ["read", "write", "delete"] as const) {
				expect(resolveAllowedWikiPage(root, "wiki/concepts/page.md", intent)).toBeNull();
			}
		} finally {
			removeLink(linkedDirectory);
		}
	});

	it("rejects a Wiki page symlink instead of following it", () => {
		const root = makeL2Root();
		const outside = temporaryDirectory("inno-wiki-path-outside-");
		const secret = join(outside, "secret.md");
		const link = join(root, "wiki", "analysis", "page.md");
		writeFileSync(secret, "secret", "utf8");
		try {
			symlinkSync(secret, link, "file");
		} catch (error) {
			if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") return;
			throw error;
		}

		try {
			for (const intent of ["read", "write", "delete"] as const) {
				expect(resolveAllowedWikiPage(root, "wiki/analysis/page.md", intent)).toBeNull();
			}
		} finally {
			removeLink(link);
		}
	});

	it("rejects an L2 root reached through a junction", () => {
		const parent = temporaryDirectory("inno-wiki-path-parent-");
		const root = join(parent, "real-l2");
		const linkedRoot = join(parent, "linked-l2");
		for (const directory of ["sources", "entities", "concepts", "analysis"]) {
			mkdirSync(join(root, "wiki", directory), { recursive: true });
		}
		symlinkSync(root, linkedRoot, process.platform === "win32" ? "junction" : "dir");

		try {
			expect(resolveAllowedWikiPage(linkedRoot, "wiki/concepts/page.md", "read")).toBeNull();
		} finally {
			removeLink(linkedRoot);
		}
	});

	it("rejects a directory where a Markdown file is expected", () => {
		const root = makeL2Root();
		mkdirSync(join(root, "wiki", "sources", "page.md"));

		expect(resolveAllowedWikiPage(root, "wiki/sources/page.md", "read")).toBeNull();
	});
});
