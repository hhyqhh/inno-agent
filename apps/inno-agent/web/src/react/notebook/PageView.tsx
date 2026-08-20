import { useEffect, useRef, useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft } from "lucide-react";
import * as wikiApi from "../../api/wiki.js";
import { notebookStore } from "../../stores/notebook-store.js";
import type { SourceViewerTarget, WikiPageDetail, WikiPageFrontmatter, WikiPageType } from "../../types/wiki.js";
import { parseFrontmatter } from "../../utils/frontmatter.js";
import { normalizeMarkdownMath } from "../../utils/markdown-math.js";
import { useStoreSnapshot } from "../hooks.js";
import "@earendil-works/pi-web-ui";
import { Spinner } from "../ui/Spinner.js";
import { LazyMarkdownEditor } from "../LazyMarkdownEditor.js";
import { ProvenanceSection } from "./ProvenanceSection.js";
import {
	buildMarkerTargets as buildSummaryMarkerTargets,
	resolveSummaryNavigation,
	sourceSummaryPaths,
	type SummaryEvidenceIdentity,
} from "./summary-navigation.js";
import { findCitationSentence, highlightCitationSentence } from "./summary-citation-highlight.js";
import { SourceViewer } from "./source-viewer/SourceViewer.js";

export { buildMarkerTargets } from "./summary-navigation.js";

function typeColor(type?: WikiPageType): string {
	switch (type) {
		case "source-summary":
			return "bg-[var(--inno-accent-soft)] text-[var(--inno-accent)]";
		case "entity":
			return "bg-[var(--inno-success-bg)] text-[var(--inno-success)]";
		case "concept":
			return "bg-[var(--inno-warning-bg)] text-[var(--inno-warning)]";
		case "analysis":
			return "bg-[var(--inno-accent-soft)] text-[var(--inno-accent)]";
		default:
			return "bg-[var(--inno-surface-muted)] text-[var(--inno-text-muted)]";
	}
}

/** Turn `[n]` markers that have a resolved citation into `#evidence-n` links. */
export function injectCitationLinks(body: string, markers: ReadonlyMap<number, SourceViewerTarget>): string {
	if (markers.size === 0) return body;
	const parts = body.split(/(```[\s\S]*?```|`[^`\r\n]*`)/gu);
	return parts.map((part, index) => {
		if (index % 2 === 1) return part;
		return part.replace(/(^|[^\\!^])\[(\d+)\](?!\s*(?:\(|\[|:))/gu, (full, prefix: string, digits: string) => {
			const marker = Number(digits);
			// Entity-encoded brackets keep the visible label as `[n]` without
			// colliding with MarkdownBlock's `\[...\]` display-math extension.
			return markers.has(marker) ? `${prefix}[&#91;${digits}&#93;](#evidence-${marker})` : full;
		});
	}).join("");
}

/** Readable title derived from a source-summary page filename (`slug-<id>.md`). */
function summaryLabel(path: string): string {
	const base = path.split("/").pop() ?? path;
	return base.replace(/-[0-9a-f]{6,8}\.md$/u, "") || base;
}

interface FrontmatterHeaderProps {
	frontmatter: WikiPageFrontmatter;
	page: WikiPageDetail;
	onOpenSource(target: SourceViewerTarget): void;
	onRefreshEvidence(): void;
	onRemoveStaleEvidence(): void;
	mutationPending: boolean;
	mutationKind: "refresh" | "remove-stale" | null;
	maintenanceDisabled: boolean;
	pageLoading: boolean;
	provenanceExpanded: boolean;
	onProvenanceExpandedChange(expanded: boolean): void;
}

