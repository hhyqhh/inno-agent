import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const loggerWarnMock = vi.hoisted(() => vi.fn());

vi.mock("../../logger.js", () => ({ logger: { warn: loggerWarnMock } }));

import { writeText, readText } from "../../storage/file-store.js";
import { buildEvidenceIndex, writeEvidenceIndexAtomic } from "./evidence-index.js";
import type { EvidenceRef } from "./evidence-types.js";
import type { EvidenceCandidateSelector } from "./evidence-selector.js";
import { attachEvidenceToPages, attachGroundedCitations } from "./evidence-page-writer.js";
import type { ManifestEntry, WikiPageFrontmatter } from "./types.js";
import {
	bodyRevision,
	ensureL2Directories,
	parseFrontmatter,
	serializeFrontmatter,
} from "./wiki-maintainer.js";

const tempDirs: string[] = [];
const RAW_HASH = "a".repeat(64);

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "inno-evidence-pages-"));
	tempDirs.push(dir);
	return dir;
}

function entry(): ManifestEntry {
	return {
		id: "l2src_current",
		title: "Current source",
		sourceType: "markdown",
		rawPath: "raw/uploads/current.md",
		extractedPath: "extracted/current.md",
		wikiPages: ["wiki/concepts/current-page.md"],
		tags: [],
		contentHash: "content-hash",
		rawContentHash: RAW_HASH,
		rawSize: 100,
		rawMtimeMs: 1,
		rawKind: "uploaded-original",
		status: "extracted",
		source: { origin: "user_upload" },
		createdAt: "2026-08-15T00:00:00.000Z",
		updatedAt: "2026-08-15T00:00:00.000Z",
	};
}

function frontmatter(overrides: Partial<WikiPageFrontmatter> = {}): WikiPageFrontmatter {
	return {
		title: "Current page",
		created: "2026-08-15",
		type: "concept",
		tags: ["concept"],
		sources: ["raw/uploads/current.md"],
		source_ids: ["l2src_current"],
		updated: "2026-08-15",
		status: "draft",
		confidence: "medium",
		...overrides,
	};
}

function prepare(root: string, fm = frontmatter(), body = "\n# Current page\n\nThe page discusses balanced forces.\n") {
	ensureL2Directories(root);
	const evidenceIndex = buildEvidenceIndex({
		sourceId: "l2src_current",
		sourceType: "markdown",
		rawContentHash: RAW_HASH,
		parsed: {
			text: "# Source\n\nBalanced forces have equal magnitude and opposite directions.\n",
			pageCount: 1,
			pages: [{ pageNumber: 1, text: "# Source\n\nBalanced forces have equal magnitude and opposite directions.\n" }],
		},
	});
	writeEvidenceIndexAtomic(root, evidenceIndex);
	const pagePath = "wiki/concepts/current-page.md";
	const content = serializeFrontmatter(fm) + body;
	writeText(join(root, pagePath), content);
	return {
		body: parseFrontmatter(content).body,
		evidenceIndex,
		pagePath,
		quoteBlock: evidenceIndex.blocks[1],
	};
}

