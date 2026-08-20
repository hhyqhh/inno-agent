import { join } from "node:path";

import { logger } from "../../logger.js";
import { fileExists, readText, writeText } from "../../storage/file-store.js";
import { readEvidenceIndex } from "./evidence-index.js";
import { evidenceMarkersMatch, stripEvidenceMarkers } from "./evidence-markers.js";
import {
	resolveEvidenceCandidates,
	resolveGroundedCitations,
	type GroundedCitationInput,
} from "./evidence-resolver.js";
import type {
	EvidenceCandidate,
	EvidenceCandidateSelector,
	EvidenceSelectionCode,
	EvidenceSelectionInput,
} from "./evidence-selector.js";
import type { EvidenceRef } from "./evidence-types.js";
import type { ManifestEntry, WikiPageFrontmatter } from "./types.js";
import { getWikiPageWriteQueue } from "./wiki-page-write-queue.js";
import {
	bodyRevision,
	fileRevision,
	parseFrontmatter,
	serializeFrontmatter,
} from "./wiki-maintainer.js";

export interface AttachEvidenceInput {
	l2DataDir: string;
	entry: ManifestEntry;
	pagePaths: readonly string[];
	selector: EvidenceCandidateSelector | null;
	/** Restrict generated refs to identities already accepted by a grounded summary. */
	canonicalReferences?: readonly EvidenceRef[];
}

interface MutableEvidenceSelectionOutcome {
	candidates: EvidenceCandidate[];
	codes: EvidenceSelectionCode[];
	rejected: number;
}

const SAFE_SELECTION_CODES = new Set<EvidenceSelectionCode>([
	"selector-auth-unavailable",
	"selector-provider-error",
	"selector-error",
	"selector-malformed-response",
	"selector-zero-candidates",
]);

function safeSelectionCodes(value: unknown): EvidenceSelectionCode[] {
	if (!Array.isArray(value)) return ["selector-malformed-response"];
	const codes = value.filter((code): code is EvidenceSelectionCode => SAFE_SELECTION_CODES.has(code));
	if (codes.length !== value.length && !codes.includes("selector-malformed-response")) {
		codes.push("selector-malformed-response");
	}
	return [...new Set(codes)];
}

function preservedReferences(frontmatter: WikiPageFrontmatter, sourceId: string): unknown[] {
	const rawReferences = Array.isArray(frontmatter.evidence_refs) ? frontmatter.evidence_refs : [];
	return rawReferences.filter((rawReference) => {
		if (rawReference === null || typeof rawReference !== "object" || Array.isArray(rawReference)) return true;
		const record = rawReference as Record<string, unknown>;
		return record.source_id !== sourceId || record.selected_by !== "model";
	});
}

function withEvidenceReferences(
	frontmatter: WikiPageFrontmatter,
	references: readonly unknown[],
): WikiPageFrontmatter {
	const updated = { ...frontmatter };
	if (references.length > 0) updated.evidence_refs = [...references];
	else delete updated.evidence_refs;
	return updated;
}