function FrontmatterHeader({
	frontmatter,
	page,
	onOpenSource,
	onRefreshEvidence,
	onRemoveStaleEvidence,
	mutationPending,
	mutationKind,
	maintenanceDisabled,
	pageLoading,
	provenanceExpanded,
	onProvenanceExpandedChange,
}: FrontmatterHeaderProps) {
	const { t } = useTranslation();
	const statusColors: Record<string, string> = {
		draft: "bg-[var(--inno-warning-bg)] text-[var(--inno-warning)]",
		reviewed: "bg-[var(--inno-success-bg)] text-[var(--inno-success)]",
		outdated: "bg-[var(--inno-danger-bg)] text-[var(--inno-danger)]",
	};
	const confidenceColors: Record<string, string> = {
		low: "bg-[var(--inno-danger-bg)] text-[var(--inno-danger)]",
		medium: "bg-[var(--inno-warning-bg)] text-[var(--inno-warning)]",
		high: "bg-[var(--inno-success-bg)] text-[var(--inno-success)]",
	};

	return (
		<div className="border-b border-[var(--inno-border)] bg-[var(--inno-surface)] px-4 py-3">
			<h3 className="mb-1.5 truncate text-base font-medium text-[var(--inno-text)]">{frontmatter.title}</h3>
			<div className="flex flex-wrap items-center gap-2 text-xs">
				<span className={`rounded px-1.5 py-0.5 ${typeColor(frontmatter.type)}`}>{t(`notebook.types.${frontmatter.type}`)}</span>
				<span className={`rounded px-1.5 py-0.5 ${statusColors[frontmatter.status] ?? ""}`}>{t(`notebook.status.${frontmatter.status}`)}</span>
				<span className={`rounded px-1.5 py-0.5 ${confidenceColors[frontmatter.confidence] ?? ""}`}>{t(`notebook.confidence.${frontmatter.confidence}`)}</span>
				{frontmatter.contested ? <span className="rounded bg-[var(--inno-danger-bg)] px-1.5 py-0.5 text-[var(--inno-danger)]">{t("notebook.contested")}</span> : null}
				<span className="text-[var(--inno-text-muted)]">{frontmatter.updated}</span>
			</div>
			{frontmatter.tags.length > 0 ? (
				<div className="mt-2 flex flex-wrap gap-1">
					{frontmatter.tags.map((tag) => (
						<span key={tag} className="rounded-full bg-[var(--inno-accent-soft)] px-1.5 py-0.5 text-xs text-[var(--inno-accent)]">
							#{tag}
						</span>
					))}
				</div>
			) : null}
			{sourceSummaryPaths(frontmatter.sources).length > 0 ? (
				<div className="mt-2 flex flex-wrap items-center gap-1.5">
					<span className="text-xs text-[var(--inno-text-muted)]">{t("notebook.types.source-summary")}:</span>
					{sourceSummaryPaths(frontmatter.sources).map((path) => (
						<button
							key={path}
							type="button"
							className="rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] px-2 py-1 text-xs text-[var(--inno-accent)] hover:border-[var(--inno-accent)] disabled:cursor-wait disabled:opacity-50"
							disabled={pageLoading}
							aria-busy={pageLoading}
							onClick={() => void notebookStore.selectPage(path)}
						>
							{summaryLabel(path)}
						</button>
					))}
				</div>
			) : null}
			<ProvenanceSection
				provenance={page.provenance}
				fallbackSources={frontmatter.sources}
				fallbackSourceIds={frontmatter.source_ids}
				onOpenSource={onOpenSource}
				onRefreshEvidence={onRefreshEvidence}
				onRemoveStaleEvidence={onRemoveStaleEvidence}
				pageType={frontmatter.type}
				mutationPending={mutationPending}
				mutationKind={mutationKind}
				maintenanceDisabled={maintenanceDisabled}
				expanded={provenanceExpanded}
				onExpandedChange={onProvenanceExpandedChange}
			/>
		</div>
	);
}

function hasStalePageReference(page: WikiPageDetail): boolean {
	return page.provenance?.sourceGroups.some((group) =>
		group.references.some((reference) =>
			reference.positionStatus === "stale-page" || reference.reasonCodes.includes("stale-page"),
		),
	) ?? false;
}

