import type {
	EvidenceLocator,
	PositionReasonCode,
	ResolvedEvidenceReference,
	SourceProvenanceGroup,
	SourceViewerTarget,
	WikiPageDetail,
} from "../../types/wiki.js";
import { parseFrontmatter } from "../../utils/frontmatter.js";
import { marked, type Token, type Tokens } from "marked";

export interface SummaryEvidenceIdentity {
	sourceId: string;
	quote: string;
	locator: EvidenceLocator;
}

export interface SummaryNavigationIntent extends SummaryEvidenceIdentity {
	originPath: string;
	candidateSummaryPaths: string[];
	originActionId?: string;
}

export type SummaryResolution =
	| { status: "located"; page: WikiPageDetail; marker: number }
	| { status: "not-found" | "ambiguous-marker"; page: WikiPageDetail }
	| { status: "no-summary" | "ambiguous-summary" };

type ReadySource = Extract<SourceProvenanceGroup, { availability: "ready" }>;

const SOURCE_SUMMARY_PATH = /^wiki\/sources\/[^/\\]+\.md$/u;

export function sourceSummaryPaths(sources: readonly string[]): string[] {
	const seen = new Set<string>();
	const paths: string[] = [];
	for (const source of sources) {
		if (!SOURCE_SUMMARY_PATH.test(source) || seen.has(source)) continue;
		seen.add(source);
		paths.push(source);
	}
	return paths;
}

export function normalizeCitationIdentityText(value: string): string {
	return normalizeVisibleText(plainTokenList(marked.lexer(value)));
}

function matchesLocatorPosition(reference: EvidenceLocator, identity: EvidenceLocator): boolean {
	if (reference.kind !== identity.kind) return false;
	if (identity.kind === "pdf-page") {
		return reference.kind === "pdf-page" && reference.page === identity.page;
	}
	if (reference.kind === "pdf-page" || reference.paragraph !== identity.paragraph) return false;
	return identity.heading === undefined || reference.heading === identity.heading;
}

function plainTokenText(token: Token): string {
	switch (token.type) {
		case "space":
		case "br":
		case "hr":
			return "\n";
		case "def":
			return "";
		case "code":
			return (token as Tokens.Code).text;
		case "codespan":
			return (token as Tokens.Codespan).text;
		case "escape":
			return (token as Tokens.Escape).text;
		case "html":
			return token.raw;
		case "image":
			return (token as Tokens.Image).text;
		case "list": {
			const list = token as Tokens.List;
			return list.items.map((item: Tokens.ListItem) => plainTokenList(item.tokens)).join("\n");
		}
		case "table": {
			const table = token as Tokens.Table;
			return [table.header, ...table.rows]
				.map((row: Tokens.TableCell[]) => row.map((cell: Tokens.TableCell) => plainTokenList(cell.tokens)).join(" "))
				.join("\n");
		}
		default: {
			const withChildren = token as Token & { text?: string; tokens?: Token[] };
			return withChildren.tokens?.length ? plainTokenList(withChildren.tokens) : (withChildren.text ?? token.raw);
		}
	}
}

function plainTokenList(tokens: readonly Token[]): string {
	return tokens.map(plainTokenText).join("");
}

function normalizeVisibleText(value: string): string {
	return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function hasValidMarker(reference: ResolvedEvidenceReference): reference is ResolvedEvidenceReference & { marker: number } {
	return Number.isSafeInteger(reference.marker) && (reference.marker ?? 0) > 0;
}

function markerClaimCount(page: WikiPageDetail, marker: number): number {
	let count = 0;
	for (const group of page.provenance?.sourceGroups ?? []) {
		for (const reference of group.references) {
			if (reference.marker === marker) count += 1;
		}
	}
	return count;
}

export function resolveSummaryNavigation(
	candidates: readonly WikiPageDetail[],
	identity: SummaryEvidenceIdentity,
): SummaryResolution {
	const matchingGroups: Array<{ page: WikiPageDetail; group: ReadySource }> = [];

	for (const page of candidates) {
		if (parseFrontmatter(page.content).frontmatter?.type !== "source-summary") continue;
		for (const group of page.provenance?.sourceGroups ?? []) {
			if (group.availability === "ready" && group.sourceId === identity.sourceId) {
				matchingGroups.push({ page, group });
			}
		}
	}

	if (matchingGroups.length === 0) return { status: "no-summary" };
	if (matchingGroups.length !== 1) return { status: "ambiguous-summary" };

	const [{ page, group }] = matchingGroups;
	const normalizedQuote = normalizeCitationIdentityText(identity.quote);
	const references = group.references.filter((reference) => (
		reference.locator.block_id === identity.locator.block_id
		&& normalizeCitationIdentityText(reference.quote) === normalizedQuote
		&& matchesLocatorPosition(reference.locator, identity.locator)
	));

	if (references.length === 0) return { status: "not-found", page };
	if (references.length !== 1) return { status: "ambiguous-marker", page };

	const [reference] = references;
	if (!hasValidMarker(reference)) return { status: "not-found", page };
	if (markerClaimCount(page, reference.marker) !== 1) return { status: "ambiguous-marker", page };
	return { status: "located", page, marker: reference.marker };
}

export function canUseExactTarget(status: "verified" | PositionReasonCode): boolean {
	return status === "verified"
		|| status === "stale-page"
		|| status === "locator-invalid"
		|| status === "quote-mismatch"
		|| status === "drifted";
}

export function targetForReadySource(
	group: ReadySource,
	reference?: ResolvedEvidenceReference,
): SourceViewerTarget {
	if (reference && canUseExactTarget(reference.positionStatus)) {
		return {
			mode: "exact",
			sourceId: group.sourceId,
			title: group.title,
			sourceType: group.sourceType,
			...(group.rawKind === undefined ? {} : { rawKind: group.rawKind }),
			sourceRevision: group.sourceRevision,
			quote: reference.quote,
			locator: reference.locator,
			positionStatus: reference.positionStatus,
			indexVersion: 1,
		};
	}
	return {
		mode: "file",
		sourceId: group.sourceId,
		title: group.title,
		sourceType: group.sourceType,
		...(group.rawKind === undefined ? {} : { rawKind: group.rawKind }),
		sourceRevision: group.sourceRevision,
	};
}

export function buildMarkerTargets(page: WikiPageDetail): Map<number, SourceViewerTarget> {
	const claimCounts = new Map<number, number>();
	for (const group of page.provenance?.sourceGroups ?? []) {
		for (const reference of group.references) {
			if (!hasValidMarker(reference)) continue;
			claimCounts.set(reference.marker, (claimCounts.get(reference.marker) ?? 0) + 1);
		}
	}

	const targets = new Map<number, SourceViewerTarget>();
	for (const group of page.provenance?.sourceGroups ?? []) {
		if (group.availability !== "ready") continue;
		for (const reference of group.references) {
			if (!hasValidMarker(reference) || claimCounts.get(reference.marker) !== 1) continue;
			targets.set(reference.marker, targetForReadySource(group, reference));
		}
	}
	return targets;
}
