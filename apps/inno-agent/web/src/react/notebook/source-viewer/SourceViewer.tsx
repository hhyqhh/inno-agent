import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ArrowLeft, Download } from "lucide-react";
import { ApiError } from "../../../api/client.js";
import { getSourceContent, getSourceEvidence, locateSourceQuote } from "../../../api/wiki.js";
import type {
	EvidenceBlock,
	EvidenceLocator,
	EvidenceSliceResponse,
	LocateMatch,
	SourceViewerTarget,
} from "../../../types/wiki.js";
import { DocxSourceView } from "./DocxSourceView.js";
import { EvidenceTextView } from "./EvidenceTextView.js";
import { MarkdownSourceView, evidenceBlocksInDocumentOrder } from "./MarkdownSourceView.js";
import { PdfSourceView } from "./PdfSourceView.js";
import { findTextOffsetsAtOccurrence, findUniqueTextOffsets } from "./text-highlight.js";

export interface SourceViewerProps {
	target: SourceViewerTarget;
	onBack(): void;
}

type ResolutionState = "direct" | "drifted" | "ambiguous" | "ambiguous-text" | "not-found";

interface ViewerState {
	loading: boolean;
	evidence?: EvidenceSliceResponse;
	content?: ArrayBuffer | string;
	candidates: LocateMatch[];
	resolution: ResolutionState;
	activeLocator?: EvidenceLocator;
	activeOccurrence?: number;
	error?: string;
}

const INITIAL_STATE: ViewerState = {
	loading: true,
	candidates: [],
	resolution: "direct",
};

function locatorLabel(locator: EvidenceLocator, t: TFunction): string {
	if (locator.kind === "pdf-page") return t("notebook.page.sourceViewer.location.page", { page: locator.page });
	if (locator.heading) return t("notebook.page.sourceViewer.location.headingParagraph", { heading: locator.heading, paragraph: locator.paragraph });
	return t("notebook.page.sourceViewer.location.paragraph", { paragraph: locator.paragraph });
}

function candidateLabel(candidate: LocateMatch, t: TFunction): string {
	const location = locatorLabel(candidate.locator, t);
	return candidate.occurrence !== undefined && candidate.occurrenceCount !== undefined
		? `${location} (${candidate.occurrence}/${candidate.occurrenceCount})`
		: location;
}

function targetLocation(target: SourceViewerTarget, t: TFunction): string {
	return target.mode === "exact" ? locatorLabel(target.locator, t) : t("notebook.page.sourceViewer.location.file");
}

function needsContent(target: SourceViewerTarget): boolean {
	if (target.sourceType === "word" || target.sourceType === "markdown") return true;
	return target.mode === "file" && ["markdown", "text", "conversation"].includes(target.sourceType);
}

async function readSourceContent(target: SourceViewerTarget, signal: AbortSignal): Promise<ArrayBuffer | string | undefined> {
	if (!needsContent(target)) return undefined;
	const response = await getSourceContent(target.sourceId, target.sourceRevision, { signal });
	return target.sourceType === "word" ? response.arrayBuffer() : response.text();
}

async function directEvidence(
	target: Extract<SourceViewerTarget, { mode: "exact" }>,
	signal: AbortSignal,
): Promise<EvidenceSliceResponse> {
	return getSourceEvidence(target.sourceId, target.locator.block_id, target.sourceRevision, { signal });
}

async function relocatedEvidence(target: Extract<SourceViewerTarget, { mode: "exact" }>, signal: AbortSignal): Promise<{
	evidence?: EvidenceSliceResponse;
	candidates: LocateMatch[];
	resolution: ResolutionState;
	activeLocator?: EvidenceLocator;
	activeOccurrence?: number;
}> {
	const located = await locateSourceQuote(target.sourceId, {
		quote: target.quote,
		sourceRevision: target.sourceRevision,
		indexVersion: target.indexVersion,
	}, target.sourceRevision, { signal });
	if (located.matches.length === 1) {
		const match = located.matches[0];
		const locator = match.locator;
		const evidence = await getSourceEvidence(target.sourceId, locator.block_id, target.sourceRevision, { signal });
		const textMatch = match.occurrence === undefined
			? findUniqueTextOffsets(evidence.target.text, target.quote)
			: findTextOffsetsAtOccurrence(evidence.target.text, target.quote, match.occurrence);
		return {
			evidence,
			candidates: [],
			resolution: textMatch.status === "unique"
				? "drifted"
				: textMatch.status === "ambiguous" ? "ambiguous-text" : "not-found",
			activeLocator: locator,
			...(textMatch.status === "unique" && match.occurrence !== undefined ? { activeOccurrence: match.occurrence } : {}),
		};
	}
	if (located.matches.length > 1) {
		return {
			candidates: located.matches,
			resolution: "ambiguous",
		};
	}

	const fallbackLocator = located.fallbackLocator ?? target.locator;
	const evidence = located.fallbackLocator === undefined
		? undefined
		: await getSourceEvidence(target.sourceId, fallbackLocator.block_id, target.sourceRevision, { signal });
	return { evidence, candidates: [], resolution: "not-found", activeLocator: fallbackLocator };
}