export async function attachEvidenceToPages(
	input: AttachEvidenceInput,
): Promise<{ updated: string[]; rejected: number }> {
	const updated: string[] = [];
	let rejected = 0;
	if (!input.selector || !input.entry.rawContentHash) return { updated, rejected };

	const indexResult = readEvidenceIndex(input.l2DataDir, input.entry.id, input.entry.rawContentHash);
	if (indexResult.status !== "ready") return { updated, rejected };

	const eligiblePages: Array<{
		pagePath: string;
		absolutePath: string;
		fileRevision: string;
		parsed: { frontmatter: WikiPageFrontmatter; body: string };
	}> = [];
	for (const pagePath of new Set(input.pagePaths)) {
		const absolutePath = join(input.l2DataDir, pagePath);
		if (!fileExists(absolutePath)) continue;
		const original = readText(absolutePath);
		const parsed = parseFrontmatter(original);
		if (!parsed.frontmatter || !parsed.frontmatter.source_ids.includes(input.entry.id)) continue;
		eligiblePages.push({
			pagePath,
			absolutePath,
			fileRevision: fileRevision(Buffer.from(original, "utf8")),
			parsed: { frontmatter: parsed.frontmatter, body: parsed.body },
		});
	}
	if (eligiblePages.length === 0) return { updated, rejected };

	const selectionInputs: EvidenceSelectionInput[] = eligiblePages.map(({ pagePath, parsed }) => ({
		pagePath,
		pageBody: parsed.body,
		sourceId: input.entry.id,
		blocks: indexResult.index.blocks,
	}));
	let outcomes: MutableEvidenceSelectionOutcome[];
	if (input.selector.selectMany) {
		try {
			const selected = await input.selector.selectMany(selectionInputs);
			if (selected.length !== selectionInputs.length) {
				outcomes = selectionInputs.map(() => ({
					candidates: [],
					codes: ["selector-malformed-response" as EvidenceSelectionCode],
					rejected: 1,
				}));
			} else {
				outcomes = selected.map((outcome) => ({
					candidates: Array.isArray(outcome.candidates) ? outcome.candidates : [],
					codes: safeSelectionCodes(outcome.codes),
					rejected: Number.isSafeInteger(outcome.rejected) && outcome.rejected >= 0 ? outcome.rejected : 1,
				}));
			}
		} catch {
			outcomes = selectionInputs.map(() => ({
				candidates: [],
				codes: ["selector-error" as EvidenceSelectionCode],
				rejected: 1,
			}));
		}

		// A batch failure with no usable candidates is retried per-page so a
		// malformed batch cannot starve every concept page of evidence.
		await Promise.all(selectionInputs.map(async (selectionInput, pageIndex) => {
			const outcome = outcomes[pageIndex];
			const hasFailure = outcome.codes.some((code) => code !== "selector-zero-candidates");
			if (!hasFailure || outcome.candidates.length > 0) return;
			try {
				const candidates = await input.selector!.select(selectionInput);
				if (candidates.length > 0) {
					outcome.candidates = [...candidates];
					outcome.codes = [];
					outcome.rejected = 0;
				}
				// On empty candidates, keep the original batch failure code so
				// existing model refs are preserved: a per-page empty result is
				// not treated as an authoritative "no evidence" signal here.
			} catch {
				outcome.codes = ["selector-error"];
				outcome.rejected = 1;
			}
		}));
	} else {
		outcomes = await Promise.all(selectionInputs.map(async () => ({
			candidates: [],
			codes: [] as EvidenceSelectionCode[],
			rejected: 0,
		})));
		await Promise.all(selectionInputs.map(async (selectionInput, pageIndex) => {
			try {
				outcomes[pageIndex].candidates = [...await input.selector!.select(selectionInput)];
				if (outcomes[pageIndex].candidates.length === 0) {
					outcomes[pageIndex].codes.push("selector-zero-candidates");
				}
			} catch {
				outcomes[pageIndex].codes.push("selector-error");
				outcomes[pageIndex].rejected = 1;
			}
		}));
	}

	const queue = getWikiPageWriteQueue(input.l2DataDir);
	for (const [pageIndex, page] of eligiblePages.entries()) {
		const selection = outcomes[pageIndex];
		rejected += selection.rejected;
		for (const code of selection.codes) {
			logger.warn(
				{ sourceId: input.entry.id, pagePath: page.pagePath, code },
				"L2 evidence selection outcome",
			);
		}
		// A provider/auth/network failure with no usable candidates is not an
		// authoritative "no evidence" result. Keep existing model refs so a
		// transient outage cannot erase a previously verified traceability link.
		// If the batch contains usable candidates alongside malformed entries,
		// still resolve those candidates; the selector deliberately reports
		// partial success so one bad item cannot discard good evidence.
		const hasSelectionFailure = selection.codes.some((code) => code !== "selector-zero-candidates");
		if (hasSelectionFailure && selection.candidates.length === 0) continue;

		const publication = await queue.run(page.pagePath, () => {
			const currentContent = readText(page.absolutePath);
			if (fileRevision(Buffer.from(currentContent, "utf8")) !== page.fileRevision) {
				logger.warn(
					{ sourceId: input.entry.id, pagePath: page.pagePath, code: "page-changed-during-selection" },
					"L2 evidence publication skipped",
				);
				return { updated: false, rejected: 0 };
			}
			const current = parseFrontmatter(currentContent);
			if (!current.frontmatter || !current.frontmatter.source_ids.includes(input.entry.id)) {
				return { updated: false, rejected: 0 };
			}
			const resolution = resolveEvidenceCandidates(selection.candidates, {
				sourceId: input.entry.id,
				sourceRevision: `sha256:${input.entry.rawContentHash}`,
				pageRevision: bodyRevision(current.body),
				index: indexResult.index,
				...(input.canonicalReferences === undefined ? {} : { canonicalReferences: input.canonicalReferences }),
			});
			for (const failure of resolution.rejected) {
				logger.warn(
					{
						...(failure.sourceId === undefined ? {} : { sourceId: failure.sourceId }),
						...(failure.blockId === undefined ? {} : { blockId: failure.blockId }),
						code: failure.code,
					},
					"L2 evidence candidate rejected",
				);
			}

			const previousReferences = Array.isArray(current.frontmatter.evidence_refs)
				? current.frontmatter.evidence_refs
				: [];
			const nextReferences = [
				...preservedReferences(current.frontmatter, input.entry.id),
				...resolution.accepted,
			];
			if (JSON.stringify(previousReferences) === JSON.stringify(nextReferences)) {
				return { updated: false, rejected: resolution.rejected.length };
			}

			const content = `${serializeFrontmatter(withEvidenceReferences(current.frontmatter, nextReferences))}\n${current.body}`;
			writeText(page.absolutePath, content);
			return { updated: true, rejected: resolution.rejected.length };
		});
		rejected += publication.rejected;
		if (publication.updated) updated.push(page.pagePath);
	}

	return { updated, rejected };
}

