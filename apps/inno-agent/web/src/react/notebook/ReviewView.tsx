import { FileText, Search, ClipboardCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { WikiReview } from "../../types/wiki.js";
import { Tooltip } from "../ui/index.js";

interface ReviewViewProps {
	reviews: WikiReview[];
	onOpenPage: (path: string) => void;
}

export function ReviewView({ reviews, onOpenPage }: ReviewViewProps) {
	const { t } = useTranslation();

	if (reviews.length === 0) {
		return (
			<div className="flex h-full items-center justify-center p-6 text-sm text-[var(--inno-text-muted)]">
				{t("notebook.reviews.empty")}
			</div>
		);
	}

	return (
		<div className="h-full overflow-y-auto p-4">
			<div className="mb-3 flex items-center gap-2 text-sm font-semibold text-[var(--inno-text)]">
				<ClipboardCheck size={16} />
				{t("notebook.reviews.title")} <span className="text-xs font-normal text-[var(--inno-text-muted)]">({reviews.length})</span>
			</div>
			<div className="space-y-3">
				{reviews.map((review) => (
					<article key={review.id} className="rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] p-3">
						<div className="flex items-start justify-between gap-3">
							<div>
								<div className="text-sm font-medium text-[var(--inno-text)]">{review.title}</div>
								<div className="mt-1 text-[11px] text-[var(--inno-text-muted)]">{review.type} · {review.sourcePath}</div>
							</div>
							{review.options?.length ? (
								<span className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-[var(--inno-accent)]">
									{review.options.map((option) => option.label).join(" / ")}
								</span>
							) : null}
						</div>
						<p className="mt-2 whitespace-pre-wrap text-sm leading-5 text-[var(--inno-text-muted)]">{review.description}</p>
						{review.pages?.length ? (
							<div className="mt-2 flex flex-wrap gap-1.5">
								{review.pages.map((path) => (
									<Tooltip key={path} label={path}>
										<button type="button" className="inline-flex max-w-full items-center gap-1 truncate rounded border border-[var(--inno-border)] px-2 py-1 text-xs text-[var(--inno-text)] hover:bg-[var(--inno-surface)]" onClick={() => onOpenPage(path)}>
											<FileText size={12} /> <span className="truncate">{path}</span>
										</button>
									</Tooltip>
								))}
							</div>
						) : null}
						{review.search?.length ? (
							<div className="mt-2 flex flex-wrap gap-1.5 text-xs text-[var(--inno-text-muted)]">
								<Search size={12} className="mt-0.5 shrink-0" />
								{review.search.map((query) => <span key={query} className="rounded bg-[var(--inno-surface)] px-1.5 py-0.5">{query}</span>)}
							</div>
						) : null}
					</article>
				))}
			</div>
		</div>
	);
}
