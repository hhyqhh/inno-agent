import { describe, expect, it } from "vitest";
import type {
	EvidenceLocator,
	PositionReasonCode,
	ResolvedEvidenceReference,
	SourceProvenanceGroup,
	WikiPageDetail,
} from "../../types/wiki.js";
import {
	buildMarkerTargets,
	canUseExactTarget,
	normalizeCitationIdentityText,
	resolveSummaryNavigation,
	sourceSummaryPaths,
	targetForReadySource,
} from "./summary-navigation.js";

const SOURCE_REVISION = `sha256:${"a".repeat(64)}`;
const CURRENT_SOURCE_REVISION = `sha256:${"b".repeat(64)}`;

type ReadySource = Extract<SourceProvenanceGroup, { availability: "ready" }>;

function sourceSummaryContent(type = "source-summary"): string {
	return `---
title: Physics source summary
created: 2026-08-19
type: ${type}
tags: [physics]
sources:
  - raw/uploads/physics.md
source_ids:
  - l2src_physics
updated: 2026-08-19
status: reviewed
confidence: high
---

# Physics source summary

The source supports the claim [1].`;
}

function evidenceReference(overrides: Partial<ResolvedEvidenceReference> = {}): ResolvedEvidenceReference {
	return {
		quote: "The source supports the claim.",
		locator: { kind: "markdown-block", block_id: "md-claim", heading: "Evidence", paragraph: 3 },
		selectedBy: "model",
		positionStatus: "verified",
		reasonCodes: [],
		marker: 1,
		...overrides,
	};
}

function readySource(overrides: Partial<ReadySource> = {}): ReadySource {
	return {
		availability: "ready",
		sourceId: "l2src_physics",
		title: "Physics source.md",
		sourceType: "markdown",
		origin: "user_upload",
		rawKind: "uploaded-original",
		rawRelativePath: "raw/uploads/physics.md",
		sourceRevision: SOURCE_REVISION,
		references: [evidenceReference()],
		...overrides,
	};
}

function summaryPage(overrides: {
	path?: string;
	content?: string;
	sourceGroups?: SourceProvenanceGroup[];
} = {}): WikiPageDetail {
	return {
		path: overrides.path ?? "wiki/sources/physics-l2src_physics.md",
		content: overrides.content ?? sourceSummaryContent(),
		provenance: {
			sourceGroups: overrides.sourceGroups ?? [readySource()],
			legacyPaths: [],
			referenceIssues: [],
		},
	};
}

function identity(locator: EvidenceLocator = {
	kind: "markdown-block",
	block_id: "md-claim",
	heading: "Evidence",
	paragraph: 3,
}) {
	return {
		sourceId: "l2src_physics",
		quote: "The source supports the claim.",
		locator,
	};
}

describe("sourceSummaryPaths", () => {
	it("keeps literal single-file source-summary paths in order and deduplicates them", () => {
		expect(sourceSummaryPaths([
			"wiki/sources/alpha.md",
			"raw/uploads/alpha.md",
			"wiki/sources/nested/alpha.md",
			"wiki\\sources\\alpha.md",
			"wiki/sources/alpha.MD",
			"wiki/sources/alpha.md",
			"wiki/sources/beta file.md",
		])).toEqual([
			"wiki/sources/alpha.md",
			"wiki/sources/beta file.md",
		]);
	});
});

describe("normalizeCitationIdentityText", () => {
	it("normalizes line endings, Unicode composition, and whitespace runs", () => {
		expect(normalizeCitationIdentityText("  Cafe\u0301\r\n\tproof\u00a0 text  ")).toBe("Caf\u00e9 proof text");
	});

	it.each([
		["**claim**", "claim"],
		["[claim](https://example.test/source)", "claim"],
	])("compares Markdown formatting by visible text: %s", (formatted, visible) => {
		expect(normalizeCitationIdentityText(formatted)).toBe(visible);
	});
});

