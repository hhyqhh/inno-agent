import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readManifest, upsertManifest } from "./manifest-store.js";
import { regenerateL2Source, saveRawMarkdownContent } from "./sources-service.js";
import type { L2Memory } from "./l2-memory.js";
import { writeText } from "../../storage/file-store.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "inno-sources-"));
	roots.push(root);
	mkdirSync(join(root, "raw", "uploads"), { recursive: true });
	return root;
}

describe("saveRawMarkdownContent", () => {
	it("marks an archived source outdated without replacing its archived hash", () => {
		const root = tempRoot();
		const rawPath = "raw/uploads/source.md";
		writeText(join(root, rawPath), "old content\n");
		upsertManifest(root, {
			id: "l2src_test",
			title: "Source",
			sourceType: "markdown",
			rawPath,
			extractedPath: "extracted/old.md",
			wikiPages: ["wiki/sources/source.md"],
			tags: [],
			contentHash: "archived-hash",
			status: "indexed",
			source: { origin: "user_upload" },
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		});

		expect(saveRawMarkdownContent(root, rawPath, "new content")).toEqual({ rawPath, status: "outdated" });
		expect(readFileSync(join(root, rawPath), "utf-8")).toBe("new content\n");
		const [entry] = readManifest(root);
		expect(entry.status).toBe("outdated");
		expect(entry.contentHash).toBe("archived-hash");
	});

	it("rejects paths outside raw storage and note files", () => {
		const root = tempRoot();
		expect(() => saveRawMarkdownContent(root, "../outside.md", "x")).toThrow("Invalid raw path");
		expect(() => saveRawMarkdownContent(root, "raw/notes/note.md", "x")).toThrow("Invalid raw path");
	});
});

describe("regenerateL2Source", () => {
	it("reuses the source identity through the shared archive pipeline", async () => {
		const root = tempRoot();
		const rawPath = "raw/uploads/source.md";
		writeText(join(root, rawPath), "# Agent systems\n\nAgents use tools and memory.\n");
		upsertManifest(root, {
			id: "l2src_test",
			title: "Agent systems",
			sourceType: "markdown",
			rawPath,
			wikiPages: [],
			tags: ["agents"],
			contentHash: "old-hash",
			status: "outdated",
			source: { origin: "user_upload" },
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		});
		const memory = {
			indexPageByPath: async () => undefined,
			removePage: async () => undefined,
		} as unknown as L2Memory;

		const result = await regenerateL2Source(root, "l2src_test", { memory });

		expect(result.sourceId).toBe("l2src_test");
		expect(result.duplicate).toBe(false);
		expect(readManifest(root)).toHaveLength(1);
		expect(readManifest(root)[0]).toMatchObject({ id: "l2src_test", status: "indexed" });
	});

	it("rejects an unknown source id", async () => {
		const root = tempRoot();
		await expect(regenerateL2Source(root, "missing")).rejects.toThrow("Source not found");
	});
});
