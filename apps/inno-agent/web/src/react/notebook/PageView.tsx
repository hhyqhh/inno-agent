import { useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import { notebookStore } from "../../stores/notebook-store.js";
import type { WikiPageFrontmatter, WikiPageType } from "../../types/wiki.js";
import { parseFrontmatter } from "../../utils/frontmatter.js";
import { normalizeMarkdownMath } from "../../utils/markdown-math.js";
import { useStoreSnapshot } from "../hooks.js";
import "@earendil-works/pi-web-ui";
import { Spinner } from "../ui/Spinner.js";
import { LazyMarkdownEditor } from "../LazyMarkdownEditor.js";

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

function FrontmatterHeader({
	frontmatter,
	canEditTags = true,
	onOpenNoteId,
	onOpenNote,
}: {
	frontmatter: WikiPageFrontmatter;
	canEditTags?: boolean;
	onOpenNoteId?: (noteId: string) => void;
	onOpenNote?: (rawPath: string) => void;
}) {
	const { t } = useTranslation();
	const [isEditingTags, setIsEditingTags] = useState(false);
	const [tagDraft, setTagDraft] = useState(frontmatter.tags.join(", "));
	const [isSavingTags, setIsSavingTags] = useState(false);
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

	async function saveTags() {
		const tags = tagDraft
			.split(/[,\uFF0C;\uFF1B\u3001|]+/)
			.map((tag) => tag.trim())
			.filter(Boolean);
		setIsSavingTags(true);
		try {
			await notebookStore.updateCurrentPageTags(tags);
			setIsEditingTags(false);
		} finally {
			setIsSavingTags(false);
		}
	}

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
			<div className="mt-2 flex flex-wrap items-center gap-1">
				{isEditingTags ? (
					<>
						<input
							type="text"
							className="min-w-48 flex-1 rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] px-2 py-1 text-xs text-[var(--inno-text)] outline-none focus:border-[var(--inno-accent)]"
							value={tagDraft}
							onChange={(event) => setTagDraft(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") void saveTags();
							}}
							placeholder={t("notebook.inspector.tagsPlaceholder")}
							disabled={isSavingTags}
						/>
						<button
							type="button"
							className="rounded-md inno-primary-button px-2 py-1 text-xs text-white disabled:opacity-50"
							onClick={() => void saveTags()}
							disabled={isSavingTags}
						>
							{t("common.save")}
						</button>
						<button
							type="button"
							className="rounded-md bg-[var(--inno-surface-muted)] px-2 py-1 text-xs text-[var(--inno-text-muted)]"
							onClick={() => {
								setTagDraft(frontmatter.tags.join(", "));
								setIsEditingTags(false);
							}}
							disabled={isSavingTags}
						>
							{t("common.cancel")}
						</button>
					</>
				) : (
					<>
						{frontmatter.tags.map((tag) => (
							<button
								key={tag}
								type="button"
								className="rounded-full bg-[var(--inno-accent-soft)] px-1.5 py-0.5 text-xs text-[var(--inno-accent)]"
								onClick={() => notebookStore.searchByTag(tag)}
							>
								#{tag}
							</button>
						))}
						{canEditTags ? (
							<button
								type="button"
								className="rounded-full bg-[var(--inno-surface-muted)] px-2 py-0.5 text-xs text-[var(--inno-text-muted)] hover:text-[var(--inno-text)]"
								onClick={() => setIsEditingTags(true)}
							>
								{frontmatter.tags.length > 0 ? t("notebook.inspector.editTags") : t("notebook.inspector.addTags")}
							</button>
						) : null}
					</>
				)}
			</div>
			{(() => {
				const notePath = frontmatter.sources.find((path) => path.startsWith("raw/notes/"));
				if (onOpenNote && notePath) {
					return (
						<div className="mt-2">
							<button
								type="button"
								className="text-xs text-[var(--inno-accent)] hover:underline"
								onClick={() => onOpenNote(notePath)}
							>
								{t("notes.actions.viewNote")}
							</button>
						</div>
					);
				}
				if (onOpenNoteId && frontmatter.source_ids.length > 0) {
					return (
						<div className="mt-2">
							<button
								type="button"
								className="text-xs text-[var(--inno-accent)] hover:underline"
								onClick={() => onOpenNoteId(frontmatter.source_ids[0])}
							>
								{t("notes.actions.viewNote")}
							</button>
						</div>
					);
				}
				return null;
			})()}
		</div>
	);
}

