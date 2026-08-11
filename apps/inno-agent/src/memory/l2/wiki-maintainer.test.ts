import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ManifestEntry, WikiPageFrontmatter } from "./types.js";
import {
	createSourcePage,
	ensureL2Directories,
	parseFrontmatter,
	rebuildIndex,
	serializeFrontmatter,
} from "./wiki-maintainer.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "inno-l2-maintainer-"));
	tempDirs.push(dir);
	return dir;
}

function entry(overrides: Partial<ManifestEntry> = {}): ManifestEntry {
	return {
		id: "l2src_source1",
		title: "测试资料",
		sourceType: "markdown",
		rawPath: "raw/uploads/source.md",
		extractedPath: "extracted/source.md",
		wikiPages: [],
		tags: ["学习", "yaml:value"],
		contentHash: "abc123",
		status: "indexed",
		source: { origin: "user_upload" },
		createdAt: "2026-07-30T00:00:00.000Z",
		updatedAt: "2026-07-30T00:00:00.000Z",
		...overrides,
	};
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("L2 wiki maintenance", () => {
	it("round-trips frontmatter through the YAML parser", () => {
		const frontmatter: WikiPageFrontmatter = {
			title: "包含: 冒号与 # 符号",
			created: "2026-07-30",
			type: "concept",
			tags: ["yaml:value", "中文 标签"],
			sources: ["wiki/sources/source.md"],
			source_ids: ["l2src_source1"],
			updated: "2026-07-30",
			status: "reviewed",
			confidence: "high",
			contested: false,
		};

		const parsed = parseFrontmatter(`${serializeFrontmatter(frontmatter)}\n正文`);
		expect(parsed.frontmatter).toEqual({ ...frontmatter, contradictions: [] });
		expect(parsed.body).toBe("正文");
	});

	it("serializes Windows source paths with portable separators", () => {
		const frontmatter: WikiPageFrontmatter = {
			title: "Portable source",
			created: "2026-07-30",
			type: "analysis",
			tags: [],
			sources: ["workspace\\reports\\result.md"],
			source_ids: [],
			updated: "2026-07-30",
			status: "draft",
			confidence: "medium",
		};

		const serialized = serializeFrontmatter(frontmatter);
		expect(serialized).not.toContain("\\");
		expect(parseFrontmatter(`${serialized}\nBody`).frontmatter?.sources).toEqual([
			"workspace/reports/result.md",
		]);
	});

	it("creates navigation and schema files without user setup", () => {
		const root = makeTempDir();
		ensureL2Directories(root);

		expect(readFileSync(join(root, "wiki", "SCHEMA.md"), "utf8")).toContain("# L2 Wiki Schema");
		expect(readFileSync(join(root, "wiki", "index.md"), "utf8")).toContain("# L2 Wiki 索引");
		expect(readFileSync(join(root, "wiki", "log.md"), "utf8")).toContain("# L2 Wiki Log");
	});

	it("keeps source provenance in the page and rebuilt index", () => {
		const root = makeTempDir();
		ensureL2Directories(root);
		const source = entry();
		const pagePath = createSourcePage(root, source, "## 摘要\n\n核心结论。", source.extractedPath);
		source.wikiPages = [pagePath];
		rebuildIndex(root, [source]);

		const page = readFileSync(join(root, pagePath), "utf8");
		const parsed = parseFrontmatter(page);
		expect(parsed.frontmatter?.source_ids).toEqual([source.id]);
		expect(parsed.frontmatter?.sources).toEqual([source.rawPath]);
		expect(page).toContain(source.extractedPath);
		expect(readFileSync(join(root, "wiki", "index.md"), "utf8")).toContain(pagePath);
	});
});
