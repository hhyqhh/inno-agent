import { describe, expect, it } from "vitest";

import type { EvidenceBlock, SourceEvidenceIndex } from "./evidence-index.js";
import type { EvidenceCandidate, EvidenceResolutionContext } from "./evidence-resolver.js";
import { resolveEvidenceCandidates, resolveGroundedCitations } from "./evidence-resolver.js";

const RAW_HASH = "a".repeat(64);
const SOURCE_REVISION = `sha256:${RAW_HASH}`;
const PAGE_REVISION = `sha256:${"b".repeat(64)}`;

function pdfBlock(overrides: Partial<EvidenceBlock> = {}): EvidenceBlock {
	return {
		id: "pdf:p003:b001:alpha",
		kind: "pdf",
		text: "Balanced forces have equal magnitude and opposite directions.",
		page: 3,
		...overrides,
	};
}

function index(blocks: EvidenceBlock[] = [pdfBlock()]): SourceEvidenceIndex {
	return {
		version: 1,
		source_id: "l2src_physics_001",
		raw_content_hash: RAW_HASH,
		extracted_content_hash: "c".repeat(64),
		blocks,
	};
}

function context(overrides: Partial<EvidenceResolutionContext> = {}): EvidenceResolutionContext {
	return {
		sourceId: "l2src_physics_001",
		sourceRevision: SOURCE_REVISION,
		pageRevision: PAGE_REVISION,
		index: index(),
		...overrides,
	};
}

function candidate(overrides: Partial<EvidenceCandidate> = {}): EvidenceCandidate {
	return {
		source_id: "l2src_physics_001",
		block_id: "pdf:p003:b001:alpha",
		quote: "equal magnitude and opposite directions",
		...overrides,
	};
}

