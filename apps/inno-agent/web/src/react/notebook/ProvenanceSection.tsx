import { ExternalLink, RefreshCw, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type {
	PositionReasonCode,
	ProvenancePayload,
	RawKind,
	RawSourceType,
	ResolvedEvidenceReference,
	SourceProvenanceGroup,
	SourceViewerTarget,
	WikiPageFrontmatter,
	WikiPageType,
} from "../../types/wiki.js";

export interface ProvenanceSectionProps {
	provenance?: ProvenancePayload;
	fallbackSources: readonly string[];
	fallbackSourceIds: readonly string[];
	onOpenSource(target: SourceViewerTarget): void;
	onRefreshEvidence(): void;
	onRemoveStaleEvidence(): void;
	mutationPending: boolean;
	mutationKind?: "refresh" | "remove-stale" | null;
	maintenanceDisabled?: boolean;
	/** Source-summary pages use inline markers as their only exact-location entry point. */
	pageType?: WikiPageType;
	expanded?: boolean;
	onExpandedChange?(expanded: boolean): void;
}

interface LegacyProvenanceSectionProps {
	/** Transitional compatibility until PageView is connected in Task 15. */
	sources: Readonly<WikiPageFrontmatter["sources"]>;
	sourceIds: Readonly<WikiPageFrontmatter["source_ids"]>;
}

interface NormalizedProps extends ProvenanceSectionProps {
	showMaintenanceActions: boolean;
}

function normalizeProps(props: ProvenanceSectionProps | LegacyProvenanceSectionProps): NormalizedProps {
	if ("fallbackSources" in props) {
		return {
			...props,
			mutationKind: props.mutationKind ?? null,
			maintenanceDisabled: props.maintenanceDisabled ?? false,
			showMaintenanceActions: props.provenance !== undefined,
		};
	}
	return {
		provenance: undefined,
		fallbackSources: props.sources,
		fallbackSourceIds: props.sourceIds,
		onOpenSource: () => undefined,
		onRefreshEvidence: () => undefined,
		onRemoveStaleEvidence: () => undefined,
		mutationPending: false,
		mutationKind: null,
		maintenanceDisabled: false,
		showMaintenanceActions: false,
	};
}

function meaningfulValues(values: readonly string[]): string[] {
	return values.filter((value) => value.trim().length > 0);
}

function sourceFormat(type: RawSourceType, t: TFunction): string {
	return t(`notebook.page.provenance.format.${type}`);
}

function acquisitionLabel(rawKind: RawKind | undefined, t: TFunction): string {
	if (rawKind === "uploaded-original") return t("notebook.page.provenance.acquisition.uploaded");
	if (rawKind === "archived-text") return t("notebook.page.provenance.acquisition.archived");
	return t("notebook.page.provenance.acquisition.local");
}

function locationLabel(reference: ResolvedEvidenceReference | undefined, t: TFunction): string {
	if (!reference) return t("notebook.page.provenance.location.none");
	const locator = reference.locator;
	if (locator.kind === "pdf-page") {
		return t("notebook.page.provenance.location.pdfPage", { page: locator.page });
	}
	if (locator.heading) {
		return t("notebook.page.provenance.location.headingParagraph", {
			heading: locator.heading,
			paragraph: locator.paragraph,
		});
	}
	return t("notebook.page.provenance.location.paragraph", { paragraph: locator.paragraph });
}

function positionLabel(status: "verified" | PositionReasonCode, t: TFunction): string {
	return t(`notebook.page.provenance.status.${status}`);
}

function shortenedQuote(quote: string): string {
	const characters = [...quote];
	return characters.length <= 180 ? quote : `${characters.slice(0, 177).join("")}...`;
}

export function canUseExactTarget(status: "verified" | PositionReasonCode): boolean {
	return status === "verified"
		|| status === "stale-page"
		|| status === "locator-invalid"
		|| status === "quote-mismatch"
		|| status === "drifted";
}

function targetForReadySource(
	group: Extract<SourceProvenanceGroup, { availability: "ready" }>,
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

function SourceAction({
	group,
	reference,
	location,
	statusId,
	actionId,
	onOpenSource,
	pageType,
	sourceSummaryFallback,
	t,
}: {
	group: SourceProvenanceGroup;
	reference?: ResolvedEvidenceReference;
	location: string;
	statusId: string;
	actionId: string;
	onOpenSource(target: SourceViewerTarget): void;
	pageType?: WikiPageType;
	sourceSummaryFallback?: boolean;
	t: TFunction;
}) {
	const ready = group.availability === "ready";
	const target = ready
		? targetForReadySource(group, sourceSummaryFallback ? undefined : reference)
		: undefined;
	const exact = target?.mode === "exact";
	if (exact && pageType === "source-summary") return null;
	const action = exact
		? t("notebook.page.provenance.action.exact")
		: t("notebook.page.provenance.action.file");
	const title = "title" in group ? group.title : group.sourceId;
	const accessibleName = exact
		? t("notebook.page.provenance.action.exactAria", { title, location })
		: t("notebook.page.provenance.action.fileAria", { title, location });
	const disabledReason = group.availability === "missing-source"
		? t("notebook.page.provenance.status.missing-source")
		: group.availability === "missing-file"
			? t("notebook.page.provenance.status.missing-file")
			: undefined;

	return (
		<button
			type="button"
			className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] px-2.5 py-1.5 text-xs font-medium text-[var(--inno-text)] hover:border-[var(--inno-accent)] hover:text-[var(--inno-accent)] disabled:cursor-not-allowed disabled:opacity-50"
			disabled={!target}
			aria-label={accessibleName}
			aria-describedby={statusId}
			data-provenance-action-id={actionId}
			title={disabledReason}
			onClick={(event) => {
				event.currentTarget.focus();
				if (target) onOpenSource(target);
			}}
		>
			<ExternalLink aria-hidden="true" size={14} />
			{action}
		</button>
	);
}

function SourceGroupView({
	group,
	groupIndex,
	onOpenSource,
	pageType,
	t,
}: {
	group: SourceProvenanceGroup;
	groupIndex: number;
	onOpenSource(target: SourceViewerTarget): void;
	pageType?: WikiPageType;
	t: TFunction;
}) {
	const title = "title" in group ? group.title : group.sourceId;
	const references = group.references.length > 0 ? group.references : [undefined];
	const sourceSummaryNeedsFallback = pageType === "source-summary"
		&& !group.references.some((reference) => (
			typeof reference.marker === "number"
			&& Number.isSafeInteger(reference.marker)
			&& reference.marker > 0
		));
	const unavailableStatus = group.availability === "missing-source"
		? "missing-source"
		: group.availability === "missing-file"
			? "missing-file"
			: undefined;

	return (
		<li className="border-t border-[var(--inno-border)] px-3 py-3 first:border-t-0">
			<div className="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-1">
				<div className="min-w-0">
					<h4 className="break-words text-sm font-medium text-[var(--inno-text)]">{title}</h4>
					{"sourceType" in group ? (
						<div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-[var(--inno-text-muted)]">
							<span>{sourceFormat(group.sourceType, t)}</span>
							<span aria-hidden="true">·</span>
							<span>{acquisitionLabel(group.rawKind, t)}</span>
						</div>
					) : null}
					{"rawRelativePath" in group && group.rawRelativePath ? (
						<div className="mt-1 break-all font-mono text-[11px] text-[var(--inno-text-muted)]" title={group.rawRelativePath}>
							{group.rawRelativePath}
						</div>
					) : null}
				</div>
				<span className="max-w-full break-all font-mono text-[10px] text-[var(--inno-text-muted)]" title={group.sourceId}>
					{group.sourceId}
				</span>
			</div>

			<div className="mt-3 space-y-3">
				{references.map((reference, referenceIndex) => {
					const location = locationLabel(reference, t);
					const status = unavailableStatus
						? positionLabel(unavailableStatus, t)
						: reference
							? `${t(`notebook.page.provenance.selected.${reference.selectedBy}`)} · ${positionLabel(reference.positionStatus, t)}`
							: location;
					const statusId = `provenance-status-${groupIndex}-${referenceIndex}`;
					const actionId = `${groupIndex}:${referenceIndex}`;
					return (
						<div key={`${group.sourceId}-${referenceIndex}`} className="grid min-w-0 gap-2 @sm:grid-cols-[minmax(0,1fr)_auto] @sm:items-end">
							<div className="min-w-0 space-y-1">
								<p
									id={!reference && unavailableStatus === undefined ? statusId : undefined}
									className="text-xs font-medium text-[var(--inno-text)]"
								>
									{reference?.marker !== undefined ? `[${reference.marker}] ` : ""}{location}
								</p>
								{reference ? (
									<p className="text-xs leading-5 text-[var(--inno-text-muted)]">
										<span className="sr-only">{t("notebook.page.provenance.quote")}: </span>
										<span>{shortenedQuote(reference.quote)}</span>
									</p>
								) : null}
								{reference || unavailableStatus ? (
									<p id={statusId} className="text-[11px] text-[var(--inno-text-muted)]">{status}</p>
								) : null}
							</div>
							{!sourceSummaryNeedsFallback || referenceIndex === 0 ? (
								<SourceAction
									group={group}
									reference={reference}
									location={location}
									statusId={statusId}
									actionId={actionId}
									onOpenSource={onOpenSource}
									pageType={pageType}
									sourceSummaryFallback={sourceSummaryNeedsFallback}
									t={t}
								/>
							) : null}
						</div>
					);
				})}
			</div>
		</li>
	);
}

function LegacyValues({
	paths,
	sourceIds,
	t,
}: {
	paths: readonly string[];
	sourceIds: readonly string[];
	t: TFunction;
}) {
	if (paths.length === 0 && sourceIds.length === 0) return null;
	return (
		<div className="grid gap-3 border-t border-[var(--inno-border)] px-3 py-3 sm:grid-cols-2">
			{paths.length > 0 ? (
				<div className="min-w-0">
					<h4 className="mb-1 text-xs font-medium text-[var(--inno-text)]">{t("notebook.page.provenance.sources")}</h4>
					<ul className="space-y-1">
						{paths.map((path, index) => <li key={`path-${index}`} className="break-all text-xs" title={path}>{path}</li>)}
					</ul>
				</div>
			) : null}
			{sourceIds.length > 0 ? (
				<div className="min-w-0">
					<h4 className="mb-1 text-xs font-medium text-[var(--inno-text)]">{t("notebook.page.provenance.sourceIds")}</h4>
					<ul className="space-y-1">
						{sourceIds.map((sourceId, index) => <li key={`id-${index}`} className="break-all font-mono text-[11px]" title={sourceId}>{sourceId}</li>)}
					</ul>
				</div>
			) : null}
		</div>
	);
}

export function ProvenanceSection(props: ProvenanceSectionProps | LegacyProvenanceSectionProps) {
	const { t } = useTranslation();
	const normalized = normalizeProps(props);
	const groups = normalized.provenance?.sourceGroups ?? [];
	const representedIds = new Set(groups.map((group) => group.sourceId));
	const legacyPaths = meaningfulValues(
		normalized.provenance ? normalized.provenance.legacyPaths : normalized.fallbackSources,
	);
	const fallbackIds = meaningfulValues(normalized.fallbackSourceIds)
		.filter((sourceId) => !representedIds.has(sourceId));
	const issueCount = normalized.provenance?.referenceIssues.length ?? 0;
	if (groups.length === 0 && legacyPaths.length === 0 && fallbackIds.length === 0 && issueCount === 0) return null;

	return (
		<details
			className="@container mt-3 rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] text-xs text-[var(--inno-text-muted)]"
			{...(normalized.expanded === undefined ? {} : { open: normalized.expanded })}
			onToggle={normalized.expanded === undefined
				? (event) => normalized.onExpandedChange?.(event.currentTarget.open)
				: undefined}
		>
			<summary
				data-provenance-summary
				className="cursor-pointer select-none px-3 py-2 font-medium text-[var(--inno-text)]"
				onClick={(event) => {
					if (normalized.expanded === undefined) return;
					event.preventDefault();
					normalized.onExpandedChange?.(!normalized.expanded);
				}}
			>
				{t("notebook.page.provenance.title")}
			</summary>
			<div className="border-t border-[var(--inno-border)]">
				{normalized.showMaintenanceActions ? (
					<div className="flex flex-wrap gap-2 px-3 py-2">
						<button
							type="button"
							className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] px-2.5 py-1.5 font-medium text-[var(--inno-text)] disabled:cursor-not-allowed disabled:opacity-50"
							disabled={normalized.mutationPending || normalized.maintenanceDisabled}
							aria-busy={normalized.mutationKind === "refresh"}
							onClick={normalized.onRefreshEvidence}
						>
							<RefreshCw aria-hidden="true" size={14} className={normalized.mutationKind === "refresh" ? "animate-spin" : undefined} />
							{t("notebook.page.provenance.refresh")}
						</button>
						<button
							type="button"
							className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] px-2.5 py-1.5 font-medium text-[var(--inno-text)] disabled:cursor-not-allowed disabled:opacity-50"
							disabled={normalized.mutationPending || normalized.maintenanceDisabled}
							aria-busy={normalized.mutationKind === "remove-stale"}
							onClick={normalized.onRemoveStaleEvidence}
						>
							<X aria-hidden="true" size={14} />
							{t("notebook.page.provenance.removeStale")}
						</button>
						{normalized.mutationKind ? (
							<span className="sr-only" role="status" aria-live="polite">
								{t(`notebook.page.provenance.${normalized.mutationKind === "refresh" ? "refreshing" : "removingStale"}`)}
							</span>
						) : null}
					</div>
				) : null}
				{issueCount > 0 ? (
					<p role="status" className="border-t border-[var(--inno-border)] px-3 py-2 text-[var(--inno-danger)]">
						{t("notebook.page.provenance.referenceIssues", { count: issueCount })}
					</p>
				) : null}
				{groups.length > 0 ? (
					<ul className="border-t border-[var(--inno-border)]">
						{groups.map((group, index) => (
							<SourceGroupView
								key={`${group.sourceId}-${index}`}
								group={group}
								groupIndex={index}
								onOpenSource={normalized.onOpenSource}
								pageType={normalized.pageType}
								t={t}
							/>
						))}
					</ul>
				) : null}
				<LegacyValues paths={legacyPaths} sourceIds={fallbackIds} t={t} />
			</div>
		</details>
	);
}