function PageFeedback({
	saveError,
	mutationError,
	pageLoadError,
	loading,
	page,
}: {
	saveError: string | null;
	mutationError: string | null;
	pageLoadError: string | null;
	loading: boolean;
	page: WikiPageDetail | null;
}) {
	const { t } = useTranslation();
	const stale = page ? hasStalePageReference(page) : false;
	if (!saveError && !mutationError && !pageLoadError && !loading && !stale) return null;
	return (
		<div className="space-y-1 border-b border-[var(--inno-border)] px-4 py-2 text-xs" aria-live="polite">
			{loading ? <p role="status" className="text-[var(--inno-text-muted)]">{t("notebook.page.loading")}</p> : null}
			{stale ? <p role="status" className="text-[var(--inno-warning)]">{t("notebook.page.revisionWarning")}</p> : null}
			{pageLoadError ? <p role="alert" className="text-[var(--inno-danger)]">{t("notebook.page.loadError", { error: pageLoadError })}</p> : null}
			{saveError ? <p role="alert" className="text-[var(--inno-danger)]">{t("notebook.page.saveError", { error: saveError })}</p> : null}
			{mutationError ? <p role="alert" className="text-[var(--inno-danger)]">{t("notebook.page.mutationError", { error: mutationError })}</p> : null}
		</div>
	);
}

type SummaryHopStatus = "loading" | "located" | "not-found" | "ambiguous-marker" | "error";

interface SummaryHopState {
	status: SummaryHopStatus;
	originPath: string;
	summaryPath?: string;
	marker?: number;
	errorKey?: "noSummary" | "ambiguousSummary" | "notFound" | "ambiguousMarker";
	identity: SummaryEvidenceIdentity;
}

