import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stringify as stringifyYaml } from "yaml";

const fsTrace = vi.hoisted(() => ({
	descriptorPaths: new Map<number, string>(),
	afterReadTarget: undefined as string | undefined,
	afterRead: undefined as (() => void) | undefined,
}));

const revisionTrace = vi.hoisted(() => ({
	override: undefined as { status: "changed-during-read" | "unsafe-path" } | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		openSync(path: string, flags: string | number, mode?: number) {
			const descriptor = actual.openSync(path, flags, mode);
			fsTrace.descriptorPaths.set(descriptor, path);
			return descriptor;
		},
		readFileSync(...args: unknown[]) {
			const result = (actual.readFileSync as (...inner: unknown[]) => unknown)(...args);
			const input = args[0];
			const path = typeof input === "number" ? fsTrace.descriptorPaths.get(input) : undefined;
			const target = fsTrace.afterReadTarget;
			const matchesTarget = path !== undefined && target !== undefined && (
				process.platform === "win32" ? path.toLowerCase() === target.toLowerCase() : path === target
			);
			if (fsTrace.afterRead && matchesTarget) {
				const afterRead = fsTrace.afterRead;
				fsTrace.afterRead = undefined;
				afterRead();
			}
			return result;
		},
		closeSync(descriptor: number) {
			try {
				actual.closeSync(descriptor);
			} finally {
				fsTrace.descriptorPaths.delete(descriptor);
			}
		},
	};
});

vi.mock("./source-revision.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./source-revision.js")>();
	return {
		...actual,
		readSourceRevision(...args: Parameters<typeof actual.readSourceRevision>) {
			return revisionTrace.override ?? actual.readSourceRevision(...args);
		},
	};
});

import { writeText } from "../../storage/file-store.js";
import { buildEvidenceIndex, writeEvidenceIndexAtomic, type SourceEvidenceIndex } from "./evidence-index.js";
import { formatL2LintReport, runL2Lint } from "./l2-lint.js";
import { readManifest, upsertManifest } from "./manifest-store.js";
import { bodyRevision, parseFrontmatter, serializeFrontmatter } from "./wiki-maintainer.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "inno-l2-lint-"));
	tempDirs.push(dir);
	return dir;
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

function page(
	sourceId = "l2src_clean",
	body = "# Clean\n\nNo links.",
	evidenceRefs?: unknown[],
	sourceIds = [sourceId],
): string {
	return `${serializeFrontmatter({
		title: "Clean",
		created: "2026-07-30",
		type: "concept",
		tags: ["concept"],
		sources: ["raw/uploads/source.md"],
		source_ids: sourceIds,
		updated: "2026-07-30",
		status: "draft",
		confidence: "medium",
		...(evidenceRefs === undefined ? {} : { evidence_refs: evidenceRefs }),
	})}\n${body}`;
}

function pageWithRawEvidenceRefs(sourceId: string, body: string, evidenceRefs: unknown): string {
	return `---\n${stringifyYaml({
		title: "Clean",
		created: "2026-07-30",
		type: "concept",
		tags: ["concept"],
		sources: ["raw/uploads/source.md"],
		source_ids: [sourceId],
		updated: "2026-07-30",
		status: "draft",
		confidence: "medium",
		evidence_refs: evidenceRefs,
	})}---\n${body}`;
}