export interface AttachGroundedCitationsInput {
	l2DataDir: string;
	entry: ManifestEntry;
	pagePath: string;
	citations: readonly GroundedCitationInput[];
}

/**
 * Attach grounded citations (with inline markers) to a single source-summary
 * page whose body already contains `[n]` markers emitted by the summarizer.
 *
 * Each citation is bound to a unique evidence block; accepted refs carry the
 * marker so the UI can turn the matching `[n]` in the body into a jump link.
 * Reuses the same page-revision / index-revision guards as card-only evidence.
 */
export function attachGroundedCitations(
	input: AttachGroundedCitationsInput,
): { updated: boolean; accepted: number; rejected: number } {
	const absolutePath = join(input.l2DataDir, input.pagePath);
	if (!fileExists(absolutePath)) return { updated: false, accepted: 0, rejected: 0 };
	const original = readText(absolutePath);
	const parsed = parseFrontmatter(original);
	if (!parsed.frontmatter || !parsed.frontmatter.source_ids.includes(input.entry.id)) {
		return { updated: false, accepted: 0, rejected: 0 };
	}
	if (!input.entry.rawContentHash) return { updated: false, accepted: 0, rejected: 0 };

	const indexResult = readEvidenceIndex(input.l2DataDir, input.entry.id, input.entry.rawContentHash);
	if (indexResult.status !== "ready") return { updated: false, accepted: 0, rejected: 0 };
	const rejectGroundedSet = (): { updated: boolean; accepted: number; rejected: number } => {
		const nextReferences = preservedReferences(parsed.frontmatter!, input.entry.id);
		const nextBody = stripEvidenceMarkers(parsed.body);
		const content = `${serializeFrontmatter(withEvidenceReferences(parsed.frontmatter!, nextReferences))}\n${nextBody}`;
		const updated = content !== original;
		if (updated) writeText(absolutePath, content);
		return { updated, accepted: 0, rejected: input.citations.length };
	};
	if (!evidenceMarkersMatch(parsed.body, input.citations.map((citation) => citation.marker))) {
		return rejectGroundedSet();
	}

	const resolution = resolveGroundedCitations(input.citations, {
		sourceId: input.entry.id,
		sourceRevision: `sha256:${input.entry.rawContentHash}`,
		pageRevision: bodyRevision(parsed.body),
		index: indexResult.index,
	});

	for (const failure of resolution.rejected) {
		logger.warn(
			{
				...(failure.sourceId === undefined ? {} : { sourceId: failure.sourceId }),
				code: failure.code,
			},
			"L2 grounded citation rejected",
		);
	}

	if (resolution.rejected.length > 0 || resolution.accepted.length !== input.citations.length) {
		return rejectGroundedSet();
	}
	if (resolution.accepted.length === 0) {
		return { updated: false, accepted: 0, rejected: resolution.rejected.length };
	}

	const nextReferences = [
		...preservedReferences(parsed.frontmatter, input.entry.id),
		...resolution.accepted,
	];
	const content = `${serializeFrontmatter(withEvidenceReferences(parsed.frontmatter, nextReferences))}\n${parsed.body}`;
	writeText(absolutePath, content);
	return { updated: true, accepted: resolution.accepted.length, rejected: resolution.rejected.length };
}