export function PageView() {
	const { t } = useTranslation();
	const [viewerTarget, setViewerTarget] = useState<SourceViewerTarget | null>(null);
	const [provenanceExpanded, setProvenanceExpanded] = useState(false);
	const sourceActionRef = useRef<HTMLElement | null>(null);
	const sourceActionId = useRef<string | null>(null);
	const sourceActionLabel = useRef<string | null>(null);
	const sourceActionMarker = useRef<number | null>(null);
	const viewerOriginPath = useRef<string | null>(null);
	const viewerWasOpen = useRef(false);
	const summaryReturnPending = useRef(false);
	const summaryRequestToken = useRef(0);
	const summaryBodyRef = useRef<HTMLDivElement | null>(null);
	const [summaryHop, setSummaryHop] = useState<SummaryHopState | null>(null);
	const [summaryFocusStatus, setSummaryFocusStatus] = useState<"pending" | "located" | "not-found" | "ambiguous" | null>(null);
	const state = useStoreSnapshot(notebookStore, () => ({
		currentPage: notebookStore.currentPage,
		isEditing: notebookStore.isEditing,
		isLoading: notebookStore.isLoadingPage,
		pageLoadError: notebookStore.pageLoadError,
		editBuffer: notebookStore.editBuffer,
		saveError: notebookStore.saveError,
		mutationError: notebookStore.mutationError,
		mutationPending: notebookStore.mutationPending,
		mutationKind: notebookStore.mutationKind,
	}));
	const currentPagePath = state.currentPage?.path ?? null;

	function restoreSourceActionFocus(): void {
		if (sourceActionRef.current?.isConnected) {
			sourceActionRef.current.focus();
			return;
		}
		const actionId = sourceActionId.current;
		if (actionId) {
			const action = [...document.querySelectorAll<HTMLButtonElement>("button[data-provenance-action-id]")]
				.find((button) => button.dataset.provenanceActionId === actionId);
			if (action && action.closest("details")?.hasAttribute("open")) {
				action.focus();
				return;
			}
		}
		const label = sourceActionLabel.current;
		if (label) {
			const action = [...document.querySelectorAll<HTMLButtonElement>("button[aria-label]")]
				.find((button) => {
					const ariaLabel = button.getAttribute("aria-label") ?? "";
					return ariaLabel === label || ariaLabel.includes(label);
				});
			if (action && action.closest("details")?.hasAttribute("open")) {
				action.focus();
				return;
			}
		}
		document.querySelector<HTMLElement>("[data-provenance-summary]")?.focus();
	}

	useEffect(() => {
		const expectedSummaryPath = summaryHop?.summaryPath;
		const isExpectedHopPath = summaryHop !== null
			&& (currentPagePath === summaryHop.originPath || currentPagePath === expectedSummaryPath);
		if (summaryHop && !isExpectedHopPath) {
			summaryRequestToken.current += 1;
			setSummaryHop(null);
			setSummaryFocusStatus(null);
		}
		if (viewerTarget && viewerOriginPath.current !== currentPagePath) {
			setViewerTarget(null);
		}
		if (!summaryReturnPending.current) setProvenanceExpanded(false);
	}, [currentPagePath]);

	useEffect(() => {
		if (!summaryReturnPending.current || !provenanceExpanded) return;
		summaryReturnPending.current = false;
		restoreSourceActionFocus();
	}, [currentPagePath, provenanceExpanded]);

	useEffect(() => {
		if (viewerTarget) {
			viewerWasOpen.current = true;
			return;
		}
		if (viewerWasOpen.current) {
			viewerWasOpen.current = false;
			const shouldRestore = viewerOriginPath.current === currentPagePath;
			viewerOriginPath.current = null;
			if (!shouldRestore) return;
			const marker = sourceActionMarker.current;
			sourceActionMarker.current = null;
			if (marker !== null) {
				const markerHost = document.querySelector<HTMLElement>("[data-citation-marker-host]");
				const focusMarker = () => {
					const anchor = document.querySelector<HTMLAnchorElement>(`a[href="#evidence-${marker}"]`);
					if (!anchor?.isConnected) return false;
					anchor.focus();
					return true;
				};
				if (focusMarker()) return;
				if (markerHost && typeof MutationObserver !== "undefined") {
					let finished = false;
					const finish = (fallback: boolean) => {
						if (finished) return;
						finished = true;
						observer.disconnect();
						clearTimeout(timeout);
						if (fallback) markerHost.focus();
					};
					const observer = new MutationObserver(() => {
						if (focusMarker()) finish(false);
					});
					observer.observe(markerHost, { childList: true, subtree: true });
					const timeout = setTimeout(() => finish(true), 2000);
					return () => finish(false);
				}
				markerHost?.focus();
				return;
			}
			restoreSourceActionFocus();
		}
	}, [currentPagePath, viewerTarget]);

	function rememberSourceOrigin(target: SourceViewerTarget, origin?: HTMLElement): void {
		const active = origin ?? (typeof document !== "undefined" ? document.activeElement : null);
		sourceActionRef.current = active instanceof HTMLElement ? active : null;
		sourceActionId.current = sourceActionRef.current instanceof HTMLButtonElement
			? sourceActionRef.current.dataset.provenanceActionId ?? null
			: null;
		sourceActionLabel.current = sourceActionRef.current?.getAttribute("aria-label") ?? target.title;
		sourceActionMarker.current = origin?.matches('a[href^="#evidence-"]')
			? Number(origin.getAttribute("href")?.slice("#evidence-".length))
			: null;
		viewerOriginPath.current = currentPagePath;
	}

	function openViewer(target: SourceViewerTarget, origin?: HTMLElement): void {
		rememberSourceOrigin(target, origin);
		setViewerTarget(target);
	}

	async function openSource(target: SourceViewerTarget, origin?: HTMLElement): Promise<void> {
		const page = state.currentPage;
		const frontmatter = page ? parseFrontmatter(page.content).frontmatter : null;
		if (target.mode !== "exact" || !page || !frontmatter || frontmatter.type === "source-summary") {
			openViewer(target, origin);
			return;
		}

		const identity: SummaryEvidenceIdentity = {
			sourceId: target.sourceId,
			quote: target.quote,
			locator: target.locator,
		};
		const originPath = page.path;
		rememberSourceOrigin(target, origin);
		const candidatePaths = sourceSummaryPaths(frontmatter.sources);
		const token = ++summaryRequestToken.current;
		setSummaryFocusStatus("pending");
		const failSummaryNavigation = async (
			errorKey: NonNullable<SummaryHopState["errorKey"]>,
			summaryPath?: string,
		): Promise<void> => {
			setSummaryFocusStatus(null);
			if (notebookStore.currentPage?.path !== originPath) {
				let restored: WikiPageDetail | undefined;
				try {
					restored = await notebookStore.selectPage(originPath, { preserveCurrentOnError: true });
				} catch {
					// Keep the selected summary reachable with an error and back action.
				}
				if (token !== summaryRequestToken.current) return;
				if (restored?.path === originPath || notebookStore.currentPage?.path === originPath) {
					setSummaryHop({ status: "error", originPath, identity, errorKey });
					summaryReturnPending.current = true;
					setProvenanceExpanded(true);
					return;
				}
			}
			setSummaryHop({ status: "error", originPath, summaryPath, identity, errorKey });
			if (notebookStore.currentPage?.path === originPath) restoreSourceActionFocus();
		};
		if (candidatePaths.length === 0) {
			await failSummaryNavigation("noSummary");
			return;
		}
		setSummaryHop({ status: "loading", originPath, identity });
		let intendedSummaryPath: string | undefined;

		try {
			const candidateResults = await Promise.allSettled(candidatePaths.map((path) => wikiApi.getWikiPage(path)));
			const candidates = candidateResults.flatMap((result) => (
				result.status === "fulfilled" ? [result.value] : []
			));
			if (token !== summaryRequestToken.current || notebookStore.currentPage?.path !== originPath) return;
			const resolution = resolveSummaryNavigation(candidates, identity);
			if (resolution.status === "no-summary" || resolution.status === "ambiguous-summary") {
				await failSummaryNavigation(
					resolution.status === "no-summary" ? "noSummary" : "ambiguousSummary",
				);
				return;
			}

			if (!("page" in resolution)) return;
			const summaryPage = resolution.page;
			intendedSummaryPath = summaryPage.path;
			setSummaryHop({
				status: resolution.status,
				originPath,
				summaryPath: summaryPage.path,
				...(resolution.status === "located" ? { marker: resolution.marker } : {}),
				identity,
			});
			const selected = await notebookStore.selectPage(summaryPage.path, { preserveCurrentOnError: true });
			if (token !== summaryRequestToken.current) return;
			if (!selected || notebookStore.currentPage?.path !== summaryPage.path) {
				await failSummaryNavigation("noSummary", summaryPage.path);
				return;
			}

			const selectedResolution = resolveSummaryNavigation([selected], identity);
			if (selectedResolution.status === "no-summary" || selectedResolution.status === "ambiguous-summary") {
				await failSummaryNavigation(
					selectedResolution.status === "no-summary" ? "noSummary" : "ambiguousSummary",
					summaryPage.path,
				);
				return;
			}
			if (!("page" in selectedResolution) || selectedResolution.page.path !== summaryPage.path) {
				await failSummaryNavigation("noSummary", summaryPage.path);
				return;
			}

			setSummaryHop({
				status: selectedResolution.status,
				originPath,
				summaryPath: selectedResolution.page.path,
				...(selectedResolution.status === "located" ? { marker: selectedResolution.marker } : {}),
				identity,
			});
			if (selectedResolution.status === "located") {
				setSummaryFocusStatus("pending");
			} else {
				setSummaryFocusStatus(selectedResolution.status === "not-found" ? "not-found" : "ambiguous");
			}
		} catch {
			if (token !== summaryRequestToken.current) return;
			await failSummaryNavigation("noSummary", intendedSummaryPath);
		}
	}

	async function returnToOrigin(): Promise<void> {
		const hop = summaryHop;
		if (!hop) return;
		const token = ++summaryRequestToken.current;
		const selected = await notebookStore.selectPage(hop.originPath, { preserveCurrentOnError: true });
		if (token !== summaryRequestToken.current) return;
		if (selected?.path === hop.originPath || notebookStore.currentPage?.path === hop.originPath) {
			setSummaryHop(null);
			setSummaryFocusStatus(null);
			summaryReturnPending.current = true;
			setProvenanceExpanded(true);
		}
	}

	useEffect(() => {
		const marker = summaryHop?.marker;
		if (!summaryHop?.summaryPath || summaryHop.summaryPath !== currentPagePath || marker === undefined || viewerTarget) return;
		const root = summaryBodyRef.current;
		if (!root) return;
		let finished = false;
		let observer: MutationObserver | undefined;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const finish = () => {
			if (finished) return;
			finished = true;
			observer?.disconnect();
			if (timeout) clearTimeout(timeout);
		};
		const attempt = () => {
			if (finished) return;
			const result = findCitationSentence(root, marker);
			if (result.status === "located") {
				finish();
				highlightCitationSentence(result);
				setSummaryFocusStatus("located");
			} else if (result.status === "ambiguous") {
				finish();
				setSummaryFocusStatus("ambiguous");
			}
		};
		attempt();
		if (!finished && typeof MutationObserver !== "undefined") {
			observer = new MutationObserver(attempt);
			observer.observe(root, { childList: true, subtree: true });
		}
		timeout = setTimeout(() => {
			if (!finished) {
				finish();
				setSummaryFocusStatus("not-found");
			}
		}, 2000);
		return finish;
	}, [currentPagePath, summaryHop?.summaryPath, summaryHop?.marker, viewerTarget]);

	useEffect(() => {
		if (!summaryHop?.summaryPath || summaryHop.summaryPath !== currentPagePath || viewerTarget) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				void returnToOrigin();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [currentPagePath, summaryHop?.summaryPath, viewerTarget]);

	function handleBodyCitationClick(event: MouseEvent<HTMLDivElement>): void {
		const anchor = (event.target as HTMLElement | null)?.closest?.('a[href^="#evidence-"]');
		if (!anchor) return;
		event.preventDefault();
		const href = anchor.getAttribute("href") ?? "";
		const marker = Number(href.slice("#evidence-".length));
		const target = markerTargets.get(marker);
		if (target) openSource(target, anchor as HTMLElement);
	}

	function refreshEvidence(): void {
		if (!window.confirm(t("notebook.page.provenance.refreshConfirm"))) return;
		void notebookStore.refreshEvidence();
	}

	function removeStaleEvidence(): void {
		if (!window.confirm(t("notebook.page.provenance.removeStaleConfirm"))) return;
		void notebookStore.removeStaleEvidence();
	}

	const parsed = state.currentPage ? parseFrontmatter(state.currentPage.content) : null;
	const markerTargets = state.currentPage ? buildSummaryMarkerTargets(state.currentPage) : new Map<number, SourceViewerTarget>();
	const renderedBody = parsed ? injectCitationLinks(parsed.body, markerTargets) : "";
	const summaryHopPage = summaryHop?.summaryPath === currentPagePath;
	const summaryFeedback = summaryHop?.status === "loading" && summaryHop.originPath === currentPagePath
		? t("notebook.page.summaryNavigation.loading")
		: summaryHop?.status === "error"
			&& (summaryHop.originPath === currentPagePath || summaryHop.summaryPath === currentPagePath)
			&& summaryHop.errorKey
			? t(`notebook.page.summaryNavigation.${summaryHop.errorKey}`)
			: summaryHopPage && summaryHop.status === "not-found"
			? t("notebook.page.summaryNavigation.notFound")
			: summaryHopPage && summaryHop.status === "ambiguous-marker"
			? t("notebook.page.summaryNavigation.ambiguousMarker")
			: summaryHopPage && summaryFocusStatus === "not-found"
			? t("notebook.page.summaryNavigation.sentenceNotFound")
			: summaryHopPage && summaryFocusStatus === "ambiguous"
			? t("notebook.page.summaryNavigation.ambiguousMarker")
			: null;

	if (state.isLoading && !state.currentPage) {
		return (
			<div className="flex h-full items-center justify-center text-[var(--inno-text-muted)]" role="status" aria-live="polite">
				<Spinner size={20} />
				<span className="sr-only">{t("notebook.page.loading")}</span>
			</div>
		);
	}
	if (!state.currentPage || !parsed) {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-sm text-[var(--inno-text-muted)]">
				<PageFeedback
					saveError={state.saveError}
					mutationError={state.mutationError}
					pageLoadError={state.pageLoadError}
					loading={false}
					page={null}
				/>
				{!state.pageLoadError ? t("notebook.page.empty") : null}
			</div>
		);
	}

	if (viewerTarget) {
		return <SourceViewer target={viewerTarget} onBack={() => setViewerTarget(null)} />;
	}

	if (state.isEditing) {
		return (
			<div className="flex h-full flex-col" data-color-mode="light">
				{parsed.frontmatter ? (
					<FrontmatterHeader
						frontmatter={parsed.frontmatter}
						page={state.currentPage}
						onOpenSource={openSource}
						onRefreshEvidence={refreshEvidence}
						onRemoveStaleEvidence={removeStaleEvidence}
						mutationPending={state.mutationPending}
						mutationKind={state.mutationKind}
						maintenanceDisabled={state.isEditing || !state.currentPage.pageRevision || !state.currentPage.fileRevision}
						pageLoading={state.isLoading}
						provenanceExpanded={provenanceExpanded}
						onProvenanceExpandedChange={setProvenanceExpanded}
					/>
				) : null}
				<PageFeedback
					saveError={state.saveError}
					mutationError={state.mutationError}
					pageLoadError={state.pageLoadError}
					loading={state.isLoading}
					page={state.currentPage}
				/>
				<div className="min-h-0 flex-1 overflow-hidden">
					<LazyMarkdownEditor
						value={state.editBuffer}
						onChange={(value) => notebookStore.updateEditBuffer(value)}
					/>
				</div>
				<div className="flex gap-2 border-t border-[var(--inno-border)] p-3">
					<button
						className="rounded-md inno-primary-button px-3 py-1.5 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
						disabled={state.isLoading || state.mutationPending}
						aria-busy={state.isLoading}
						onClick={() => void notebookStore.savePage()}
					>
						{t("common.save")}
					</button>
					<button className="rounded-md bg-[var(--inno-surface-muted)] px-3 py-1.5 text-sm text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]" onClick={() => notebookStore.cancelEditing()}>
						{t("common.cancel")}
					</button>
				</div>
			</div>
		);
	}

	return (
		<div className="flex h-full flex-col">
			{summaryHopPage ? (
				<div className="flex items-center border-b border-[var(--inno-border)] px-4 py-2">
					<button
						type="button"
						className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--inno-accent)] hover:underline"
						onClick={() => void returnToOrigin()}
					>
						<ArrowLeft aria-hidden="true" size={15} />
						{t("notebook.page.summaryNavigation.back")}
					</button>
				</div>
			) : null}
			{parsed.frontmatter ? (
				<FrontmatterHeader
					frontmatter={parsed.frontmatter}
					page={state.currentPage}
					onOpenSource={openSource}
					onRefreshEvidence={refreshEvidence}
					onRemoveStaleEvidence={removeStaleEvidence}
					mutationPending={state.mutationPending}
					mutationKind={state.mutationKind}
					maintenanceDisabled={state.isEditing || !state.currentPage.pageRevision || !state.currentPage.fileRevision}
					pageLoading={state.isLoading}
					provenanceExpanded={provenanceExpanded}
					onProvenanceExpandedChange={setProvenanceExpanded}
				/>
			) : null}
			<PageFeedback
				saveError={state.saveError}
				mutationError={state.mutationError}
				pageLoadError={state.pageLoadError}
				loading={state.isLoading}
				page={state.currentPage}
			/>
			{summaryFeedback ? (
				<p
					role={summaryHop?.status === "loading" ? "status" : "alert"}
					className="border-b border-[var(--inno-border)] px-4 py-2 text-xs text-[var(--inno-danger)]"
				>
					{summaryFeedback}
				</p>
			) : null}
			<div ref={summaryBodyRef} className="min-h-0 flex-1 overflow-y-auto p-4" onClick={handleBodyCitationClick}>
				<markdown-artifact
					content={normalizeMarkdownMath(renderedBody)}
					tabIndex={-1}
					data-citation-marker-host="true"
				/>
			</div>
			<div className="flex gap-2 border-t border-[var(--inno-border)] p-3">
				<button
					className="rounded-md inno-primary-button px-3 py-1.5 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
					disabled={state.mutationPending}
					onClick={() => notebookStore.startEditing()}
				>
					{t("common.edit")}
				</button>
				<button className="rounded-md bg-[var(--inno-surface-muted)] px-3 py-1.5 text-sm text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]" onClick={() => notebookStore.setView("graph")}>
					{t("notebook.page.backToGraph")}
				</button>
			</div>
		</div>
	);
}
