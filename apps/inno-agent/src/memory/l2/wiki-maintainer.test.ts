import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { decodeEvidenceRefs } from "./evidence-types.js";
import type { ManifestEntry, WikiPageFrontmatter } from "./types.js";
import {
	bodyRevision,
	createSourcePage,
	ensureL2Directories,
	fileRevision,
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

	it("parses CRLF frontmatter and preserves the body line endings", () => {
		const frontmatter: WikiPageFrontmatter = {
			title: "Windows page",
			created: "2026-08-18",
			type: "concept",
			tags: ["windows"],
			sources: ["wiki/sources/source.md"],
			source_ids: ["l2src_source1"],
			updated: "2026-08-18",
			status: "draft",
			confidence: "medium",
		};
		const content = `${serializeFrontmatter(frontmatter)}\nFirst line\nSecond line`.replace(/\n/g, "\r\n");

		const parsed = parseFrontmatter(content);

		expect(parsed.frontmatter).toEqual({ ...frontmatter, contradictions: [] });
		expect(parsed.body).toBe("First line\r\nSecond line");
	});

	it("round-trips valid nested evidence refs without changing their structure", () => {
		const evidenceRefs = [
			{
				source_id: "l2src_source1",
				quote: "A PDF quote",
				source_revision: `sha256:${"a".repeat(64)}`,
				page_revision: `sha256:${"b".repeat(64)}`,
				index_version: 1,
				selected_by: "model",
				locator: { kind: "pdf-page", page: 4, block_id: "pdf:block:4" },
			},
			{
				source_id: "l2src_source1",
				quote: "A Markdown quote",
				source_revision: `sha256:${"c".repeat(64)}`,
				page_revision: `sha256:${"d".repeat(64)}`,
				index_version: 1,
				selected_by: "user",
				locator: { kind: "markdown-block", heading: "Evidence", paragraph: 2, block_id: "md:block:2" },
			},
		];
		const frontmatter: WikiPageFrontmatter = {
			title: "Evidence page",
			created: "2026-08-14",
			type: "analysis",
			tags: ["evidence"],
			sources: ["raw/uploads/source.pdf"],
			source_ids: ["l2src_source1"],
			updated: "2026-08-14",
			status: "reviewed",
			confidence: "high",
			contested: true,
			contradictions: ["A historical contradiction"],
			evidence_refs: evidenceRefs,
		};

		const serialized = serializeFrontmatter(frontmatter);
		const first = parseFrontmatter(`${serialized}\nOriginal body`);
		const second = parseFrontmatter(`${serializeFrontmatter(first.frontmatter!)}\n${first.body}`);

		expect(serialized.indexOf("evidence_refs:")).toBeGreaterThan(serialized.indexOf("contradictions:"));
		expect(first.frontmatter?.evidence_refs).toEqual(evidenceRefs);
		expect(second.frontmatter?.evidence_refs).toEqual(evidenceRefs);
		expect(decodeEvidenceRefs(second.frontmatter?.evidence_refs, second.frontmatter?.source_ids ?? [])).toEqual({
			valid: evidenceRefs,
			issues: [],
		});
	});

	it("preserves nested evidence YAML across an ordinary body edit", () => {
		const original = `---
title: Nested evidence
created: 2026-08-14
type: concept
tags: [evidence]
sources: [raw/uploads/source.docx]
source_ids: [l2src_source1]
updated: 2026-08-14
status: draft
confidence: medium
evidence_refs:
  - source_id: l2src_source1
    quote: Nested locator data
    source_revision: sha256:${"e".repeat(64)}
    page_revision: sha256:${"f".repeat(64)}
    index_version: 1
    selected_by: model
    locator:
      kind: docx-paragraph
      block_id: docx:block:9
      heading: Findings
      paragraph: 9
---
Original body`;

		const parsed = parseFrontmatter(original);
		const before = parsed.frontmatter?.evidence_refs;
		const edited = parseFrontmatter(`${serializeFrontmatter(parsed.frontmatter!)}\nEdited body`);

		expect(edited.body).toBe("Edited body");
		expect(edited.frontmatter?.evidence_refs).toEqual(before);
	});

	it("keeps structurally malformed evidence entries observable to the decoder", () => {
		const parsed = parseFrontmatter(`---
title: Malformed evidence
created: 2026-08-14
type: concept
tags: [evidence]
sources:
  - raw/uploads/source.md
  - nested: source-must-not-be-stringified
source_ids:
  - l2src_source1
  - [source-id-must-not-be-stringified]
updated: 2026-08-14
status: draft
confidence: medium
evidence_refs:
  - malformed-ref
  - source_id: l2src_source1
    quote: Unknown locator
    source_revision: sha256:${"a".repeat(64)}
    page_revision: sha256:${"b".repeat(64)}
    index_version: 1
    selected_by: model
    locator:
      kind: future-locator
      private: must-not-leak
---
Body`);

		expect(parsed.frontmatter?.sources).toEqual(["raw/uploads/source.md"]);
		expect(parsed.frontmatter?.source_ids).toEqual(["l2src_source1"]);
		expect(parsed.frontmatter?.evidence_refs).toEqual([
			"malformed-ref",
			expect.objectContaining({ locator: { kind: "future-locator", private: "must-not-leak" } }),
		]);
		expect(decodeEvidenceRefs(parsed.frontmatter?.evidence_refs, parsed.frontmatter?.source_ids ?? [])).toEqual({
			valid: [],
			issues: [
				{ ordinal: 0, code: "not-object" },
				{ ordinal: 1, sourceId: "l2src_source1", code: "invalid-locator" },
			],
		});
	});

	it("builds complete SHA-256 revisions from normalized bodies and exact file bytes", () => {
		const normalizedRevision = "sha256:e49c81e2d2f84e259d40e2fb8192f3bcd198b355184845d76d8f58807d0d78ee";
		const crlfFileRevision = "sha256:98ab4d3aeab1e120560e942e2df6a0db1147bf94bafcf1590000ffb3c2b6fc80";

		expect(bodyRevision("alpha\nbeta\n")).toBe(normalizedRevision);
		expect(bodyRevision("alpha\r\nbeta\r")).toBe(normalizedRevision);
		expect(fileRevision(Buffer.from("alpha\nbeta\n", "utf8"))).toBe(normalizedRevision);
		expect(fileRevision(Buffer.from("alpha\r\nbeta\r\n", "utf8"))).toBe(crlfFileRevision);
	});

	it("preserves historical scalar coercion while filtering nested array values", () => {
		const parsed = parseFrontmatter(`---
title: 42
created: 20260814
type: concept
tags: [evidence]
sources:
  - raw/uploads/source.md
  - nested: must-not-be-stringified
source_ids: [l2src_source1]
updated: false
status: draft
confidence: medium
---
Body`);

		expect(parsed.frontmatter).toEqual(expect.objectContaining({
			title: "42",
			created: "20260814",
			updated: "false",
			sources: ["raw/uploads/source.md"],
		}));
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

	it("rejects a source-summary path owned by another source", () => {
		const root = makeTempDir();
		ensureL2Directories(root);
		const owner = entry({ id: "l2src_foo123" });
		const colliding = entry({ id: "other_foo123" });
		const pagePath = createSourcePage(root, owner, "## 摘要\n\n原来源内容。", owner.extractedPath);
		const before = readFileSync(join(root, pagePath), "utf8");

		expect(() => createSourcePage(root, colliding, "## 摘要\n\n不应覆盖。", colliding.extractedPath))
			.toThrow("Source summary path is owned by another source");
		expect(readFileSync(join(root, pagePath), "utf8")).toBe(before);
	});
});