function selectorReturning(
	factory: (input: Parameters<EvidenceCandidateSelector["select"]>[0]) => ReturnType<EvidenceCandidateSelector["select"]>,
): EvidenceCandidateSelector {
	return { select: vi.fn(factory) };
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("attachEvidenceToPages", () => {
	it("rejects a linked-page quote that is not a grounded canonical identity", async () => {
		const root = makeTempDir();
		const prepared = prepare(root);
		const canonical: EvidenceRef = {
			source_id: "l2src_current",
			quote: "equal magnitude",
			source_revision: `sha256:${RAW_HASH}`,
			page_revision: `sha256:${"b".repeat(64)}`,
			index_version: 1,
			selected_by: "model",
			locator: {
				kind: "markdown-block",
				block_id: prepared.quoteBlock.id,
				paragraph: prepared.quoteBlock.paragraph!,
				...(prepared.quoteBlock.heading === undefined ? {} : { heading: prepared.quoteBlock.heading }),
			},
			marker: 1,
		};
		const selector = selectorReturning(async () => [{
			source_id: "l2src_current",
			block_id: prepared.quoteBlock.id,
			quote: "opposite directions",
		}]);

		const result = await attachEvidenceToPages({
			l2DataDir: root,
			entry: entry(),
			pagePaths: [prepared.pagePath],
			selector,
			canonicalReferences: [canonical],
		});

		expect(result).toEqual({ updated: [], rejected: 1 });
		expect(parseFrontmatter(readText(join(root, prepared.pagePath))).frontmatter?.evidence_refs).toBeUndefined();
		expect(loggerWarnMock).toHaveBeenCalledWith(
			expect.objectContaining({ code: "identity-mismatch", blockId: prepared.quoteBlock.id }),
			"L2 evidence candidate rejected",
		);
	});

	it("publishes a linked-page ref only when it matches a grounded canonical identity", async () => {
		const root = makeTempDir();
		const prepared = prepare(root);
		const canonical: EvidenceRef = {
			source_id: "l2src_current",
			quote: "equal magnitude",
			source_revision: `sha256:${RAW_HASH}`,
			page_revision: `sha256:${"b".repeat(64)}`,
			index_version: 1,
			selected_by: "model",
			locator: {
				kind: "markdown-block",
				block_id: prepared.quoteBlock.id,
				paragraph: prepared.quoteBlock.paragraph!,
				...(prepared.quoteBlock.heading === undefined ? {} : { heading: prepared.quoteBlock.heading }),
			},
			marker: 1,
		};
		const selector = selectorReturning(async () => [{
			source_id: "l2src_current",
			block_id: prepared.quoteBlock.id,
			quote: canonical.quote,
		}]);

		const result = await attachEvidenceToPages({
			l2DataDir: root,
			entry: entry(),
			pagePaths: [prepared.pagePath],
			selector,
			canonicalReferences: [canonical],
		});

		expect(result).toEqual({ updated: [prepared.pagePath], rejected: 0 });
		expect(parseFrontmatter(readText(join(root, prepared.pagePath))).frontmatter?.evidence_refs).toEqual([
			expect.objectContaining({
				quote: canonical.quote,
				locator: canonical.locator,
				page_revision: bodyRevision(prepared.body),
			}),
		]);
	});

	it("uses one batch selection for multiple pages and resolves exact references for each page", async () => {
		const root = makeTempDir();
		const prepared = prepare(root);
		const secondPagePath = "wiki/concepts/second-page.md";
		const secondContent = serializeFrontmatter(frontmatter({ title: "Second page" }))
			+ "\n# Second page\n\nThis page also discusses opposite directions.\n";
		writeText(join(root, secondPagePath), secondContent);
		const secondBody = parseFrontmatter(secondContent).body;
		const select = vi.fn(async () => {
			throw new Error("legacy selector should not be called");
		});
		const selectMany = vi.fn(async (inputs) => inputs.map((input: any) => ({
			candidates: [{
				source_id: input.sourceId,
				block_id: prepared.quoteBlock.id,
				quote: input.pagePath === prepared.pagePath
					? "equal magnitude"
					: "opposite directions",
			}],
			codes: [],
			rejected: 0,
		})));
		const selector = { select, selectMany } as EvidenceCandidateSelector;

		const result = await attachEvidenceToPages({
			l2DataDir: root,
			entry: entry(),
			pagePaths: [prepared.pagePath, secondPagePath],
			selector,
		});

		expect(result).toEqual({ updated: [prepared.pagePath, secondPagePath], rejected: 0 });
		expect(selectMany).toHaveBeenCalledOnce();
		expect(select).not.toHaveBeenCalled();
		const firstRef = parseFrontmatter(readText(join(root, prepared.pagePath))).frontmatter?.evidence_refs?.[0];
		const secondRef = parseFrontmatter(readText(join(root, secondPagePath))).frontmatter?.evidence_refs?.[0];
		expect(firstRef).toEqual(expect.objectContaining({
			source_id: "l2src_current",
			quote: "equal magnitude",
			page_revision: bodyRevision(prepared.body),
			locator: expect.objectContaining({ block_id: prepared.quoteBlock.id }),
		}));
		expect(secondRef).toEqual(expect.objectContaining({
			source_id: "l2src_current",
			quote: "opposite directions",
			page_revision: bodyRevision(secondBody),
			locator: expect.objectContaining({ block_id: prepared.quoteBlock.id }),
		}));
	});

	it("records selector outcome codes without logging provider or model text", async () => {
		loggerWarnMock.mockReset();
		const root = makeTempDir();
		const prepared = prepare(root);
		const selector = {
			select: vi.fn(async () => []),
			selectMany: vi.fn(async () => [{
				candidates: [],
				codes: ["selector-provider-error", "selector-error", "selector-malformed-response", "private model response" as any],
				rejected: 2,
			}]),
		} as EvidenceCandidateSelector;

		await expect(attachEvidenceToPages({
			l2DataDir: root,
			entry: entry(),
			pagePaths: [prepared.pagePath],
			selector,
		})).resolves.toEqual({ updated: [], rejected: 2 });
		expect(loggerWarnMock.mock.calls.map(([fields]) => fields)).toEqual([
			{ sourceId: "l2src_current", pagePath: prepared.pagePath, code: "selector-provider-error" },
			{ sourceId: "l2src_current", pagePath: prepared.pagePath, code: "selector-error" },
			{ sourceId: "l2src_current", pagePath: prepared.pagePath, code: "selector-malformed-response" },
		]);
		expect(JSON.stringify(loggerWarnMock.mock.calls)).not.toContain("private provider text");
		expect(JSON.stringify(loggerWarnMock.mock.calls)).not.toContain("private malformed model text");
		expect(JSON.stringify(loggerWarnMock.mock.calls)).not.toContain("private model response");
	});

	it.each([
		"selector-auth-unavailable",
		"selector-provider-error",
		"selector-malformed-response",
	] as const)("preserves existing model refs when selector returns %s", async (code) => {
		const root = makeTempDir();
		const existingRef = {
			source_id: "l2src_current",
			quote: "equal magnitude and opposite directions",
			source_revision: `sha256:${RAW_HASH}`,
			page_revision: `sha256:${"b".repeat(64)}`,
			index_version: 1,
			selected_by: "model",
			locator: { kind: "markdown-block", block_id: "md:old", paragraph: 1 },
		};
		const prepared = prepare(root, frontmatter({ evidence_refs: [existingRef] }));
		const before = readText(join(root, prepared.pagePath));
		const selector = {
			select: vi.fn(async () => []),
			selectMany: vi.fn(async () => [{ candidates: [], codes: [code], rejected: 1 }]),
		} as EvidenceCandidateSelector;

		await expect(attachEvidenceToPages({
			l2DataDir: root,
			entry: entry(),
			pagePaths: [prepared.pagePath],
			selector,
		})).resolves.toEqual({ updated: [], rejected: 1 });
		expect(readText(join(root, prepared.pagePath))).toBe(before);
		expect(parseFrontmatter(before).frontmatter?.evidence_refs).toEqual([existingRef]);
	});

	it("preserves existing model refs when the selector throws", async () => {
		const root = makeTempDir();
		const existingRef = {
			source_id: "l2src_current",
			quote: "equal magnitude and opposite directions",
			source_revision: `sha256:${RAW_HASH}`,
			page_revision: `sha256:${"b".repeat(64)}`,
			index_version: 1,
			selected_by: "model",
			locator: { kind: "markdown-block", block_id: "md:old", paragraph: 1 },
		};
		const prepared = prepare(root, frontmatter({ evidence_refs: [existingRef] }));
		const before = readText(join(root, prepared.pagePath));
		const selector = {
			select: vi.fn(async () => []),
			selectMany: vi.fn(async () => {
				throw new Error("provider unavailable");
			}),
		} as EvidenceCandidateSelector;

		await expect(attachEvidenceToPages({
			l2DataDir: root,
			entry: entry(),
			pagePaths: [prepared.pagePath],
			selector,
		})).resolves.toEqual({ updated: [], rejected: 1 });
		expect(readText(join(root, prepared.pagePath))).toBe(before);
		expect(parseFrontmatter(before).frontmatter?.evidence_refs).toEqual([existingRef]);
	});

	it("keeps valid candidates when a batch also reports malformed items", async () => {
		const root = makeTempDir();
		const existingRef = {
			source_id: "l2src_current",
			quote: "old model evidence",
			source_revision: `sha256:${RAW_HASH}`,
			page_revision: `sha256:${"b".repeat(64)}`,
			index_version: 1,
			selected_by: "model",
			locator: { kind: "markdown-block", block_id: "md:old", paragraph: 1 },
		};
		const prepared = prepare(root, frontmatter({ evidence_refs: [existingRef] }));
		const selector = {
			select: vi.fn(async () => []),
			selectMany: vi.fn(async () => [{
				candidates: [{
					source_id: "l2src_current",
					block_id: prepared.quoteBlock.id,
					quote: "equal magnitude",
				}],
				codes: ["selector-malformed-response"],
				rejected: 1,
			}]),
		} as EvidenceCandidateSelector;

		await expect(attachEvidenceToPages({
			l2DataDir: root,
			entry: entry(),
			pagePaths: [prepared.pagePath],
			selector,
		})).resolves.toEqual({ updated: [prepared.pagePath], rejected: 1 });
		const refs = parseFrontmatter(readText(join(root, prepared.pagePath))).frontmatter?.evidence_refs;
		expect(refs).toHaveLength(1);
		expect(refs?.[0]).toEqual(expect.objectContaining({
			quote: "equal magnitude",
			selected_by: "model",
		}));
	});

	it("writes validated model evidence against the final unchanged page body", async () => {
		const root = makeTempDir();
		const prepared = prepare(root);
		const selector = selectorReturning(async (input) => [{
			source_id: input.sourceId,
			block_id: prepared.quoteBlock.id,
			quote: "equal magnitude and opposite directions",
		}]);

		const result = await attachEvidenceToPages({
			l2DataDir: root,
			entry: entry(),
			pagePaths: [prepared.pagePath],
			selector,
		});

		expect(result).toEqual({ updated: [prepared.pagePath], rejected: 0 });
		expect(selector.select).toHaveBeenCalledWith({
			pagePath: prepared.pagePath,
			pageBody: prepared.body,
			sourceId: "l2src_current",
			blocks: prepared.evidenceIndex.blocks,
		});
		const parsed = parseFrontmatter(readText(join(root, prepared.pagePath)));
		expect(parsed.body).toBe(prepared.body);
		expect(parsed.frontmatter?.evidence_refs).toEqual([{
			source_id: "l2src_current",
			quote: "equal magnitude and opposite directions",
			source_revision: `sha256:${RAW_HASH}`,
			page_revision: bodyRevision(prepared.body),
			index_version: 1,
			selected_by: "model",
			locator: {
				kind: "markdown-block",
				block_id: prepared.quoteBlock.id,
				heading: "Source",
				paragraph: 2,
			},
		}]);
		expect(readdirSync(dirname(join(root, prepared.pagePath))).some((name) => name.endsWith(".tmp"))).toBe(false);
	});

	it("keeps file-level provenance and does not write a guessed locator when candidates fail", async () => {
		const root = makeTempDir();
		const prepared = prepare(root);
		const before = readText(join(root, prepared.pagePath));
		const selector = selectorReturning(async (input) => [{
			source_id: input.sourceId,
			block_id: prepared.quoteBlock.id,
			quote: "This quote does not exist",
		}]);

		const result = await attachEvidenceToPages({
			l2DataDir: root,
			entry: entry(),
			pagePaths: [prepared.pagePath],
			selector,
		});

		expect(result).toEqual({ updated: [], rejected: 1 });
		expect(readText(join(root, prepared.pagePath))).toBe(before);
		const parsed = parseFrontmatter(before);
		expect(parsed.frontmatter?.sources).toEqual(["raw/uploads/current.md"]);
		expect(parsed.frontmatter?.source_ids).toEqual(["l2src_current"]);
		expect(parsed.frontmatter?.evidence_refs).toBeUndefined();
	});

	it("replaces only current-source model refs while preserving all valid user and other-source refs", async () => {
		const root = makeTempDir();
		const body = "\n# Shared page\n\nBalanced forces are discussed here.\n";
		const oldRevision = `sha256:${"d".repeat(64)}`;
		const currentUserRef = {
			source_id: "l2src_current",
			quote: "user-selected current evidence",
			source_revision: `sha256:${RAW_HASH}`,
			page_revision: oldRevision,
			index_version: 1,
			selected_by: "user",
			locator: { kind: "markdown-block", block_id: "md:user", paragraph: 1 },
		};
		const currentOldModelRef = {
			...currentUserRef,
			quote: "old model evidence",
			selected_by: "model",
			locator: { kind: "markdown-block", block_id: "md:old", paragraph: 2 },
		};
		const otherModelRef = {
			...currentUserRef,
			source_id: "l2src_other",
			quote: "other source evidence",
			source_revision: `sha256:${"e".repeat(64)}`,
			selected_by: "model",
			locator: { kind: "pdf-page", page: 7, block_id: "pdf:other" },
		};
		const prepared = prepare(root, frontmatter({
			sources: ["raw/uploads/current.md", "raw/uploads/other.pdf"],
			source_ids: ["l2src_current", "l2src_other"],
			evidence_refs: [currentUserRef, currentOldModelRef, otherModelRef],
		}), body);
		const selector = selectorReturning(async () => [{
			source_id: "l2src_current",
			block_id: prepared.quoteBlock.id,
			quote: "Balanced forces",
		}]);

		const result = await attachEvidenceToPages({
			l2DataDir: root,
			entry: entry(),
			pagePaths: [prepared.pagePath],
			selector,
		});

		expect(result.rejected).toBe(0);
		const refs = parseFrontmatter(readText(join(root, prepared.pagePath))).frontmatter?.evidence_refs;
		expect(refs).toHaveLength(3);
		expect(refs?.[0]).toEqual(currentUserRef);
		expect(refs?.[1]).toEqual(otherModelRef);
		expect(refs?.[2]).toEqual(expect.objectContaining({
			source_id: "l2src_current",
			quote: "Balanced forces",
			selected_by: "model",
			page_revision: bodyRevision(prepared.body),
		}));
		expect(JSON.stringify(refs)).not.toContain("old model evidence");
	});

	it("removes malformed current-source model refs while preserving malformed user refs", async () => {
		const root = makeTempDir();
		const malformedCurrentModel = {
			source_id: "l2src_current",
			selected_by: "model",
			quote: 42,
			locator: null,
		};
		const malformedCurrentUser = {
			source_id: "l2src_current",
			selected_by: "user",
			custom: "preserve verbatim",
		};
		const prepared = prepare(root, frontmatter({
			evidence_refs: [malformedCurrentModel, malformedCurrentUser],
		}));

		const result = await attachEvidenceToPages({
			l2DataDir: root,
			entry: entry(),
			pagePaths: [prepared.pagePath],
			selector: selectorReturning(async () => []),
		});

		expect(result).toEqual({ updated: [prepared.pagePath], rejected: 0 });
		expect(parseFrontmatter(readText(join(root, prepared.pagePath))).frontmatter?.evidence_refs)
			.toEqual([malformedCurrentUser]);
	});

	it("does nothing without a selector, a complete source revision, or a ready index", async () => {
		const root = makeTempDir();
		const prepared = prepare(root);
		const before = readText(join(root, prepared.pagePath));

		await expect(attachEvidenceToPages({
			l2DataDir: root,
			entry: entry(),
			pagePaths: [prepared.pagePath],
			selector: null,
		})).resolves.toEqual({ updated: [], rejected: 0 });
		await expect(attachEvidenceToPages({
			l2DataDir: root,
			entry: { ...entry(), rawContentHash: undefined },
			pagePaths: [prepared.pagePath],
			selector: selectorReturning(async () => []),
		})).resolves.toEqual({ updated: [], rejected: 0 });
		await expect(attachEvidenceToPages({
			l2DataDir: makeTempDir(),
			entry: entry(),
			pagePaths: [prepared.pagePath],
			selector: selectorReturning(async () => []),
		})).resolves.toEqual({ updated: [], rejected: 0 });
		expect(readText(join(root, prepared.pagePath))).toBe(before);
	});

	it("contains selector failures and leaves page content unchanged", async () => {
		const root = makeTempDir();
		const prepared = prepare(root);
		const before = readText(join(root, prepared.pagePath));
		const selector = selectorReturning(async () => {
			throw new Error("provider failed with private source text");
		});

		await expect(attachEvidenceToPages({
			l2DataDir: root,
			entry: entry(),
			pagePaths: [prepared.pagePath],
			selector,
		})).resolves.toEqual({ updated: [], rejected: 1 });
		expect(readText(join(root, prepared.pagePath))).toBe(before);
	});

	it("does not overwrite a page edited while evidence selection is running", async () => {
		const root = makeTempDir();
		const prepared = prepare(root);
		let release!: () => void;
		const waiting = new Promise<void>((resolve) => { release = resolve; });
		const select = vi.fn(async () => {
			await waiting;
			return [{
				source_id: "l2src_current",
				block_id: prepared.quoteBlock.id,
				quote: "equal magnitude",
			}];
		});
		const pending = attachEvidenceToPages({
			l2DataDir: root,
			entry: entry(),
			pagePaths: [prepared.pagePath],
			selector: { select },
		});
		await vi.waitFor(() => expect(select).toHaveBeenCalledOnce());
		const edited = `${serializeFrontmatter(frontmatter({ title: "Edited by user" }))}\n# Edited\n\nUser content must survive.\n`;
		writeText(join(root, prepared.pagePath), edited);
		release();

		await expect(pending).resolves.toEqual({ updated: [], rejected: 0 });
		expect(readText(join(root, prepared.pagePath))).toBe(edited);
	});
});

describe("attachGroundedCitations", () => {
	it("writes marker-bearing refs only when every marker resolves", () => {
		const root = makeTempDir();
		const body = "\n# Summary\n\nBalanced forces have equal magnitude [1].\n";
		const prepared = prepare(root, frontmatter({ type: "source-summary" }), body);

		const result = attachGroundedCitations({
			l2DataDir: root,
			entry: entry(),
			pagePath: prepared.pagePath,
			citations: [{ marker: 1, quote: "equal magnitude" }],
		});

		expect(result).toEqual({ updated: true, accepted: 1, rejected: 0 });
		const parsed = parseFrontmatter(readText(join(root, prepared.pagePath)));
		expect(parsed.body).toBe(prepared.body);
		expect(parsed.frontmatter?.evidence_refs).toEqual([
			expect.objectContaining({ marker: 1, quote: "equal magnitude" }),
		]);
	});

	it("removes every marker instead of publishing partial grounded refs", () => {
		const root = makeTempDir();
		const body = "\n# Summary\n\nBalanced forces have equal magnitude [1]. Missing claim [2].\n";
		const prepared = prepare(root, frontmatter({ type: "source-summary" }), body);

		const result = attachGroundedCitations({
			l2DataDir: root,
			entry: entry(),
			pagePath: prepared.pagePath,
			citations: [
				{ marker: 1, quote: "equal magnitude" },
				{ marker: 2, quote: "This quote does not exist" },
			],
		});

		expect(result).toEqual({ updated: true, accepted: 0, rejected: 2 });
		const parsed = parseFrontmatter(readText(join(root, prepared.pagePath)));
		expect(parsed.body).toBe("# Summary\n\nBalanced forces have equal magnitude . Missing claim .\n");
		expect(parsed.frontmatter?.evidence_refs).toBeUndefined();
	});
});
