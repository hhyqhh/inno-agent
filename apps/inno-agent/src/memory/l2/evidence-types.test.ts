import { describe, expect, it, vi } from "vitest";

import {
	decodeEvidenceRefs,
	type EvidenceLocator,
	type EvidenceRef,
} from "./evidence-types.js";

const SOURCE_REVISION = `sha256:${"a".repeat(64)}`;
const PAGE_REVISION = `sha256:${"b".repeat(64)}`;

function persistedRef(locator: EvidenceLocator, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		source_id: "l2src_declared",
		quote: "A precise supporting quote.",
		source_revision: SOURCE_REVISION,
		page_revision: PAGE_REVISION,
		index_version: 1,
		selected_by: "model",
		locator,
		...overrides,
	};
}

describe("decodeEvidenceRefs", () => {
	it("decodes PDF, Markdown, and DOCX locators while ignoring extra top-level keys", () => {
		const raw = [
			persistedRef(
				{ kind: "pdf-page", page: 3, block_id: "pdf:block:3" },
				{ source_id: "l2src_pdf", future_field: { version: 2 } },
			),
			persistedRef(
				{ kind: "markdown-block", block_id: "md:block:7", heading: "Details", paragraph: 2 },
				{ source_id: "l2src_markdown", selected_by: "user" },
			),
			persistedRef(
				{ kind: "docx-paragraph", block_id: "docx:block:11", heading: "Results", paragraph: 11 },
				{ source_id: "l2src_docx" },
			),
		];

		const decoded = decodeEvidenceRefs(raw, ["l2src_pdf", "l2src_markdown", "l2src_docx"]);

		expect(decoded.issues).toEqual([]);
		expect(decoded.valid).toEqual<EvidenceRef[]>([
			{
				source_id: "l2src_pdf",
				quote: "A precise supporting quote.",
				source_revision: SOURCE_REVISION,
				page_revision: PAGE_REVISION,
				index_version: 1,
				selected_by: "model",
				locator: { kind: "pdf-page", page: 3, block_id: "pdf:block:3" },
			},
			{
				source_id: "l2src_markdown",
				quote: "A precise supporting quote.",
				source_revision: SOURCE_REVISION,
				page_revision: PAGE_REVISION,
				index_version: 1,
				selected_by: "user",
				locator: { kind: "markdown-block", block_id: "md:block:7", heading: "Details", paragraph: 2 },
			},
			{
				source_id: "l2src_docx",
				quote: "A precise supporting quote.",
				source_revision: SOURCE_REVISION,
				page_revision: PAGE_REVISION,
				index_version: 1,
				selected_by: "model",
				locator: { kind: "docx-paragraph", block_id: "docx:block:11", heading: "Results", paragraph: 11 },
			},
		]);
	});

	it("counts the 500-character quote limit in Unicode code points", () => {
		const boundaryQuote = ` ${"🧪".repeat(498)} `;
		const decoded = decodeEvidenceRefs([
			persistedRef({ kind: "pdf-page", page: 1, block_id: "pdf:block:1" }, { quote: boundaryQuote }),
			persistedRef({ kind: "pdf-page", page: 2, block_id: "pdf:block:2" }, { quote: "🧪".repeat(501) }),
		], ["l2src_declared"]);

		expect(decoded.valid).toHaveLength(1);
		expect(decoded.valid[0]?.quote).toBe(boundaryQuote);
		expect(decoded.issues).toEqual([
			{ ordinal: 1, sourceId: "l2src_declared", code: "invalid-quote" },
		]);
	});

	it("rejects quotes that are empty after trimming", () => {
		const decoded = decodeEvidenceRefs([
			persistedRef({ kind: "pdf-page", page: 1, block_id: "pdf:block:1" }, { quote: "   " }),
		], ["l2src_declared"]);

		expect(decoded).toEqual({
			valid: [],
			issues: [{ ordinal: 0, sourceId: "l2src_declared", code: "invalid-quote" }],
		});
	});

	it("rejects oversized quotes without materializing all code points", () => {
		const arrayFromSpy = vi.spyOn(Array, "from");
		let decoded: ReturnType<typeof decodeEvidenceRefs> | undefined;
		let arrayFromCallCount = -1;
		try {
			decoded = decodeEvidenceRefs([
				persistedRef(
					{ kind: "pdf-page", page: 1, block_id: "pdf:block:1" },
					{ quote: "🧪".repeat(100_000) },
				),
			], ["l2src_declared"]);
			arrayFromCallCount = arrayFromSpy.mock.calls.length;
		} finally {
			arrayFromSpy.mockRestore();
		}

		expect(arrayFromCallCount).toBe(0);
		expect(decoded).toEqual({
			valid: [],
			issues: [{ ordinal: 0, sourceId: "l2src_declared", code: "invalid-quote" }],
		});
	});

	it("accepts only exact lowercase complete SHA-256 revisions and index version 1", () => {
		const invalidRevisions = [
			{ source_revision: `sha256:${"A".repeat(64)}` },
			{ source_revision: "a".repeat(64) },
			{ source_revision: `sha256:${"a".repeat(63)}` },
			{ page_revision: `${PAGE_REVISION}\n` },
			{ index_version: 2 },
		];
		const decoded = decodeEvidenceRefs(
			invalidRevisions.map((overrides, index) => persistedRef(
				{ kind: "pdf-page", page: index + 1, block_id: `pdf:block:${index + 1}` },
				overrides,
			)),
			["l2src_declared"],
		);

		expect(decoded.valid).toEqual([]);
		expect(decoded.issues).toEqual(invalidRevisions.map((_, ordinal) => ({
			ordinal,
			sourceId: "l2src_declared",
			code: "invalid-revision",
		})));
	});

	it("requires 1-based integer positions and non-empty block ids", () => {
		const raw = [
			persistedRef({ kind: "pdf-page", page: 0, block_id: "pdf:block:0" }),
			persistedRef({ kind: "markdown-block", block_id: "md:block:0", paragraph: 0 }),
			persistedRef({ kind: "docx-paragraph", block_id: "docx:block:1.5", paragraph: 1.5 }),
			persistedRef({ kind: "pdf-page", page: 1, block_id: "   " }),
		];

		const decoded = decodeEvidenceRefs(raw, ["l2src_declared"]);

		expect(decoded.valid).toEqual([]);
		expect(decoded.issues).toEqual(raw.map((_, ordinal) => ({
			ordinal,
			sourceId: "l2src_declared",
			code: "invalid-locator",
		})));
	});

	it("accepts MAX_SAFE_INTEGER positions and rejects larger integers", () => {
		const decoded = decodeEvidenceRefs([
			persistedRef({
				kind: "pdf-page",
				page: Number.MAX_SAFE_INTEGER,
				block_id: "pdf:block:max-safe",
			}),
			persistedRef({
				kind: "markdown-block",
				paragraph: Number.MAX_SAFE_INTEGER + 1,
				block_id: "md:block:unsafe",
			}),
		], ["l2src_declared"]);

		expect(decoded.valid).toHaveLength(1);
		expect(decoded.valid[0]?.locator).toEqual({
			kind: "pdf-page",
			page: Number.MAX_SAFE_INTEGER,
			block_id: "pdf:block:max-safe",
		});
		expect(decoded.issues).toEqual([
			{ ordinal: 1, sourceId: "l2src_declared", code: "invalid-locator" },
		]);
	});

	it("accepts only citation markers in the UI-supported 1 to 999 range", () => {
		const decoded = decodeEvidenceRefs([
			persistedRef({ kind: "pdf-page", page: 1, block_id: "pdf:block:1" }, { marker: 1 }),
			persistedRef({ kind: "pdf-page", page: 2, block_id: "pdf:block:2" }, { marker: 999 }),
			persistedRef({ kind: "pdf-page", page: 3, block_id: "pdf:block:3" }, { marker: 0 }),
			persistedRef({ kind: "pdf-page", page: 4, block_id: "pdf:block:4" }, { marker: 1000 }),
			persistedRef({ kind: "pdf-page", page: 5, block_id: "pdf:block:5" }, { marker: 1.5 }),
		], ["l2src_declared"]);

		expect(decoded.valid.map((ref) => ref.marker)).toEqual([1, 999]);
		expect(decoded.issues).toEqual([
			{ ordinal: 2, sourceId: "l2src_declared", code: "invalid-marker" },
			{ ordinal: 3, sourceId: "l2src_declared", code: "invalid-marker" },
			{ ordinal: 4, sourceId: "l2src_declared", code: "invalid-marker" },
		]);
	});

	it("rejects duplicate citation markers at page decode time", () => {
		const decoded = decodeEvidenceRefs([
			persistedRef({ kind: "pdf-page", page: 1, block_id: "pdf:block:first" }, { marker: 1 }),
			persistedRef({ kind: "pdf-page", page: 2, block_id: "pdf:block:duplicate" }, { marker: 1 }),
		], ["l2src_declared"]);

		expect(decoded.valid.map((ref) => ref.locator)).toEqual([
			{ kind: "pdf-page", page: 1, block_id: "pdf:block:first" },
		]);
		expect(decoded.issues).toEqual([
			{ ordinal: 1, sourceId: "l2src_declared", code: "invalid-marker" },
		]);
	});

	it("reports malformed refs and unknown locator kinds as safe structured issues", () => {
		const decoded = decodeEvidenceRefs([
			null,
			{ source_id: { private: "malformed-source-id" } },
			persistedRef({ kind: "pdf-page", page: 1, block_id: "pdf:block:1" }, { source_id: "l2src_missing" }),
			persistedRef({ kind: "pdf-page", page: 1, block_id: "pdf:block:1" }, { quote: { private: "malformed-quote" } }),
			persistedRef({ kind: "pdf-page", page: 1, block_id: "pdf:block:1" }, { selected_by: "system" }),
			persistedRef({ kind: "future-locator", private: "malformed-locator" } as unknown as EvidenceLocator),
		], ["l2src_declared"]);

		expect(decoded.valid).toEqual([]);
		expect(decoded.issues).toEqual([
			{ ordinal: 0, code: "not-object" },
			{ ordinal: 1, code: "invalid-source-id" },
			{ ordinal: 2, sourceId: "l2src_missing", code: "source-id-not-declared" },
			{ ordinal: 3, sourceId: "l2src_declared", code: "invalid-quote" },
			{ ordinal: 4, sourceId: "l2src_declared", code: "invalid-selected-by" },
			{ ordinal: 5, sourceId: "l2src_declared", code: "invalid-locator" },
		]);

		const serializedIssues = JSON.stringify(decoded.issues);
		expect(serializedIssues).not.toContain("malformed-source-id");
		expect(serializedIssues).not.toContain("malformed-quote");
		expect(serializedIssues).not.toContain("malformed-locator");
	});

	it("omits non-canonical declared source IDs from issues without restricting valid refs", () => {
		const controlId = "l2src_control\u0001marker";
		const emailId = "learner@example.com";
		const overlongId = `l2src_${"x".repeat(129)}`;
		const legacyId = "legacy@example.com";
		const decoded = decodeEvidenceRefs([
			persistedRef({ kind: "pdf-page", page: 1, block_id: "pdf:block:1" }, { source_id: controlId, selected_by: "system" }),
			persistedRef({ kind: "pdf-page", page: 2, block_id: "pdf:block:2" }, { source_id: emailId, selected_by: "system" }),
			persistedRef({ kind: "pdf-page", page: 3, block_id: "pdf:block:3" }, { source_id: overlongId, selected_by: "system" }),
			persistedRef({ kind: "pdf-page", page: 4, block_id: "pdf:block:4" }, { source_id: legacyId }),
		], [controlId, emailId, overlongId, legacyId]);

		expect(decoded.valid).toHaveLength(1);
		expect(decoded.valid[0]?.source_id).toBe(legacyId);
		expect(decoded.issues).toEqual([
			{ ordinal: 0, code: "invalid-selected-by" },
			{ ordinal: 1, code: "invalid-selected-by" },
			{ ordinal: 2, code: "invalid-selected-by" },
		]);
		const serializedIssues = JSON.stringify(decoded.issues);
		expect(serializedIssues).not.toContain("marker");
		expect(serializedIssues).not.toContain(emailId);
		expect(serializedIssues).not.toContain(overlongId);
	});

	it("retains only canonical unknown source IDs on undeclared issues", () => {
		const controlId = "l2src_control\u0001marker";
		const emailId = "learner@example.com";
		const overlongId = `l2src_${"x".repeat(129)}`;
		const canonicalId = "l2src_physics_001";
		const decoded = decodeEvidenceRefs([
			persistedRef({ kind: "pdf-page", page: 1, block_id: "pdf:block:1" }, { source_id: controlId }),
			persistedRef({ kind: "pdf-page", page: 2, block_id: "pdf:block:2" }, { source_id: emailId }),
			persistedRef({ kind: "pdf-page", page: 3, block_id: "pdf:block:3" }, { source_id: overlongId }),
			persistedRef({ kind: "pdf-page", page: 4, block_id: "pdf:block:4" }, { source_id: canonicalId }),
		], []);

		expect(decoded.valid).toEqual([]);
		expect(decoded.issues).toEqual([
			{ ordinal: 0, code: "source-id-not-declared" },
			{ ordinal: 1, code: "source-id-not-declared" },
			{ ordinal: 2, code: "source-id-not-declared" },
			{ ordinal: 3, sourceId: canonicalId, code: "source-id-not-declared" },
		]);
		const serializedIssues = JSON.stringify(decoded.issues);
		expect(serializedIssues).not.toContain("marker");
		expect(serializedIssues).not.toContain(emailId);
		expect(serializedIssues).not.toContain(overlongId);
	});

	it("rejects empty source ids without copying the raw value into an issue", () => {
		const decoded = decodeEvidenceRefs([
			persistedRef({ kind: "pdf-page", page: 1, block_id: "pdf:block:1" }, { source_id: "   " }),
		], ["l2src_declared"]);

		expect(decoded).toEqual({
			valid: [],
			issues: [{ ordinal: 0, code: "invalid-source-id" }],
		});
	});

	it("treats absent evidence refs as an empty collection", () => {
		expect(decodeEvidenceRefs(undefined, ["l2src_declared"])).toEqual({ valid: [], issues: [] });
	});
});
