import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	buildEvidenceIndex,
	type EvidenceBlock,
	type SourceEvidenceIndex,
	writeEvidenceIndexAtomic,
} from "./evidence-index.js";
import type { EvidenceLocator, EvidenceRef } from "./evidence-types.js";
import { upsertManifest } from "./manifest-store.js";
import {
	resolveWikiPageDetail,
	resolveWikiPageDetailFromContent,
} from "./provenance-resolver.js";
import type { ManifestEntry, WikiPageFrontmatter } from "./types.js";
import {
	bodyRevision,
	fileRevision,
	serializeFrontmatter,
} from "./wiki-maintainer.js";

const tempDirs: string[] = [];

function makeRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "inno-provenance-resolver-"));
	tempDirs.push(root);
	mkdirSync(join(root, "raw", "uploads"), { recursive: true });
	mkdirSync(join(root, "extracted", "evidence", "by-id"), { recursive: true });
	mkdirSync(join(root, "wiki", "concepts"), { recursive: true });
	return root;
}

function hash(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

function evidencePath(root: string, sourceId: string): string {
	return join(root, "extracted", "evidence", "by-id", `${hash(sourceId)}.json`);
}

function directoryLink(target: string, link: string): void {
	symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

function manifestEntry(
	id: string,
	rawPath: string,
	overrides: Partial<ManifestEntry> = {},
): ManifestEntry {
	return {
		id,
		title: `Title ${id}`,
		sourceType: "markdown",
		rawPath,
		wikiPages: [],
		tags: [],
		contentHash: "legacy",
		status: "indexed",
		source: { origin: "user_upload" },
		createdAt: "2026-08-16T00:00:00.000Z",
		updatedAt: "2026-08-16T00:00:00.000Z",
		...overrides,
	};
}

function createSource(
	root: string,
	id: string,
	text = "# Topic\n\nAlpha evidence.\n\nBeta evidence.\n",
	options: { writeIndex?: boolean; rawKind?: ManifestEntry["rawKind"] } = {},
): { entry: ManifestEntry; index: SourceEvidenceIndex } {
	const rawRelativePath = `raw/uploads/${id}.md`;
	const rawAbsolutePath = join(root, rawRelativePath);
	writeFileSync(rawAbsolutePath, text, "utf8");
	const rawContentHash = hash(text);
	const rawStat = statSync(rawAbsolutePath);
	const entry = manifestEntry(id, rawRelativePath, {
		rawContentHash,
		rawSize: rawStat.size,
		rawMtimeMs: rawStat.mtimeMs,
		...(options.rawKind === undefined ? {} : { rawKind: options.rawKind }),
	});
	upsertManifest(root, entry);
	const index = buildEvidenceIndex({
		sourceId: id,
		sourceType: "markdown",
		rawContentHash,
		parsed: { text, pageCount: 1, pages: [{ pageNumber: 1, text }] },
	});
	if (options.writeIndex !== false) writeEvidenceIndexAtomic(root, index);
	return { entry, index };
}

function locatorFromBlock(block: EvidenceBlock): EvidenceLocator {
	if (block.kind === "pdf") return { kind: "pdf-page", page: block.page!, block_id: block.id };
	if (block.kind === "markdown") {
		return {
			kind: "markdown-block",
			block_id: block.id,
			...(block.heading === undefined ? {} : { heading: block.heading }),
			paragraph: block.paragraph!,
		};
	}
	return {
		kind: "docx-paragraph",
		block_id: block.id,
		...(block.heading === undefined ? {} : { heading: block.heading }),
		paragraph: block.paragraph!,
	};
}

function blockContaining(index: SourceEvidenceIndex, text: string): EvidenceBlock {
	const block = index.blocks.find((candidate) => candidate.text.includes(text));
	if (!block) throw new Error(`missing block containing ${text}`);
	return block;
}

function reference(
	sourceId: string,
	block: EvidenceBlock,
	body: string,
	rawContentHash: string,
	overrides: Partial<EvidenceRef> = {},
): EvidenceRef {
	return {
		source_id: sourceId,
		quote: block.text,
		source_revision: `sha256:${rawContentHash}`,
		page_revision: bodyRevision(body),
		index_version: 1,
		selected_by: "model",
		locator: locatorFromBlock(block),
		...overrides,
	};
}

function pageContent(
	sourceIds: string[],
	sources: string[],
	evidenceRefs: unknown,
	body: string,
): string {
	const frontmatter: WikiPageFrontmatter = {
		title: "Page",
		created: "2026-08-16",
		type: "concept",
		tags: ["learning-content"],
		sources,
		source_ids: sourceIds,
		updated: "2026-08-16",
		status: "draft",
		confidence: "medium",
		...(evidenceRefs === undefined ? {} : { evidence_refs: evidenceRefs as unknown[] }),
	};
	return `${serializeFrontmatter(frontmatter)}\n${body}`;
}

afterEach(() => {
	for (const root of tempDirs.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("resolveWikiPageDetailFromContent", () => {
	it("returns exact page revisions and a verified ready source", () => {
		const root = makeRoot();
		const { entry, index } = createSource(root, "l2src_ready", undefined, { rawKind: "uploaded-original" });
		const body = "# Final page\n\nClaim.\n";
		const block = blockContaining(index, "Alpha evidence");
		const content = pageContent(
			[entry.id],
			[entry.rawPath],
			[reference(entry.id, block, body, entry.rawContentHash!)],
			body,
		);

		const detail = resolveWikiPageDetailFromContent(root, "wiki\\concepts\\page.md", content);

		expect(detail).toEqual(expect.objectContaining({
			path: "wiki/concepts/page.md",
			content,
			pageRevision: bodyRevision(body),
			fileRevision: fileRevision(Buffer.from(content, "utf8")),
		}));
		expect(detail.provenance.legacyPaths).toEqual([entry.rawPath]);
		expect(detail.provenance.referenceIssues).toEqual([]);
		expect(detail.provenance.sourceGroups).toEqual([expect.objectContaining({
			availability: "ready",
			sourceId: entry.id,
			rawRelativePath: entry.rawPath,
			rawKind: "uploaded-original",
			sourceRevision: `sha256:${entry.rawContentHash}`,
			references: [expect.objectContaining({
				quote: block.text,
				locator: locatorFromBlock(block),
				selectedBy: "model",
				positionStatus: "verified",
				reasonCodes: [],
			})],
		})]);
	});

	it("keeps sources independent, deduplicates IDs by first occurrence, and preserves ref order", () => {
		const root = makeRoot();
		const a = createSource(root, "l2src_a");
		const body = "Body\n";
		const alpha = blockContaining(a.index, "Alpha evidence");
		const beta = blockContaining(a.index, "Beta evidence");
		const missingEntry = manifestEntry("l2src_missing_file", "raw/uploads/missing.md", {
			rawContentHash: "b".repeat(64),
			rawKind: "archived-text",
		});
		upsertManifest(root, missingEntry);
		const placeholder = { id: "md:b0001:placeholder", kind: "markdown", text: "placeholder", paragraph: 1 } as EvidenceBlock;
		const refs = [
			reference(a.entry.id, alpha, body, a.entry.rawContentHash!, { quote: "Alpha evidence" }),
			reference(missingEntry.id, placeholder, body, missingEntry.rawContentHash!),
			reference(a.entry.id, beta, body, a.entry.rawContentHash!, { quote: "Beta evidence" }),
			reference("l2src_missing_source", placeholder, body, "c".repeat(64)),
		];
		const content = pageContent(
			[a.entry.id, a.entry.id, "l2src_missing_source", missingEntry.id, a.entry.id],
			["legacy/one", "legacy/two", "legacy/three"],
			refs,
			body,
		);

		const groups = resolveWikiPageDetailFromContent(root, "wiki/concepts/page.md", content).provenance.sourceGroups;

		expect(groups.map((group) => group.sourceId)).toEqual([a.entry.id, "l2src_missing_source", missingEntry.id]);
		expect(groups[0].references.map((item) => item.quote)).toEqual(["Alpha evidence", "Beta evidence"]);
		expect(groups[1]).toEqual(expect.objectContaining({
			availability: "missing-source",
			references: [expect.objectContaining({ reasonCodes: ["missing-source"] })],
		}));
		expect(groups[2]).toEqual(expect.objectContaining({
			availability: "missing-file",
			rawRelativePath: "raw/uploads/missing.md",
			lastKnownSourceRevision: `sha256:${missingEntry.rawContentHash}`,
			rawKind: "archived-text",
			references: [expect.objectContaining({ reasonCodes: ["missing-file"] })],
		}));
		expect(resolveWikiPageDetailFromContent(root, "wiki/concepts/page.md", content).provenance.legacyPaths).toEqual([
			"legacy/one",
			"legacy/two",
			"legacy/three",
		]);
	});

	it("keeps path-only and ID-only pages independent", () => {
		const root = makeRoot();
		const pathOnly = pageContent([], ["raw/legacy/one.txt", "raw/legacy/two.txt"], undefined, "Body");
		const idOnly = pageContent(["l2src_unknown"], [], undefined, "Body");

		expect(resolveWikiPageDetailFromContent(root, "wiki/concepts/path.md", pathOnly).provenance).toEqual({
			sourceGroups: [],
			legacyPaths: ["raw/legacy/one.txt", "raw/legacy/two.txt"],
			referenceIssues: [],
		});
		expect(resolveWikiPageDetailFromContent(root, "wiki/concepts/id.md", idOnly).provenance).toEqual({
			sourceGroups: [{ availability: "missing-source", sourceId: "l2src_unknown", references: [] }],
			legacyPaths: [],
			referenceIssues: [],
		});
	});

	it("turns every malformed reference into a safe issue at its raw ordinal", () => {
		const root = makeRoot();
		const body = "Body";
		const goodLocator = { kind: "markdown-block", block_id: "md:b0001:test", paragraph: 1 };
		const base = {
			source_id: "l2src_declared",
			quote: "quote",
			source_revision: `sha256:${"a".repeat(64)}`,
			page_revision: bodyRevision(body),
			index_version: 1,
			selected_by: "model",
			locator: goodLocator,
		};
		const malformed = [
			"not an object",
			{ ...base, source_id: "" },
			{ ...base, source_id: "l2src_other" },
			{ ...base, quote: "   " },
			{ ...base, source_revision: "bad" },
			{ ...base, selected_by: "system" },
			{ ...base, locator: { kind: "future", private: "must not leak" } },
		];
		const content = pageContent(["l2src_declared"], [], malformed, body);

		const issues = resolveWikiPageDetailFromContent(root, "wiki/concepts/page.md", content).provenance.referenceIssues;

		expect(issues).toEqual([
			{ ordinal: 0, code: "not-object" },
			{ ordinal: 1, code: "invalid-source-id" },
			{ ordinal: 2, sourceId: "l2src_other", code: "source-id-not-declared" },
			{ ordinal: 3, sourceId: "l2src_declared", code: "invalid-quote" },
			{ ordinal: 4, sourceId: "l2src_declared", code: "invalid-revision" },
			{ ordinal: 5, sourceId: "l2src_declared", code: "invalid-selected-by" },
			{ ordinal: 6, sourceId: "l2src_declared", code: "invalid-locator" },
		]);
		for (const issue of issues) {
			expect(Object.keys(issue).every((key) => ["ordinal", "sourceId", "code"].includes(key))).toBe(true);
		}
	});

	it("reports a non-array raw YAML evidence_refs value instead of accepting or dropping it", () => {
		const root = makeRoot();
		const content = `---
title: Non-array
created: 2026-08-16
type: concept
tags: []
sources: []
source_ids: [l2src_declared]
updated: 2026-08-16
status: draft
confidence: medium
evidence_refs:
  source_id: l2src_declared
  quote: looks-valid-but-is-not-an-array
  source_revision: sha256:${"a".repeat(64)}
  page_revision: sha256:${"b".repeat(64)}
  index_version: 1
  selected_by: model
  locator: {kind: markdown-block, block_id: md:b0001:test, paragraph: 1}
---
Body`;

		expect(resolveWikiPageDetailFromContent(root, "wiki/concepts/page.md", content).provenance.referenceIssues).toEqual([
			{ ordinal: 0, code: "not-object" },
		]);
	});

	it("rejects duplicate inline markers across the page evidence_refs array", () => {
		const root = makeRoot();
		const source = createSource(root, "l2src_duplicate_marker");
		const body = "Body [1]";
		const alpha = blockContaining(source.index, "Alpha evidence");
		const beta = blockContaining(source.index, "Beta evidence");
		const content = pageContent(
			[source.entry.id],
			[],
			[
				reference(source.entry.id, alpha, body, source.entry.rawContentHash!, { quote: "Alpha evidence", marker: 1 }),
				reference(source.entry.id, beta, body, source.entry.rawContentHash!, { quote: "Beta evidence", marker: 1 }),
			],
			body,
		);

		const detail = resolveWikiPageDetailFromContent(root, "wiki/concepts/page.md", content);

		expect(detail.provenance.sourceGroups[0].references).toHaveLength(1);
		expect(detail.provenance.sourceGroups[0].references[0]).toEqual(expect.objectContaining({ marker: 1 }));
		expect(detail.provenance.referenceIssues).toEqual([
			{ ordinal: 1, sourceId: source.entry.id, code: "invalid-marker" },
		]);
	});

	it("collects source, index, and page reasons in the required order", () => {
		const root = makeRoot();
		const source = createSource(root, "l2src_ordered", undefined, { writeIndex: false });
		const body = "Current body";
		const block = blockContaining(source.index, "Alpha evidence");
		const ref = reference(source.entry.id, block, body, source.entry.rawContentHash!, {
			source_revision: `sha256:${"f".repeat(64)}`,
			page_revision: `sha256:${"e".repeat(64)}`,
		});
		const content = pageContent([source.entry.id], [], [ref], body);

		const resolved = resolveWikiPageDetailFromContent(root, "wiki/concepts/page.md", content)
			.provenance.sourceGroups[0].references[0];

		expect(resolved.reasonCodes).toEqual(["stale-source", "missing-index", "stale-page"]);
		expect(resolved.positionStatus).toBe("stale-source");
	});

	it.each([
		["corrupt-index", "corrupt"],
		["index-version-mismatch", "version"],
		["stale-source", "stale"],
	] as const)("reports %s while keeping the trustworthy raw source ready", (expectedReason, mode) => {
		const root = makeRoot();
		const source = createSource(root, `l2src_${mode}`);
		if (mode === "corrupt") {
			writeFileSync(evidencePath(root, source.entry.id), "{not-json", "utf8");
		} else if (mode === "version") {
			writeFileSync(evidencePath(root, source.entry.id), JSON.stringify({ ...source.index, version: 2 }), "utf8");
		} else {
			writeEvidenceIndexAtomic(root, { ...source.index, raw_content_hash: "d".repeat(64) });
		}
		const body = "Body";
		const block = blockContaining(source.index, "Alpha evidence");
		const content = pageContent(
			[source.entry.id],
			[],
			[reference(source.entry.id, block, body, source.entry.rawContentHash!)],
			body,
		);

		const group = resolveWikiPageDetailFromContent(root, "wiki/concepts/page.md", content).provenance.sourceGroups[0];

		expect(group.availability).toBe("ready");
		expect(group.references[0]).toEqual(expect.objectContaining({
			positionStatus: expectedReason,
			reasonCodes: [expectedReason],
		}));
	});

	it("keeps a trustworthy raw ready when the evidence directory is unsafe", () => {
		const root = makeRoot();
		const outside = makeRoot();
		const source = createSource(root, "l2src_unsafe_evidence_directory");
		const body = "Body";
		const block = blockContaining(source.index, "Alpha evidence");
		const content = pageContent(
			[source.entry.id],
			[],
			[reference(source.entry.id, block, body, source.entry.rawContentHash!)],
			body,
		);
		const byId = join(root, "extracted", "evidence", "by-id");
		rmSync(byId, { recursive: true });
		directoryLink(join(outside, "extracted", "evidence", "by-id"), byId);

		const group = resolveWikiPageDetailFromContent(root, "wiki/concepts/page.md", content)
			.provenance.sourceGroups[0];

		expect(group).toEqual(expect.objectContaining({
			availability: "ready",
			rawRelativePath: source.entry.rawPath,
			sourceRevision: `sha256:${source.entry.rawContentHash}`,
		}));
		expect(group.references[0]).toEqual(expect.objectContaining({
			positionStatus: "corrupt-index",
			reasonCodes: ["corrupt-index"],
		}));
	});

	it("distinguishes locator mismatch, quote mismatch, and unique drift", () => {
		const root = makeRoot();
		const source = createSource(root, "l2src_drift");
		const body = "Body";
		const alpha = blockContaining(source.index, "Alpha evidence");
		const beta = blockContaining(source.index, "Beta evidence");
		const wrongLocator = { ...locatorFromBlock(alpha), paragraph: 999 } as EvidenceLocator;
		const refs = [
			reference(source.entry.id, alpha, body, source.entry.rawContentHash!, { locator: wrongLocator, quote: "Alpha evidence" }),
			reference(source.entry.id, alpha, body, source.entry.rawContentHash!, { quote: "not present" }),
			reference(source.entry.id, alpha, body, source.entry.rawContentHash!, { quote: "Beta evidence" }),
		];
		const content = pageContent([source.entry.id], [], refs, body);

		const resolved = resolveWikiPageDetailFromContent(root, "wiki/concepts/page.md", content)
			.provenance.sourceGroups[0].references;

		expect(resolved[0]).toEqual(expect.objectContaining({
			locator: locatorFromBlock(alpha),
			reasonCodes: ["locator-invalid"],
		}));
		expect(resolved[1]).toEqual(expect.objectContaining({ reasonCodes: ["quote-mismatch"] }));
		expect(resolved[2]).toEqual(expect.objectContaining({
			locator: locatorFromBlock(beta),
			positionStatus: "quote-mismatch",
			reasonCodes: ["quote-mismatch", "drifted"],
		}));
	});

	it("does not claim drift when a quote has zero or multiple matches", () => {
		const root = makeRoot();
		const source = createSource(
			root,
			"l2src_ambiguous",
			"# Topic\n\nAnchor.\n\nShared quote.\n\nShared quote.\n\nTwice: Shared quote, Shared quote.\n",
		);
		const body = "Body";
		const anchor = blockContaining(source.index, "Anchor");
		const repeated = blockContaining(source.index, "Twice");
		const refs = [
			reference(source.entry.id, anchor, body, source.entry.rawContentHash!, { quote: "absent" }),
			reference(source.entry.id, anchor, body, source.entry.rawContentHash!, { quote: "Shared quote" }),
			reference(source.entry.id, repeated, body, source.entry.rawContentHash!, { quote: "Shared quote" }),
		];
		const content = pageContent([source.entry.id], [], refs, body);

		const resolved = resolveWikiPageDetailFromContent(root, "wiki/concepts/page.md", content)
			.provenance.sourceGroups[0].references;

		expect(resolved.map((item) => item.reasonCodes)).toEqual([
			["quote-mismatch"],
			["quote-mismatch"],
			["quote-mismatch"],
		]);
	});

	it("downgrades an unsafe source without echoing its malicious path", () => {
		const root = makeRoot();
		const malicious = join(root, "raw", "uploads", "absolute.md");
		const unsafe = manifestEntry("l2src_unsafe", malicious, { rawContentHash: "a".repeat(64) });
		upsertManifest(root, unsafe);
		const body = "Body";
		const placeholder = { id: "md:b0001:test", kind: "markdown", text: "quote", paragraph: 1 } as EvidenceBlock;
		const content = pageContent(
			[unsafe.id],
			[],
			[reference(unsafe.id, placeholder, body, unsafe.rawContentHash!)],
			body,
		);

		const group = resolveWikiPageDetailFromContent(root, "wiki/concepts/page.md", content).provenance.sourceGroups[0];

		expect(group).toEqual(expect.objectContaining({ availability: "missing-file", sourceId: unsafe.id }));
		expect(group).not.toHaveProperty("rawRelativePath");
		expect(JSON.stringify(group)).not.toContain(malicious);
		expect(group.references[0].reasonCodes).toEqual(["missing-file"]);
	});

	it("infers legacy raw kinds conservatively", () => {
		const root = makeRoot();
		const markdown = createSource(root, "l2src_legacy_markdown");
		const textPath = "raw/uploads/legacy-text.txt";
		writeFileSync(join(root, textPath), "text", "utf8");
		upsertManifest(root, manifestEntry("l2src_legacy_text", textPath, { sourceType: "text" }));
		const content = pageContent([markdown.entry.id, "l2src_legacy_text"], [], undefined, "Body");

		const groups = resolveWikiPageDetailFromContent(root, "wiki/concepts/page.md", content).provenance.sourceGroups;

		expect(groups[0]).not.toHaveProperty("rawKind");
		expect(groups[1]).toEqual(expect.objectContaining({ rawKind: "archived-text" }));
	});
});

describe("resolveWikiPageDetail", () => {
	it("is read-only for the page, manifest, raw source, and evidence index", () => {
		const root = makeRoot();
		const source = createSource(root, "l2src_read_only");
		const body = "Body";
		const block = blockContaining(source.index, "Alpha evidence");
		const content = pageContent(
			[source.entry.id],
			[source.entry.rawPath],
			[reference(source.entry.id, block, body, source.entry.rawContentHash!)],
			body,
		);
		const pagePath = join(root, "wiki", "concepts", "page.md");
		writeFileSync(pagePath, content, "utf8");
		const tracked = [
			pagePath,
			join(root, "manifest.jsonl"),
			join(root, source.entry.rawPath),
			evidencePath(root, source.entry.id),
		];
		const before = tracked.map((path) => readFileSync(path));
		const evidenceFiles = readdirSync(join(root, "extracted", "evidence", "by-id"));

		const detail = resolveWikiPageDetail(root, "wiki/concepts/page.md");

		expect(detail.content).toBe(content);
		tracked.forEach((path, ordinal) => expect(readFileSync(path)).toEqual(before[ordinal]));
		expect(readdirSync(join(root, "extracted", "evidence", "by-id"))).toEqual(evidenceFiles);
	});

	it("uses prospective content bytes without reading or changing the page on disk", () => {
		const root = makeRoot();
		const pagePath = join(root, "wiki", "concepts", "page.md");
		writeFileSync(pagePath, "old page", "utf8");
		const prospective = Buffer.from(pageContent([], [], undefined, "Prospective\r\nbody\r\n"), "utf8");

		const detail = resolveWikiPageDetailFromContent(root, "wiki/concepts/page.md", prospective);

		expect(detail.content).toBe(prospective.toString("utf8"));
		expect(detail.fileRevision).toBe(fileRevision(prospective));
		expect(detail.pageRevision).toBe(bodyRevision("Prospective\r\nbody\r\n"));
		expect(readFileSync(pagePath, "utf8")).toBe("old page");
	});
});