function writeCleanFixture(root: string): { index: SourceEvidenceIndex; rawContentHash: string } {
	const raw = "# Source\n\nVerified evidence quote.\n";
	const rawContentHash = hash(raw);
	writeText(join(root, "raw/uploads/source.md"), raw);
	writeText(join(root, "extracted/source.md"), "extracted");
	writeText(join(root, "wiki/concepts/clean.md"), page());
	writeText(join(root, "wiki/index.md"), "- [[Clean]] — `wiki/concepts/clean.md`\n");
	const index = buildEvidenceIndex({
		sourceId: "l2src_clean",
		sourceType: "markdown",
		rawContentHash,
		parsed: { text: raw, pageCount: 1, pages: [{ pageNumber: 1, text: raw }] },
	});
	writeEvidenceIndexAtomic(root, index);
	upsertManifest(root, {
		id: "l2src_clean",
		title: "Clean source",
		sourceType: "markdown",
		rawPath: "raw/uploads/source.md",
		extractedPath: "extracted/source.md",
		wikiPages: ["wiki/concepts/clean.md"],
		tags: [],
		contentHash: "cleanhash",
		rawContentHash,
		rawSize: Buffer.byteLength(raw),
		rawMtimeMs: statSync(join(root, "raw/uploads/source.md")).mtimeMs,
		rawKind: "uploaded-original",
		status: "indexed",
		source: { origin: "user_upload" },
		createdAt: "2026-07-30T00:00:00.000Z",
		updatedAt: "2026-07-30T00:00:00.000Z",
	});
	return { index, rawContentHash };
}

function treeDigest(root: string): string {
	const records: string[] = [];
	const visit = (directory: string, relativeDirectory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
			const absolutePath = join(directory, entry.name);
			if (entry.isDirectory()) {
				records.push(`directory:${relativePath}`);
				visit(absolutePath, relativePath);
			} else {
				records.push(`file:${relativePath}:${hash(readFileSync(absolutePath))}`);
			}
		}
	};
	visit(root, "");
	return hash(records.join("\n"));
}