function invalidBlockError(error: unknown): boolean {
	return error instanceof ApiError && error.code === "invalid_block_id";
}

async function resolveExactEvidence(
	target: Extract<SourceViewerTarget, { mode: "exact" }>,
	signal: AbortSignal,
): Promise<Pick<ViewerState, "evidence" | "candidates" | "resolution" | "activeLocator" | "activeOccurrence">> {
	if (shouldRelocate(target)) return relocatedEvidence(target, signal);
	let evidence: EvidenceSliceResponse;
	try {
		evidence = await directEvidence(target, signal);
	} catch (error) {
		if (invalidBlockError(error)) return relocatedEvidence(target, signal);
		throw error;
	}
	const textMatch = findUniqueTextOffsets(evidence.target.text, target.quote);
	if (textMatch.status === "unique") {
		return { evidence, candidates: [], resolution: "direct", activeLocator: target.locator };
	}
	if (textMatch.status === "ambiguous") {
		return { evidence, candidates: [], resolution: "ambiguous-text", activeLocator: target.locator };
	}
	return relocatedEvidence(target, signal);
}

function shouldRelocate(target: Extract<SourceViewerTarget, { mode: "exact" }>): boolean {
	return target.positionStatus === "locator-invalid"
		|| target.positionStatus === "quote-mismatch"
		|| target.positionStatus === "drifted";
}