describe("resolveSummaryNavigation", () => {
	it("locates the unique matching source-summary marker", () => {
		const page = summaryPage();

		expect(resolveSummaryNavigation([page], identity())).toEqual({
			status: "located",
			page,
			marker: 1,
		});
	});

	it("matches normalized quote text without fuzzy guessing", () => {
		const page = summaryPage({
			sourceGroups: [readySource({
				references: [evidenceReference({ quote: "Cafe\u0301\r\n\tproof" })],
			})],
		});

		expect(resolveSummaryNavigation([page], {
			...identity(),
			quote: " Caf\u00e9  proof ",
		})).toMatchObject({ status: "located", marker: 1 });
	});

	it.each([
		["**claim**", "claim"],
		["[claim](https://example.test/source)", "claim"],
	])("matches formatted Markdown quotes by visible text: %s", (referenceQuote, identityQuote) => {
		const page = summaryPage({
			sourceGroups: [readySource({
				references: [evidenceReference({ quote: referenceQuote })],
			})],
		});

		expect(resolveSummaryNavigation([page], {
			...identity(),
			quote: identityQuote,
		})).toMatchObject({ status: "located", marker: 1 });
	});

	it("rejects a unique quote when its locator kind or position conflicts", () => {
		const page = summaryPage({
			sourceGroups: [readySource({
				references: [evidenceReference({
					locator: { kind: "pdf-page", block_id: "md-claim", page: 99 },
				})],
			})],
		});

		expect(resolveSummaryNavigation([page], identity())).toEqual({ status: "not-found", page });
	});

	it("matches Markdown-formatted quotes by their rendered visible text", () => {
		const page = summaryPage({
			sourceGroups: [readySource({
				references: [evidenceReference({ quote: "**The source** supports [the claim](https://example.invalid)." })],
			})],
		});

		expect(resolveSummaryNavigation([page], {
			...identity(),
			quote: "The source supports the claim.",
		})).toMatchObject({ status: "located", marker: 1 });
	});

	it("ignores pages without parsed source-summary frontmatter", () => {
		const unparsed = summaryPage({ content: "No frontmatter" });
		const concept = summaryPage({ content: sourceSummaryContent("concept") });

		expect(resolveSummaryNavigation([unparsed, concept], identity())).toEqual({ status: "no-summary" });
	});

	it("returns no-summary when the source id does not match", () => {
		const page = summaryPage({ sourceGroups: [readySource({ sourceId: "l2src_other" })] });

		expect(resolveSummaryNavigation([page], identity())).toEqual({ status: "no-summary" });
	});

	it("returns ambiguous-summary for matching groups on multiple pages", () => {
		const first = summaryPage({ path: "wiki/sources/first.md" });
		const second = summaryPage({ path: "wiki/sources/second.md" });

		expect(resolveSummaryNavigation([first, second], identity())).toEqual({ status: "ambiguous-summary" });
	});

	it("returns ambiguous-summary for duplicate matching groups on one page", () => {
		const page = summaryPage({ sourceGroups: [readySource(), readySource()] });

		expect(resolveSummaryNavigation([page], identity())).toEqual({ status: "ambiguous-summary" });
	});

	it("returns not-found when the unique reference has no marker", () => {
		const page = summaryPage({
			sourceGroups: [readySource({ references: [evidenceReference({ marker: undefined })] })],
		});

		expect(resolveSummaryNavigation([page], identity())).toEqual({ status: "not-found", page });
	});

	it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
		"returns not-found for invalid marker %s",
		(marker) => {
			const page = summaryPage({
				sourceGroups: [readySource({ references: [evidenceReference({ marker })] })],
			});

			expect(resolveSummaryNavigation([page], identity())).toEqual({ status: "not-found", page });
		},
	);

	it("returns ambiguous-marker when duplicate matching references remain", () => {
		const page = summaryPage({
			sourceGroups: [readySource({
				references: [
					evidenceReference({ marker: 1 }),
					evidenceReference({ marker: 2 }),
				],
			})],
		});

		expect(resolveSummaryNavigation([page], identity())).toEqual({ status: "ambiguous-marker", page });
	});

	it("narrows duplicate block-and-quote matches by locator kind", () => {
		const page = summaryPage({
			sourceGroups: [readySource({
				references: [
					evidenceReference({
						locator: { kind: "pdf-page", block_id: "md-claim", page: 3 },
						marker: 8,
					}),
					evidenceReference({ marker: 9 }),
				],
			})],
		});

		expect(resolveSummaryNavigation([page], identity())).toMatchObject({ status: "located", marker: 9 });
	});

	it("narrows PDF matches by exact page", () => {
		const page = summaryPage({
			sourceGroups: [readySource({
				references: [
					evidenceReference({ locator: { kind: "pdf-page", block_id: "pdf-claim", page: 4 }, marker: 4 }),
					evidenceReference({ locator: { kind: "pdf-page", block_id: "pdf-claim", page: 5 }, marker: 5 }),
				],
			})],
		});

		expect(resolveSummaryNavigation([page], identity({
			kind: "pdf-page",
			block_id: "pdf-claim",
			page: 5,
		}))).toMatchObject({ status: "located", marker: 5 });
	});

	it("narrows Markdown matches by paragraph and heading when both headings exist", () => {
		const page = summaryPage({
			sourceGroups: [readySource({
				references: [
					evidenceReference({
						locator: { kind: "markdown-block", block_id: "md-claim", heading: "Earlier", paragraph: 3 },
						marker: 3,
					}),
					evidenceReference({
						locator: { kind: "markdown-block", block_id: "md-claim", heading: "Evidence", paragraph: 3 },
						marker: 4,
					}),
					evidenceReference({
						locator: { kind: "markdown-block", block_id: "md-claim", heading: "Evidence", paragraph: 4 },
						marker: 5,
					}),
				],
			})],
		});

		expect(resolveSummaryNavigation([page], identity())).toMatchObject({ status: "located", marker: 4 });
	});

	it("returns not-found when locator narrowing has no exact match", () => {
		const page = summaryPage({
			sourceGroups: [readySource({
				references: [
					evidenceReference({ locator: { kind: "pdf-page", block_id: "pdf-claim", page: 1 }, marker: 1 }),
					evidenceReference({ locator: { kind: "pdf-page", block_id: "pdf-claim", page: 2 }, marker: 2 }),
				],
			})],
		});

		expect(resolveSummaryNavigation([page], identity({
			kind: "pdf-page",
			block_id: "pdf-claim",
			page: 3,
		}))).toEqual({ status: "not-found", page });
	});

	it("returns ambiguous-marker when another page reference claims the selected marker", () => {
		const page = summaryPage({
			sourceGroups: [readySource({
				references: [
					evidenceReference({ marker: 6 }),
					evidenceReference({
						quote: "A different claim.",
						locator: { kind: "markdown-block", block_id: "md-other", paragraph: 9 },
						marker: 6,
				}),
				],
			})],
		});

		expect(resolveSummaryNavigation([page], identity())).toEqual({ status: "ambiguous-marker", page });
	});

	it("returns not-found for a unique block-and-quote match with the wrong locator kind", () => {
		const page = summaryPage({
			sourceGroups: [readySource({
				references: [evidenceReference({
					locator: { kind: "pdf-page", block_id: "md-claim", page: 3 },
				})],
			})],
		});

		expect(resolveSummaryNavigation([page], identity())).toEqual({ status: "not-found", page });
	});

	it("returns not-found for a unique PDF match with the wrong page", () => {
		const page = summaryPage({
			sourceGroups: [readySource({
				references: [evidenceReference({
					locator: { kind: "pdf-page", block_id: "pdf-claim", page: 4 },
				})],
			})],
		});

		expect(resolveSummaryNavigation([page], identity({
			kind: "pdf-page",
			block_id: "pdf-claim",
			page: 5,
		}))).toEqual({ status: "not-found", page });
	});

	it("returns not-found for a unique Markdown match with the wrong paragraph", () => {
		const page = summaryPage({
			sourceGroups: [readySource({
				references: [evidenceReference({
					locator: { kind: "markdown-block", block_id: "md-claim", heading: "Evidence", paragraph: 3 },
				})],
			})],
		});

		expect(resolveSummaryNavigation([page], identity({
			kind: "markdown-block",
			block_id: "md-claim",
			heading: "Evidence",
			paragraph: 4,
		}))).toEqual({ status: "not-found", page });
	});

	it("returns not-found for a unique Markdown match with the requested heading missing", () => {
		const page = summaryPage({
			sourceGroups: [readySource({
				references: [evidenceReference({
					locator: { kind: "markdown-block", block_id: "md-claim", paragraph: 3 },
				})],
			})],
		});

		expect(resolveSummaryNavigation([page], identity())).toEqual({ status: "not-found", page });
	});
});