describe("resolveEvidenceCandidates", () => {
	it("derives PDF, Markdown, and DOCX locators only from authoritative blocks", () => {
		const blocks: EvidenceBlock[] = [
			pdfBlock(),
			{
				id: "md:b0002:beta",
				kind: "markdown",
				text: "A markdown fact appears here.",
				heading: "Details",
				paragraph: 2,
			},
			{
				id: "docx:p0004:gamma",
				kind: "docx",
				text: "A document paragraph supports the claim.",
				paragraph: 4,
			},
		];
		const result = resolveEvidenceCandidates([
			candidate(),
			candidate({ block_id: blocks[1].id, quote: "markdown fact" }),
			candidate({ block_id: blocks[2].id, quote: "document paragraph" }),
		], context({ index: index(blocks) }));

		expect(result.rejected).toEqual([]);
		expect(result.accepted).toEqual([
			{
				source_id: "l2src_physics_001",
				quote: "equal magnitude and opposite directions",
				source_revision: SOURCE_REVISION,
				page_revision: PAGE_REVISION,
				index_version: 1,
				selected_by: "model",
				locator: { kind: "pdf-page", page: 3, block_id: blocks[0].id },
			},
			{
				source_id: "l2src_physics_001",
				quote: "markdown fact",
				source_revision: SOURCE_REVISION,
				page_revision: PAGE_REVISION,
				index_version: 1,
				selected_by: "model",
				locator: { kind: "markdown-block", block_id: blocks[1].id, heading: "Details", paragraph: 2 },
			},
			{
				source_id: "l2src_physics_001",
				quote: "document paragraph",
				source_revision: SOURCE_REVISION,
				page_revision: PAGE_REVISION,
				index_version: 1,
				selected_by: "model",
				locator: { kind: "docx-paragraph", block_id: blocks[2].id, paragraph: 4 },
			},
		]);
	});

	it("matches quotes in the NFC, newline, and collapsed-whitespace comparison view", () => {
		const authoritative = pdfBlock({ text: "Cafe\u0301\r\nkeeps   exact\tspacing." });
		const result = resolveEvidenceCandidates([
			candidate({ block_id: authoritative.id, quote: "Caf\u00e9 keeps exact spacing" }),
		], context({ index: index([authoritative]) }));

		expect(result.accepted).toHaveLength(1);
		expect(result.rejected).toEqual([]);
	});

	it("rejects a quote that occurs more than once in its target block", () => {
		const repeated = pdfBlock({ text: "same quote, then the same quote again" });
		const result = resolveEvidenceCandidates([
			candidate({ block_id: repeated.id, quote: "same quote" }),
		], context({ index: index([repeated]) }));

		expect(result).toEqual({
			accepted: [],
			rejected: [{
				candidateIndex: 0,
				sourceId: "l2src_physics_001",
				blockId: repeated.id,
				code: "quote-not-unique",
			}],
		});
	});

	it.each([
		["missing block", candidate({ block_id: "pdf:missing" }), "missing-block"],
		["wrong candidate source", candidate({ source_id: "l2src_other" }), "unknown-source"],
		["empty quote", candidate({ quote: "   " }), "invalid-quote"],
		["oversized quote", candidate({ quote: "x".repeat(501) }), "invalid-quote"],
		["quote outside block", candidate({ quote: "not found" }), "quote-not-found"],
	] as const)("rejects %s", (_label, input, code) => {
		const result = resolveEvidenceCandidates([input], context());

		expect(result.accepted).toEqual([]);
		expect(result.rejected).toEqual([expect.objectContaining({ candidateIndex: 0, code })]);
	});

	it("rejects non-whitelisted runtime candidate shapes", () => {
		const inputs = [
			{ ...candidate(), locator: { kind: "pdf-page", page: 99 } },
			{ ...candidate(), path: "raw/private.pdf" },
			{ ...candidate(), page: 3 },
			null,
		] as unknown as EvidenceCandidate[];

		const result = resolveEvidenceCandidates(inputs, context());

		expect(result.accepted).toEqual([]);
		expect(result.rejected.map((item) => item.code)).toEqual([
			"invalid-shape",
			"invalid-shape",
			"invalid-shape",
			"invalid-shape",
		]);
	});

	it.each([
		["source revision does not match raw hash", { sourceRevision: `sha256:${"d".repeat(64)}` }],
		["source revision is malformed", { sourceRevision: RAW_HASH }],
		["page revision is malformed", { pageRevision: "sha256:short" }],
		["index version differs", { index: { ...index(), version: 2 } as unknown as SourceEvidenceIndex }],
	] as const)("rejects all candidates when %s", (_label, override) => {
		const result = resolveEvidenceCandidates([candidate()], context(override));

		expect(result.accepted).toEqual([]);
		expect(result.rejected).toEqual([expect.objectContaining({ code: "revision-mismatch" })]);
	});

	it("rejects all candidates when the authoritative index belongs to another source", () => {
		const result = resolveEvidenceCandidates([
			candidate(),
			candidate({ quote: "Balanced forces" }),
		], context({ index: { ...index(), source_id: "l2src_other" } }));

		expect(result.accepted).toEqual([]);
		expect(result.rejected.map((item) => item.code)).toEqual(["unknown-source", "unknown-source"]);
	});

	it.each([
		["PDF without a page", pdfBlock({ page: undefined })],
		["PDF with paragraph metadata", pdfBlock({ paragraph: 1 })],
		["Markdown without a paragraph", { id: "md:broken", kind: "markdown", text: "markdown fact" } as EvidenceBlock],
		["Markdown with page metadata", { id: "md:broken", kind: "markdown", text: "markdown fact", page: 1, paragraph: 1 } as EvidenceBlock],
		["DOCX without a paragraph", { id: "docx:broken", kind: "docx", text: "document fact" } as EvidenceBlock],
	] as const)("rejects locator mismatch for %s", (_label, authoritative) => {
		const result = resolveEvidenceCandidates([
			candidate({ block_id: authoritative.id, quote: authoritative.text.split(" ")[0] }),
		], context({ index: index([authoritative]) }));

		expect(result.accepted).toEqual([]);
		expect(result.rejected).toEqual([expect.objectContaining({ code: "locator-mismatch" })]);
	});

	it("keeps accepted and rejected candidates in their own original order", () => {
		const result = resolveEvidenceCandidates([
			candidate({ quote: "Balanced forces" }),
			candidate({ block_id: "missing", quote: "missing" }),
			candidate({ quote: "opposite directions" }),
		], context());

		expect(result.accepted.map((item) => item.quote)).toEqual(["Balanced forces", "opposite directions"]);
		expect(result.rejected).toEqual([expect.objectContaining({ candidateIndex: 1, code: "missing-block" })]);
	});
});

describe("resolveGroundedCitations", () => {
	function groundedContext(overrides: Partial<EvidenceResolutionContext> = {}): EvidenceResolutionContext {
		return context(overrides);
	}

	it("rejects markers outside the UI-safe range", () => {
		const result = resolveGroundedCitations([
			{ marker: 1000, quote: "equal magnitude and opposite directions" },
		], groundedContext());

		expect(result.accepted).toEqual([]);
		expect(result.rejected).toEqual([{ candidateIndex: 0, code: "invalid-quote" }]);
	});

	it("rejects duplicate markers and malformed runtime citations without throwing", () => {
		const result = resolveGroundedCitations([
			{ marker: 1, quote: "Balanced forces" },
			{ marker: 1, quote: "opposite directions" },
			null as never,
		], groundedContext());

		expect(result.accepted).toHaveLength(1);
		expect(result.rejected).toEqual([
			{ candidateIndex: 1, code: "invalid-quote" },
			{ candidateIndex: 2, code: "invalid-quote" },
		]);
	});
});