afterEach(() => {
	fsTrace.descriptorPaths.clear();
	fsTrace.afterReadTarget = undefined;
	fsTrace.afterRead = undefined;
	revisionTrace.override = undefined;
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("L2 structural lint", () => {
	it("returns a clean report for a traceable indexed page", () => {
		const root = makeTempDir();
		writeCleanFixture(root);
		expect(runL2Lint(root)).toMatchObject({ pagesChecked: 1, sourcesChecked: 1, errors: 0, warnings: 0, findings: [] });
	});

	it("reports duplicate inline markers instead of treating both refs as valid", () => {
		const root = makeTempDir();
		const fixture = writeCleanFixture(root);
		const block = fixture.index.blocks.find((candidate) => candidate.text === "Verified evidence quote.")!;
		const body = "# Clean\n\nClaim [1].";
		const ref = {
			source_id: "l2src_clean",
			quote: "Verified evidence quote.",
			source_revision: `sha256:${fixture.rawContentHash}`,
			page_revision: bodyRevision(body),
			index_version: 1,
			selected_by: "model",
			locator: {
				kind: "markdown-block",
				block_id: block.id,
				heading: block.heading,
				paragraph: block.paragraph,
			},
			marker: 1,
		};
		writeText(join(root, "wiki/concepts/clean.md"), page("l2src_clean", body, [ref, { ...ref }]));

		const findings = runL2Lint(root).findings;

		expect(findings.filter((item) => item.code === "invalid_evidence_ref")).toHaveLength(1);
	});

	it("reports a raw that changes during revision validation", () => {
		const root = makeTempDir();
		writeCleanFixture(root);
		revisionTrace.override = { status: "changed-during-read" };

		const report = runL2Lint(root);

		expect(report.findings).toContainEqual(expect.objectContaining({ code: "missing_source_file" }));
		expect(report.findings).not.toContainEqual(expect.objectContaining({ code: "corrupt_evidence_index" }));
	});

	it("reports malformed pages, dangling links, provenance, source, manifest, and index drift", () => {
		const root = makeTempDir();
		writeCleanFixture(root);
		writeText(join(root, "wiki/concepts/broken.md"), "# Missing metadata\n\nSee [[Unknown Topic]].");
		writeText(join(root, "wiki/entities/invalid.md"), "---\ntitle: [unterminated\n---\ninvalid");
		writeText(join(root, "wiki/index.md"), "- [[Ghost]] — `wiki/concepts/ghost.md`\n");
		upsertManifest(root, {
			id: "l2src_incomplete",
			title: "Broken source",
			sourceType: "markdown",
			rawPath: "raw/uploads/missing.md",
			extractedPath: "extracted/missing.md",
			wikiPages: ["wiki/concepts/missing.md"],
			tags: [],
			contentHash: "missinghash",
			status: "error",
			source: { origin: "user_upload" },
			createdAt: "2026-07-30T00:00:00.000Z",
			updatedAt: "2026-07-30T00:00:00.000Z",
		});

		const codes = runL2Lint(root).findings.map((item) => item.code);
		expect(codes).toEqual(expect.arrayContaining([
			"missing_frontmatter",
			"invalid_frontmatter",
			"dangling_link",
			"missing_source_file",
			"manifest_page_missing",
			"index_missing_page",
			"index_stale_page",
			"incomplete_archive",
		]));
	});

	it("reports unknown source ids without changing the page", () => {
		const root = makeTempDir();
		writeCleanFixture(root);
		const path = join(root, "wiki/concepts/clean.md");
		writeText(path, page("l2src_unknown"));
		const before = readFileSync(path, "utf8");

		expect(runL2Lint(root).findings).toContainEqual(expect.objectContaining({ code: "unknown_source_id" }));
		expect(readFileSync(path, "utf8")).toBe(before);
	});

	it("reports every precise evidence-index lifecycle state without mutating the L2 tree", () => {
		const cases: Array<{
			code: string;
			mutate: (root: string, fixture: ReturnType<typeof writeCleanFixture>) => void;
		}> = [
			{
				code: "missing_evidence_index",
				mutate: (root) => rmSync(evidencePath(root, "l2src_clean")),
			},
			{
				code: "corrupt_evidence_index",
				mutate: (root) => writeText(evidencePath(root, "l2src_clean"), "{not-json"),
			},
			{
				code: "evidence_index_version_mismatch",
				mutate: (root, fixture) => writeText(
					evidencePath(root, "l2src_clean"),
					`${JSON.stringify({ ...fixture.index, version: 2 })}\n`,
				),
			},
			{
				code: "stale_evidence_index",
				mutate: (root, fixture) => writeEvidenceIndexAtomic(root, {
					...fixture.index,
					raw_content_hash: "b".repeat(64),
				}),
			},
			{
				code: "orphan_evidence_index",
				mutate: (root) => writeText(evidencePath(root, "l2src_orphan"), "{}\n"),
			},
		];

		for (const testCase of cases) {
			const root = makeTempDir();
			const fixture = writeCleanFixture(root);
			testCase.mutate(root, fixture);
			const before = treeDigest(root);

			expect(runL2Lint(root).findings).toContainEqual(expect.objectContaining({ code: testCase.code }));
			expect(treeDigest(root)).toBe(before);
		}
	});

	it("does not require precise indexes for text, conversation, or image sources", () => {
		const root = makeTempDir();
		for (const sourceType of ["text", "conversation", "image"] as const) {
			const rawPath = `raw/${sourceType}.bin`;
			const extractedPath = `extracted/${sourceType}.md`;
			const raw = `${sourceType} raw`;
			writeText(join(root, rawPath), raw);
			writeText(join(root, extractedPath), `${sourceType} extracted`);
			upsertManifest(root, {
				id: `l2src_${sourceType}`,
				title: `${sourceType} source`,
				sourceType,
				rawPath,
				extractedPath,
				wikiPages: [],
				tags: [],
				contentHash: `${sourceType}-hash`,
				rawContentHash: hash(raw),
				rawSize: Buffer.byteLength(raw),
				rawMtimeMs: statSync(join(root, rawPath)).mtimeMs,
				rawKind: sourceType === "image" ? "uploaded-original" : "archived-text",
				status: "indexed",
				source: { origin: "user_upload" },
				createdAt: "2026-08-15T00:00:00.000Z",
				updatedAt: "2026-08-15T00:00:00.000Z",
			});
		}

		const report = runL2Lint(root);
		expect(report.findings.filter((item) => item.code.includes("evidence_index"))).toEqual([]);
	});

	it("reports dangling, malformed, mismatched, and stale evidence refs without exposing source text", () => {
		const root = makeTempDir();
		const fixture = writeCleanFixture(root);
		const block = fixture.index.blocks.find((candidate) => candidate.text === "Verified evidence quote.");
		if (!block || block.kind !== "markdown") throw new Error("expected Markdown evidence block");
		const body = "# Clean\n\nNo links.";
		const parsedBody = parseFrontmatter(page("l2src_clean", body)).body;
		const locator = {
			kind: "markdown-block" as const,
			block_id: block.id,
			heading: block.heading,
			paragraph: block.paragraph!,
		};
		const valid = {
			source_id: "l2src_clean",
			quote: "Verified evidence quote.",
			source_revision: `sha256:${fixture.rawContentHash}`,
			page_revision: bodyRevision(parsedBody),
			index_version: 1,
			selected_by: "user",
			locator,
		};
		const refs: unknown[] = [
			{ ...valid, quote: "" },
			{ ...valid, source_revision: "not-a-revision" },
			{ ...valid, index_version: 2 },
			{ ...valid, locator: { kind: "markdown-block", block_id: block.id, paragraph: 0 } },
			{ ...valid, quote: "Absent private quote" },
			{ ...valid, locator: { ...locator, paragraph: locator.paragraph + 10 } },
			{ ...valid, source_revision: `sha256:${"c".repeat(64)}` },
			{ ...valid, page_revision: `sha256:${"d".repeat(64)}` },
		];
		writeText(
			join(root, "wiki/concepts/clean.md"),
			page("l2src_clean", body, refs, ["l2src_clean", "l2src_unknown"]),
		);
		const before = treeDigest(root);

		const report = runL2Lint(root);
		const codes = report.findings.map((item) => item.code);
		expect(codes).toEqual(expect.arrayContaining([
			"unknown_source_id",
			"invalid_evidence_quote",
			"invalid_evidence_revision",
			"invalid_evidence_locator",
			"evidence_index_version_mismatch",
			"evidence_quote_mismatch",
			"evidence_locator_mismatch",
			"evidence_source_revision_mismatch",
			"evidence_page_revision_mismatch",
		]));
		expect(JSON.stringify(report)).not.toContain(root);
		expect(JSON.stringify(report)).not.toContain("Absent private quote");
		expect(JSON.stringify(report)).not.toContain("Verified evidence quote.");
		expect(treeDigest(root)).toBe(before);
	});

	it("redacts malformed YAML content and untrusted absolute source paths", () => {
		const root = makeTempDir();
		const fixture = writeCleanFixture(root);
		const secret = "TOP-SECRET-LINT-VALUE";
		const absoluteSecretPath = join(root, `${secret}.md`);
		const unknownSecretSourceId = join(root, `${secret}-unknown.md`);
		writeText(
			join(root, "wiki/entities/malformed.md"),
			`---\ntitle: [${secret}\n---\n${secret}`,
		);
		writeText(join(root, "wiki/concepts/clean.md"), `---\n${stringifyYaml({
			title: "Clean",
			created: "2026-07-30",
			type: "concept",
			tags: ["concept"],
			sources: [absoluteSecretPath],
			source_ids: ["l2src_clean", unknownSecretSourceId],
			updated: "2026-07-30",
			status: "draft",
			confidence: "medium",
		})}---\n# Clean\n`);
		upsertManifest(root, {
			id: "l2src_clean",
			title: "Clean source",
			sourceType: "markdown",
			rawPath: absoluteSecretPath,
			extractedPath: absoluteSecretPath,
			wikiPages: [absoluteSecretPath],
			tags: [],
			contentHash: "cleanhash",
			rawContentHash: fixture.rawContentHash,
			rawSize: 1,
			rawMtimeMs: 1,
			rawKind: "uploaded-original",
			status: "indexed",
			source: { origin: "user_upload" },
			createdAt: "2026-07-30T00:00:00.000Z",
			updatedAt: "2026-07-30T00:00:00.000Z",
		});
		upsertManifest(root, {
			id: absoluteSecretPath,
			title: "Legacy source",
			sourceType: "markdown",
			rawPath: absoluteSecretPath,
			wikiPages: [],
			tags: [],
			contentHash: "legacyhash",
			status: "error",
			source: { origin: "user_upload" },
			createdAt: "2026-07-30T00:00:00.000Z",
			updatedAt: "2026-07-30T00:00:00.000Z",
		});
		const before = treeDigest(root);

		const report = runL2Lint(root);
		const serialized = `${JSON.stringify(report)}\n${formatL2LintReport(report)}`;

		expect(report.findings.map((item) => item.code)).toEqual(expect.arrayContaining([
			"invalid_frontmatter",
			"missing_source_file",
			"manifest_page_missing",
		]));
		expect(serialized).not.toContain(secret);
		expect(serialized).not.toContain(absoluteSecretPath);
		expect(serialized).not.toContain(unknownSecretSourceId);
		expect(serialized).not.toContain(root);
		expect(treeDigest(root)).toBe(before);
	});

	it("does not enumerate an evidence index directory reparse point", () => {
		const root = makeTempDir();
		const outside = makeTempDir();
		writeCleanFixture(root);
		const secretFileName = "TOP-SECRET-ORPHAN.json";
		writeText(join(outside, secretFileName), "external evidence bytes");
		const byId = join(root, "extracted", "evidence", "by-id");
		rmSync(byId, { recursive: true });
		directoryLink(outside, byId);
		const outsideBefore = treeDigest(outside);

		const report = runL2Lint(root);
		const serialized = `${JSON.stringify(report)}\n${formatL2LintReport(report)}`;

		expect(report.findings).toContainEqual(expect.objectContaining({ code: "corrupt_evidence_index" }));
		expect(report.findings).not.toContainEqual(expect.objectContaining({ code: "orphan_evidence_index" }));
		expect(serialized).not.toContain(secretFileName);
		expect(serialized).not.toContain("external evidence bytes");
		expect(treeDigest(outside)).toBe(outsideBefore);
	});

	it("rejects a junction used as the L2 root before reading its manifest", () => {
		const actualRoot = makeTempDir();
		const linkParent = makeTempDir();
		writeCleanFixture(actualRoot);
		const secretSourceId = "l2src_EXTERNAL_MANIFEST_SECRET";
		const [entry] = readManifest(actualRoot);
		writeText(join(actualRoot, "manifest.jsonl"), `${JSON.stringify({
			...entry,
			id: secretSourceId,
			status: "error",
		})}\n`);
		const linkedRoot = join(linkParent, "linked-l2");
		directoryLink(actualRoot, linkedRoot);

		const report = runL2Lint(linkedRoot);
		const serialized = `${JSON.stringify(report)}\n${formatL2LintReport(report)}`;

		expect(report).toMatchObject({ pagesChecked: 0, sourcesChecked: 0 });
		expect(report.findings).toContainEqual(expect.objectContaining({
			code: "unsafe_manifest_path",
			path: "manifest.jsonl",
		}));
		expect(serialized).not.toContain(secretSourceId);
	});

	it("does not follow an external manifest symlink", () => {
		const root = makeTempDir();
		const outside = makeTempDir();
		writeCleanFixture(root);
		const secretSourceId = "l2src_EXTERNAL_LINKED_MANIFEST";
		const [entry] = readManifest(root);
		const externalManifest = join(outside, "private-manifest.jsonl");
		writeText(externalManifest, `${JSON.stringify({
			...entry,
			id: secretSourceId,
			status: "error",
		})}\n`);
		const manifestPath = join(root, "manifest.jsonl");
		rmSync(manifestPath);
		try {
			symlinkSync(externalManifest, manifestPath, "file");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EPERM") return;
			throw error;
		}

		const report = runL2Lint(root);
		const serialized = `${JSON.stringify(report)}\n${formatL2LintReport(report)}`;

		expect(report.sourcesChecked).toBe(0);
		expect(report.findings).toContainEqual(expect.objectContaining({
			code: "unsafe_manifest_path",
			path: "manifest.jsonl",
		}));
		expect(serialized).not.toContain(secretSourceId);
	});

	it("reports a manifest removed after its bytes are read as unsafe", () => {
		const root = makeTempDir();
		writeCleanFixture(root);
		const manifestPath = join(root, "manifest.jsonl");
		fsTrace.afterReadTarget = manifestPath;
		fsTrace.afterRead = () => rmSync(manifestPath);

		const report = runL2Lint(root);

		expect(fsTrace.afterRead).toBeUndefined();
		expect(report.sourcesChecked).toBe(0);
		expect(report.findings).toContainEqual(expect.objectContaining({
			code: "unsafe_manifest_path",
			path: "manifest.jsonl",
		}));
	});

	it("does not enumerate a Wiki category junction or expose external page data", () => {
		const root = makeTempDir();
		const outside = makeTempDir();
		writeCleanFixture(root);
		const secretFileName = "private-external-page.md";
		const secretSourceId = "l2src_EXTERNAL_SECRET";
		const secretBody = "Private external Wiki body";
		writeText(join(outside, secretFileName), page(secretSourceId, `# External\n\n${secretBody}`));
		rmSync(join(root, "wiki", "concepts"), { recursive: true });
		directoryLink(outside, join(root, "wiki", "concepts"));
		const outsideBefore = treeDigest(outside);

		const report = runL2Lint(root);
		const serialized = `${JSON.stringify(report)}\n${formatL2LintReport(report)}`;

		expect(report.pagesChecked).toBe(0);
		expect(report.findings).toContainEqual(expect.objectContaining({
			code: "unsafe_wiki_path",
			path: "wiki/concepts",
		}));
		expect(report.findings).not.toContainEqual(expect.objectContaining({ code: "index_stale_page" }));
		expect(serialized).not.toContain(secretFileName);
		expect(serialized).not.toContain(secretSourceId);
		expect(serialized).not.toContain(secretBody);
		expect(treeDigest(outside)).toBe(outsideBefore);
	});

	it("reports a Wiki category replaced by a regular file instead of throwing", () => {
		const root = makeTempDir();
		writeCleanFixture(root);
		const concepts = join(root, "wiki", "concepts");
		rmSync(concepts, { recursive: true });
		writeText(concepts, "not a directory");

		const report = runL2Lint(root);

		expect(report.pagesChecked).toBe(0);
		expect(report.findings).toContainEqual(expect.objectContaining({
			code: "unsafe_wiki_path",
			path: "wiki/concepts",
		}));
		expect(report.findings).not.toContainEqual(expect.objectContaining({ code: "index_stale_page" }));
	});

	it("reports a dangling Wiki index symlink as unsafe", () => {
		const root = makeTempDir();
		const outside = makeTempDir();
		writeCleanFixture(root);
		const indexPath = join(root, "wiki", "index.md");
		rmSync(indexPath);
		try {
			symlinkSync(join(outside, "missing-index.md"), indexPath, "file");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EPERM") return;
			throw error;
		}

		const report = runL2Lint(root);

		expect(report.findings).toContainEqual(expect.objectContaining({
			code: "unsafe_wiki_path",
			path: "wiki/index.md",
		}));
	});

	it("rejects a Wiki parent replaced after index bytes are read", () => {
		const root = makeTempDir();
		const outsideWiki = makeTempDir();
		writeCleanFixture(root);
		const secret = "external private index content";
		writeText(join(outsideWiki, "index.md"), secret);
		const wiki = join(root, "wiki");
		const preservedWiki = join(root, "preserved-wiki");
		fsTrace.afterReadTarget = join(wiki, "index.md");
		fsTrace.afterRead = () => {
			renameSync(wiki, preservedWiki);
			directoryLink(outsideWiki, wiki);
		};

		const report = runL2Lint(root);
		const serialized = `${JSON.stringify(report)}\n${formatL2LintReport(report)}`;

		expect(fsTrace.afterRead).toBeUndefined();
		expect(report.findings).toContainEqual(expect.objectContaining({
			code: "unsafe_wiki_path",
			path: "wiki/index.md",
		}));
		expect(serialized).not.toContain(secret);
	});

	it("reports a Wiki index removed after its bytes are read as unsafe", () => {
		const root = makeTempDir();
		writeCleanFixture(root);
		const indexPath = join(root, "wiki", "index.md");
		fsTrace.afterReadTarget = indexPath;
		fsTrace.afterRead = () => rmSync(indexPath);

		const report = runL2Lint(root);

		expect(fsTrace.afterRead).toBeUndefined();
		expect(report.findings).toContainEqual(expect.objectContaining({
			code: "unsafe_wiki_path",
			path: "wiki/index.md",
		}));
	});

	it("does not echo an invalid nested page path from the Wiki index", () => {
		const root = makeTempDir();
		writeCleanFixture(root);
		const secretPath = "wiki/concepts/nested/PRIVATE-INDEX-PATH.md";
		writeText(join(root, "wiki", "index.md"), `- Invalid: \`${secretPath}\`\n`);

		const report = runL2Lint(root);
		const serialized = `${JSON.stringify(report)}\n${formatL2LintReport(report)}`;

		expect(report.findings).toContainEqual(expect.objectContaining({
			code: "invalid_wiki_index_path",
			path: "wiki/index.md",
		}));
		expect(report.findings).not.toContainEqual(expect.objectContaining({ code: "index_missing_page" }));
		expect(report.findings).not.toContainEqual(expect.objectContaining({ code: "index_stale_page" }));
		expect(serialized).not.toContain(secretPath);
	});

	it("reports an evidence index directory replaced by a regular file instead of throwing", () => {
		const root = makeTempDir();
		writeCleanFixture(root);
		const byId = join(root, "extracted", "evidence", "by-id");
		rmSync(byId, { recursive: true });
		writeText(byId, "not a directory");

		expect(runL2Lint(root).findings).toContainEqual(expect.objectContaining({
			code: "corrupt_evidence_index",
			path: "extracted/evidence/by-id",
		}));
	});

	it("rejects a raw parent reparse point without reading or changing the external tree", () => {
		const root = makeTempDir();
		const outside = makeTempDir();
		writeCleanFixture(root);
		mkdirSync(outside, { recursive: true });
		writeText(join(outside, "source.md"), "# External source\n\nPrivate external text.\n");
		rmSync(join(root, "raw", "uploads"), { recursive: true });
		directoryLink(outside, join(root, "raw", "uploads"));
		const outsideBefore = treeDigest(outside);

		const report = runL2Lint(root);

		expect(report.findings).toContainEqual(expect.objectContaining({ code: "missing_source_file" }));
		expect(report.findings).not.toContainEqual(expect.objectContaining({ code: "corrupt_evidence_index" }));
		expect(JSON.stringify(report)).not.toContain("Private external text");
		expect(treeDigest(outside)).toBe(outsideBefore);
	});

	it.each([
		["invalid quote", (reference: Record<string, unknown>) => ({ ...reference, quote: "" }), "invalid_evidence_quote"],
		["invalid locator", (reference: Record<string, unknown>) => ({
			...reference,
			locator: { ...(reference.locator as Record<string, unknown>), paragraph: 0 },
		}), "invalid_evidence_locator"],
	] as const)("reports a non-array evidence_refs mapping with an %s", (_label, mutate, expectedCode) => {
		const root = makeTempDir();
		const fixture = writeCleanFixture(root);
		const block = fixture.index.blocks.find((candidate) => candidate.text === "Verified evidence quote.")!;
		const body = "# Clean\n\nNo links.";
		const reference: Record<string, unknown> = {
			source_id: "l2src_clean",
			quote: "Verified evidence quote.",
			source_revision: `sha256:${fixture.rawContentHash}`,
			page_revision: bodyRevision(parseFrontmatter(page("l2src_clean", body)).body),
			index_version: 1,
			selected_by: "model",
			locator: {
				kind: "markdown-block",
				block_id: block.id,
				heading: block.heading,
				paragraph: block.paragraph,
			},
		};
		writeText(
			join(root, "wiki/concepts/clean.md"),
			pageWithRawEvidenceRefs("l2src_clean", body, mutate(reference)),
		);

		expect(runL2Lint(root).findings).toContainEqual(expect.objectContaining({ code: expectedCode }));
	});

	it.each([
		["missing", (root: string) => rmSync(evidencePath(root, "l2src_clean")), "missing_evidence_index"],
		["corrupt", (root: string) => writeText(evidencePath(root, "l2src_clean"), "{not-json"), "corrupt_evidence_index"],
	] as const)("reports stale revisions independently from a %s evidence index", (_label, mutateIndex, indexCode) => {
		const root = makeTempDir();
		const fixture = writeCleanFixture(root);
		const block = fixture.index.blocks.find((candidate) => candidate.text === "Verified evidence quote.")!;
		const body = "# Clean\n\nChanged page body.";
		writeText(join(root, "wiki/concepts/clean.md"), page("l2src_clean", body, [{
			source_id: "l2src_clean",
			quote: "Verified evidence quote.",
			source_revision: `sha256:${"c".repeat(64)}`,
			page_revision: `sha256:${"d".repeat(64)}`,
			index_version: 1,
			selected_by: "model",
			locator: {
				kind: "markdown-block",
				block_id: block.id,
				heading: block.heading,
				paragraph: block.paragraph,
			},
		}]));
		mutateIndex(root);

		const codes = runL2Lint(root).findings.map((item) => item.code);
		expect(codes).toEqual(expect.arrayContaining([
			indexCode,
			"evidence_source_revision_mismatch",
			"evidence_page_revision_mismatch",
		]));
	});

	it("reports missing raw and missing evidence index as independent lifecycle failures", () => {
		const root = makeTempDir();
		writeCleanFixture(root);
		rmSync(join(root, "raw", "uploads", "source.md"));
		rmSync(evidencePath(root, "l2src_clean"));

		const codes = runL2Lint(root).findings.map((item) => item.code);
		expect(codes).toEqual(expect.arrayContaining(["missing_source_file", "missing_evidence_index"]));
	});

	it("reports missing raw and index independently for a legacy manifest without a raw hash", () => {
		const root = makeTempDir();
		writeCleanFixture(root);
		upsertManifest(root, { ...readManifest(root)[0], rawContentHash: undefined });
		rmSync(join(root, "raw", "uploads", "source.md"));
		rmSync(evidencePath(root, "l2src_clean"));

		const codes = runL2Lint(root).findings.map((item) => item.code);
		expect(codes).toEqual(expect.arrayContaining(["missing_source_file", "missing_evidence_index"]));
	});

	it("reports a page reference whose precise index is missing", () => {
		const root = makeTempDir();
		const fixture = writeCleanFixture(root);
		const block = fixture.index.blocks.find((candidate) => candidate.text === "Verified evidence quote.")!;
		const body = "# Clean\n\nNo links.";
		const parsedBody = parseFrontmatter(page("l2src_clean", body)).body;
		writeText(join(root, "wiki/concepts/clean.md"), page("l2src_clean", body, [{
			source_id: "l2src_clean",
			quote: "Verified evidence quote.",
			source_revision: `sha256:${fixture.rawContentHash}`,
			page_revision: bodyRevision(parsedBody),
			index_version: 1,
			selected_by: "model",
			locator: {
				kind: "markdown-block",
				block_id: block.id,
				heading: block.heading,
				paragraph: block.paragraph,
			},
		}]));
		rmSync(evidencePath(root, "l2src_clean"));

		expect(runL2Lint(root).findings).toContainEqual(expect.objectContaining({
			code: "missing_evidence_index",
			path: "wiki/concepts/clean.md",
		}));
	});
});