describe("source viewer targets", () => {
	it.each(["verified", "stale-page", "locator-invalid", "quote-mismatch", "drifted"] as const)(
		"allows exact targets for %s references",
		(status) => {
			expect(canUseExactTarget(status)).toBe(true);
		},
	);

	it.each(["missing-source", "missing-file", "stale-source", "missing-index", "corrupt-index", "index-version-mismatch"] satisfies PositionReasonCode[])(
		"uses file mode for %s references",
		(status) => {
			const target = targetForReadySource(readySource(), evidenceReference({ positionStatus: status }));

			expect(canUseExactTarget(status)).toBe(false);
			expect(target).toMatchObject({ mode: "file", sourceRevision: SOURCE_REVISION });
		},
	);

	it("builds marker targets from the current ready summary group revision", () => {
		const page = summaryPage({
			sourceGroups: [readySource({
				sourceRevision: CURRENT_SOURCE_REVISION,
				references: [evidenceReference({ marker: 7 })],
			})],
		});

		expect(buildMarkerTargets(page).get(7)).toMatchObject({
			mode: "exact",
			sourceId: "l2src_physics",
			sourceRevision: CURRENT_SOURCE_REVISION,
			quote: "The source supports the claim.",
		});
	});

	it("fails closed when two references claim the same marker", () => {
		const page = summaryPage({
			sourceGroups: [readySource({
				references: [
					evidenceReference({ marker: 3 }),
					evidenceReference({ quote: "Another claim.", marker: 3 }),
				],
			})],
		});

		expect(buildMarkerTargets(page).has(3)).toBe(false);
	});
});