function safeDownloadName(title: string): string {
	const safe = title.replace(/[\u0000-\u001f<>:"/\\|?*]+/gu, "_").trim();
	return safe.length > 0 ? safe : "source";
}

function textContentBlock(content: string, sourceType: SourceViewerTarget["sourceType"]): EvidenceBlock {
	return {
		id: "source:file",
		kind: sourceType === "word" ? "docx" : sourceType === "pdf" ? "pdf" : "markdown",
		text: content,
		paragraph: 1,
	};
}

function pdfPageFor(target: SourceViewerTarget, activeLocator?: EvidenceLocator): number {
	if (activeLocator?.kind === "pdf-page") return activeLocator.page;
	if (target.mode === "exact" && target.locator.kind === "pdf-page") return target.locator.page;
	return 1;
}

export function SourceViewer({ target, onBack }: SourceViewerProps) {
	const { t } = useTranslation();
	const [state, setState] = useState<ViewerState>(INITIAL_STATE);
	const [downloadError, setDownloadError] = useState<string>();
	const [downloading, setDownloading] = useState(false);
	const loadControllerRef = useRef<AbortController | undefined>(undefined);
	const downloadControllerRef = useRef<AbortController | undefined>(undefined);
	const headingRef = useRef<HTMLHeadingElement>(null);

	useEffect(() => {
		loadControllerRef.current?.abort();
		downloadControllerRef.current?.abort();
		const controller = new AbortController();
		loadControllerRef.current = controller;
		setState(INITIAL_STATE);
		setDownloadError(undefined);
		setDownloading(false);

		void (async () => {
			const emptyEvidenceResult: Pick<ViewerState, "evidence" | "candidates" | "resolution" | "activeLocator" | "activeOccurrence"> = {
				candidates: [],
				resolution: "direct",
			};
			const evidencePromise = target.mode === "exact"
				? resolveExactEvidence(target, controller.signal)
				: Promise.resolve(emptyEvidenceResult);
			const contentPromise = readSourceContent(target, controller.signal);
			const [evidenceOutcome, contentOutcome] = await Promise.allSettled([evidencePromise, contentPromise]);
			if (controller.signal.aborted) return;

			const evidenceResult = evidenceOutcome.status === "fulfilled"
				? evidenceOutcome.value
				: emptyEvidenceResult;
			const content = contentOutcome.status === "fulfilled" ? contentOutcome.value : undefined;
			const errors = [
				evidenceOutcome.status === "rejected" ? evidenceOutcome.reason : undefined,
				contentOutcome.status === "rejected" ? contentOutcome.reason : undefined,
			]
				.filter((error): error is unknown => error !== undefined)
				.map((error) => error instanceof Error ? error.message : t("notebook.page.sourceViewer.error.openSource"));
			setState({
				loading: false,
				content,
				...evidenceResult,
				...(errors.length > 0 ? { error: errors.join(" ") } : {}),
			});
		})();

		return () => {
			controller.abort();
			if (loadControllerRef.current !== controller) loadControllerRef.current?.abort();
			loadControllerRef.current = undefined;
		};
	}, [target, t]);

	useEffect(() => {
		headingRef.current?.focus();
	}, [target]);

	useEffect(() => () => downloadControllerRef.current?.abort(), []);

	const chooseCandidate = async (candidate: LocateMatch): Promise<void> => {
		if (target.mode !== "exact") return;
		const locator = candidate.locator;
		loadControllerRef.current?.abort();
		const controller = new AbortController();
		loadControllerRef.current = controller;
		setState((current) => ({ ...current, loading: true, error: undefined }));
		try {
			const evidence = await getSourceEvidence(target.sourceId, locator.block_id, target.sourceRevision, {
				signal: controller.signal,
			});
			if (controller.signal.aborted) return;
			const textMatch = candidate.occurrence === undefined
				? findUniqueTextOffsets(evidence.target.text, target.quote)
				: findTextOffsetsAtOccurrence(evidence.target.text, target.quote, candidate.occurrence);
			setState((current) => ({
				...current,
				loading: false,
				evidence,
				candidates: [],
				resolution: textMatch.status === "unique"
					? "drifted"
					: textMatch.status === "ambiguous" ? "ambiguous-text" : "not-found",
				activeLocator: locator,
				...(textMatch.status === "unique" && candidate.occurrence !== undefined ? { activeOccurrence: candidate.occurrence } : { activeOccurrence: undefined }),
			}));
		} catch (error) {
			if (controller.signal.aborted) return;
			setState((current) => ({
				...current,
				loading: false,
				error: error instanceof Error ? error.message : t("notebook.page.sourceViewer.error.openLocation"),
			}));
		} finally {
			if (loadControllerRef.current === controller) loadControllerRef.current = undefined;
		}
	};

	const downloadOriginal = async (): Promise<void> => {
		downloadControllerRef.current?.abort();
		const controller = new AbortController();
		downloadControllerRef.current = controller;
		setDownloading(true);
		setDownloadError(undefined);
		try {
			const response = await getSourceContent(target.sourceId, target.sourceRevision, { signal: controller.signal });
			const blob = await response.blob();
			if (controller.signal.aborted) return;
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = safeDownloadName(target.title);
			anchor.rel = "noopener noreferrer";
			anchor.click();
			URL.revokeObjectURL(url);
		} catch (error) {
			if (!controller.signal.aborted) {
				setDownloadError(error instanceof Error ? error.message : t("notebook.page.sourceViewer.error.download"));
			}
		} finally {
			if (!controller.signal.aborted) setDownloading(false);
		}
	};

	const exactQuote = target.mode === "exact"
		&& state.resolution !== "not-found"
		&& state.resolution !== "ambiguous"
		&& state.resolution !== "ambiguous-text"
		? target.quote
		: undefined;
	const shownLocation = state.activeLocator ? locatorLabel(state.activeLocator, t) : targetLocation(target, t);
	const pdfQuote = target.mode === "exact" ? target.quote : undefined;
	const forcePdfFallback = target.mode === "exact"
		&& (!state.evidence || state.resolution === "not-found" || state.resolution === "ambiguous" || state.resolution === "ambiguous-text");
	// Never render the full Word layout after an untrusted resolution. When the
	// API has no fallback block, DocxSourceView still shows the explicit empty
	// evidence state instead of implying that the document was located safely.
	const forceDocxFallback = forcePdfFallback;

	return (
		<section
			className="flex h-full min-h-0 flex-col bg-[var(--inno-surface)]"
			aria-label={t("notebook.page.sourceViewer.region")}
			onKeyDown={(event) => { if (event.key === "Escape") onBack(); }}
		>
			<header className="flex min-h-14 flex-wrap items-center gap-3 border-b border-[var(--inno-border)] px-3 py-2">
				<button
					type="button"
					className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]"
					aria-label={t("notebook.page.sourceViewer.back")}
					title={t("notebook.page.sourceViewer.back")}
					onClick={onBack}
				>
					<ArrowLeft aria-hidden="true" size={18} />
				</button>
				<div className="min-w-0 flex-1">
					<h2 ref={headingRef} tabIndex={-1} className="truncate text-sm font-semibold text-[var(--inno-text)]">{target.title}</h2>
					<div className="truncate text-xs text-[var(--inno-text-muted)]">{shownLocation}</div>
				</div>
				<button
					type="button"
					className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-[var(--inno-border)] px-2.5 py-1.5 text-xs text-[var(--inno-text)] hover:border-[var(--inno-accent)] disabled:opacity-50"
					disabled={downloading}
					aria-label={t("notebook.page.sourceViewer.download")}
					onClick={() => void downloadOriginal()}
				>
					<Download aria-hidden="true" size={14} />
					{downloading ? t("notebook.page.sourceViewer.downloading") : t("notebook.page.sourceViewer.download")}
				</button>
			</header>

			{target.mode === "exact" && target.positionStatus === "stale-page" ? (
				<div role="status" className="border-b border-[var(--inno-warning)] bg-[var(--inno-warning-bg)] px-4 py-2 text-sm text-[var(--inno-text)]">
					{t("notebook.page.sourceViewer.status.stalePage")}
				</div>
			) : null}
			{state.resolution === "drifted" ? (
				<div role="status" className="border-b border-[var(--inno-warning)] bg-[var(--inno-warning-bg)] px-4 py-2 text-sm text-[var(--inno-text)]">
				{t("notebook.page.sourceViewer.status.drifted")}
				</div>
			) : null}
			{state.resolution === "ambiguous" ? (
				<div role="alert" className="border-b border-[var(--inno-warning)] bg-[var(--inno-warning-bg)] px-4 py-3 text-sm text-[var(--inno-text)]">
					<div className="mb-2">{t("notebook.page.sourceViewer.status.ambiguous")}</div>
					<div className="flex flex-wrap gap-2">
						{state.candidates.map((candidate, index) => (
							<button
								type="button"
								key={`${candidate.locator.block_id}-${candidate.occurrence ?? index}`}
								className="rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] px-2.5 py-1.5 text-xs hover:border-[var(--inno-accent)]"
								aria-label={t("notebook.page.sourceViewer.status.candidateAria", { index: index + 1, location: candidateLabel(candidate, t) })}
								onClick={() => void chooseCandidate(candidate)}
							>
								{candidateLabel(candidate, t)}
							</button>
						))}
					</div>
				</div>
			) : null}
			{state.resolution === "not-found" ? (
				<div role="alert" className="border-b border-[var(--inno-warning)] bg-[var(--inno-warning-bg)] px-4 py-2 text-sm text-[var(--inno-text)]">
				{t("notebook.page.sourceViewer.status.notFound")}
				</div>
			) : null}
			{state.resolution === "ambiguous-text" ? (
				<div role="alert" className="border-b border-[var(--inno-warning)] bg-[var(--inno-warning-bg)] px-4 py-2 text-sm text-[var(--inno-text)]">
				{t("notebook.page.sourceViewer.status.ambiguousText")}
				</div>
			) : null}
			{state.error ? (
				<div role="alert" className="border-b border-[var(--inno-danger)] bg-[var(--inno-danger-bg)] px-4 py-2 text-sm text-[var(--inno-danger)]">
					{state.error}
				</div>
			) : null}
			{downloadError ? (
				<div role="alert" className="border-b border-[var(--inno-danger)] bg-[var(--inno-danger-bg)] px-4 py-2 text-sm text-[var(--inno-danger)]">
					{downloadError}
				</div>
			) : null}

			<div className="min-h-0 flex-1">
				{state.loading ? (
					<div className="flex h-full items-center justify-center text-sm text-[var(--inno-text-muted)]" aria-live="polite">
						{t("notebook.page.sourceViewer.opening")}
					</div>
				) : target.sourceType === "word" && state.content instanceof ArrayBuffer ? (
					<DocxSourceView
						content={state.content}
						evidence={state.evidence}
						quote={exactQuote}
						occurrence={state.activeOccurrence}
						forceExtractedFallback={forceDocxFallback}
					/>
				) : target.sourceType === "markdown" && (typeof state.content === "string" || state.evidence) ? (
					<MarkdownSourceView
						content={typeof state.content === "string" ? state.content : undefined}
						evidence={state.evidence}
						quote={exactQuote}
						occurrence={state.activeOccurrence}
					/>
				) : target.sourceType === "pdf" ? (
					<PdfSourceView
						sourceId={target.sourceId}
						sourceRevision={target.sourceRevision}
						page={pdfPageFor(target, state.activeLocator)}
						evidence={state.evidence}
						quote={pdfQuote}
						occurrence={state.activeOccurrence}
						forceExtractedFallback={forcePdfFallback}
					/>
				) : typeof state.content === "string" ? (
					<div className="h-full overflow-y-auto">
						<EvidenceTextView blocks={[textContentBlock(state.content, target.sourceType)]} targetBlockId="source:file" />
					</div>
				) : state.evidence ? (
					<EvidenceTextView
						blocks={evidenceBlocksInDocumentOrder(state.evidence)}
						targetBlockId={state.evidence.target.id}
						quote={exactQuote}
						occurrence={state.activeOccurrence}
					/>
				) : (
					<div className="flex h-full items-center justify-center p-6 text-center text-sm text-[var(--inno-text-muted)]">
						{t("notebook.page.sourceViewer.noPreview")}
					</div>
				)}
			</div>
		</section>
	);
}