export function PageView({
	onOpenNoteId,
	onOpenNote,
}: {
	onOpenNoteId?: (noteId: string) => void;
	onOpenNote?: (rawPath: string) => void;
}) {
	const { t } = useTranslation();
	const state = useStoreSnapshot(notebookStore, () => ({
		currentPage: notebookStore.currentPage,
		isEditing: notebookStore.isEditing,
		isLoading: notebookStore.isLoadingPage,
		isRegeneratingSource: notebookStore.isRegeneratingSource,
		regeneratingSourceId: notebookStore.regeneratingSourceId,
		editBuffer: notebookStore.editBuffer,
	}));
	const parsed = state.currentPage ? parseFrontmatter(state.currentPage.content) : null;
	const sourceId = parsed?.frontmatter?.type === "source-summary" ? parsed.frontmatter.source_ids[0] : undefined;
	const isCurrentSourceRegenerating = sourceId === state.regeneratingSourceId;

	if (state.isLoading) {
		return (
			<div className="flex h-full items-center justify-center text-[var(--inno-text-muted)]">
				<Spinner size={20} />
			</div>
		);
	}
	if (!state.currentPage || !parsed) {
		return <div className="flex h-full items-center justify-center text-sm text-[var(--inno-text-muted)]">{t("notebook.page.empty")}</div>;
	}

	if (state.isEditing) {
		return (
			<div className="flex h-full flex-col" data-color-mode="light">
				{parsed.frontmatter ? (
					<FrontmatterHeader frontmatter={parsed.frontmatter} canEditTags={false} onOpenNoteId={onOpenNoteId} onOpenNote={onOpenNote} />
				) : null}
				<div className="min-h-0 flex-1 overflow-hidden">
					<LazyMarkdownEditor
						value={state.editBuffer}
						onChange={(value) => notebookStore.updateEditBuffer(value)}
					/>
				</div>
				<div className="flex gap-2 border-t border-[var(--inno-border)] p-3">
					<button className="rounded-md inno-primary-button px-3 py-1.5 text-sm text-white" onClick={() => void notebookStore.savePage()}>
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
			{parsed.frontmatter ? (
				<FrontmatterHeader frontmatter={parsed.frontmatter} onOpenNoteId={onOpenNoteId} onOpenNote={onOpenNote} />
			) : null}
			<div className="min-h-0 flex-1 overflow-y-auto p-4">
				<markdown-artifact content={normalizeMarkdownMath(parsed.body)} />
			</div>
			<div className="flex gap-2 border-t border-[var(--inno-border)] p-3">
				<button className="rounded-md inno-primary-button px-3 py-1.5 text-sm text-white" onClick={() => notebookStore.startEditing()}>
					{t("common.edit")}
				</button>
				{sourceId ? (
					<button
						type="button"
						className="inline-flex items-center gap-1 rounded-md bg-[var(--inno-surface-muted)] px-3 py-1.5 text-sm text-[var(--inno-text-muted)] disabled:opacity-50"
						disabled={state.isRegeneratingSource}
						onClick={() => void notebookStore.regenerateSource(sourceId).catch(console.error)}
					>
						<RefreshCw size={14} className={isCurrentSourceRegenerating ? "animate-spin" : ""} />
						{isCurrentSourceRegenerating ? t("notebook.page.regenerating") : t("notebook.page.regenerate")}
					</button>
				) : null}
				<button className="rounded-md bg-[var(--inno-surface-muted)] px-3 py-1.5 text-sm text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]" onClick={() => notebookStore.setView("graph")}>
					{t("notebook.page.backToGraph")}
				</button>
			</div>
		</div>
	);
}
