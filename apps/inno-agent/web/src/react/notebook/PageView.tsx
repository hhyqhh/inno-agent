import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, RefreshCw, Tags as TagsIcon, X } from "lucide-react";
import { notebookStore } from "../../stores/notebook-store.js";
import type { WikiPageFrontmatter, WikiPageType } from "../../types/wiki.js";
import { parseFrontmatter } from "../../utils/frontmatter.js";
import { normalizeMarkdownMath } from "../../utils/markdown-math.js";
import { useStoreSnapshot } from "../hooks.js";
import { MilkdownEditor } from "./MilkdownEditor.js";

function typeColor(type?: WikiPageType): string {
	switch (type) {
		case "source-summary":
			return "bg-[var(--inno-accent-soft)] text-[var(--inno-accent)] ring-1 ring-blue-100";
		case "entity":
			return "bg-green-50 text-green-700 ring-1 ring-green-100";
		case "concept":
			return "bg-orange-50 text-orange-700 ring-1 ring-orange-100";
		case "analysis":
			return "bg-purple-50 text-purple-700 ring-1 ring-purple-100";
		default:
			return "bg-[var(--inno-surface-muted)] text-[var(--inno-text-muted)]";
	}
}

function splitTagInput(value: string): string[] {
	return value
		.split(/[\s,\uFF0C;\uFF1B\u3001|]+/)
		.map((tag) => tag.trim())
		.filter(Boolean);
}

function uniqueTags(tags: string[]): string[] {
	const seen = new Set<string>();
	const next: string[] = [];
	for (const tag of tags) {
		const key = tag.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		next.push(tag);
	}
	return next;
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
	const [draftTags, setDraftTags] = useState(frontmatter.tags);
	const [tagInput, setTagInput] = useState("");
	const [isSavingTags, setIsSavingTags] = useState(false);
	const statusColors: Record<string, string> = {
		draft: "bg-yellow-50 text-yellow-700 ring-1 ring-yellow-100",
		reviewed: "bg-green-50 text-green-700 ring-1 ring-green-100",
		outdated: "bg-red-50 text-red-700 ring-1 ring-red-100",
	};
	const confidenceColors: Record<string, string> = {
		low: "bg-red-50 text-red-700 ring-1 ring-red-100",
		medium: "bg-yellow-50 text-yellow-700 ring-1 ring-yellow-100",
		high: "bg-green-50 text-green-700 ring-1 ring-green-100",
	};
	const saveTags = async () => {
		const tags = uniqueTags([...draftTags, ...splitTagInput(tagInput)]);
		setIsSavingTags(true);
		try {
			await notebookStore.updateCurrentPageTags(tags);
			setIsEditingTags(false);
			setTagInput("");
		} finally {
			setIsSavingTags(false);
		}
	};
	const addTagsFromInput = (value: string) => {
		const tags = splitTagInput(value);
		if (tags.length === 0) return;
		setDraftTags((current) => uniqueTags([...current, ...tags]));
		setTagInput("");
	};
	const removeDraftTag = (tag: string) => {
		setDraftTags((current) => current.filter((entry) => entry !== tag));
	};

	return (
		<div className="border-b border-[var(--inno-border)] bg-[var(--inno-surface)] px-4 py-3">
			<h3 className="mb-1.5 truncate text-base font-medium text-[var(--inno-text)]">{frontmatter.title}</h3>
			<div className="flex flex-wrap items-center gap-2 text-xs">
				<span className={`rounded px-1.5 py-0.5 ${typeColor(frontmatter.type)}`}>{t(`notebook.types.${frontmatter.type}`)}</span>
				<span className={`rounded px-1.5 py-0.5 ${statusColors[frontmatter.status] ?? ""}`}>{t(`notebook.status.${frontmatter.status}`)}</span>
				<span className={`rounded px-1.5 py-0.5 ${confidenceColors[frontmatter.confidence] ?? ""}`}>{t(`notebook.confidence.${frontmatter.confidence}`)}</span>
				{frontmatter.contested ? <span className="rounded bg-red-50 px-1.5 py-0.5 text-red-700 ring-1 ring-red-100">{t("notebook.contested")}</span> : null}
				<span className="text-[var(--inno-text-muted)]">{frontmatter.updated}</span>
			</div>
			<div className="mt-2">
				{isEditingTags ? (
					<div className="flex items-start gap-2">
						<div className="min-w-0 flex-1 rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] px-2 py-1 focus-within:border-blue-300 focus-within:ring-2 focus-within:ring-blue-100">
							<div className="flex flex-wrap items-center gap-1">
								{draftTags.map((tag) => (
									<span
										key={tag}
										className="inline-flex items-center gap-1 rounded-full bg-[var(--inno-accent-soft)] px-1.5 py-0.5 text-xs text-[var(--inno-accent)] ring-1 ring-blue-100"
									>
										{tag}
										<button
											type="button"
											className="rounded-full text-[var(--inno-accent)] hover:bg-blue-100"
											onClick={() => removeDraftTag(tag)}
											disabled={isSavingTags}
											title={t("common.delete")}
										>
											<X size={11} />
										</button>
									</span>
								))}
								<input
									type="text"
									className="min-w-24 flex-1 border-0 bg-transparent px-1 py-0.5 text-xs text-[var(--inno-text)] outline-none"
									value={tagInput}
									onChange={(event) => {
										const value = event.target.value;
										if (/[\s,\uFF0C;\uFF1B\u3001|]$/.test(value)) {
											addTagsFromInput(value);
										} else {
											setTagInput(value);
										}
									}}
									onKeyDown={(event) => {
										if (event.key === "Enter") {
											event.preventDefault();
											addTagsFromInput(tagInput);
										} else if (event.key === "Backspace" && tagInput.length === 0 && draftTags.length > 0) {
											setDraftTags((current) => current.slice(0, -1));
										}
									}}
									onBlur={() => addTagsFromInput(tagInput)}
									placeholder={t("notebook.inspector.tagsInputPlaceholder", "Space separated tags") ?? ""}
									disabled={isSavingTags}
								/>
							</div>
						</div>
						<button
							type="button"
							className="flex h-7 w-7 items-center justify-center rounded-md inno-primary-button text-white disabled:opacity-50"
							onClick={() => void saveTags()}
							disabled={isSavingTags}
							title={t("common.save")}
						>
							<Check size={14} />
						</button>
						<button
							type="button"
							className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--inno-surface-muted)] text-[var(--inno-text-muted)] hover:bg-slate-200 hover:text-[var(--inno-text)]"
							onClick={() => {
								setDraftTags(frontmatter.tags);
								setTagInput("");
								setIsEditingTags(false);
							}}
							disabled={isSavingTags}
							title={t("common.cancel")}
						>
							<X size={14} />
						</button>
					</div>
				) : (
					<div className="flex flex-wrap items-center gap-1">
						{canEditTags ? (
							<button
								type="button"
								className="inline-flex items-center gap-1 rounded-full bg-[var(--inno-surface-muted)] px-2 py-0.5 text-xs text-[var(--inno-text-muted)] hover:bg-slate-200 hover:text-[var(--inno-text)]"
								onClick={() => {
									setDraftTags(frontmatter.tags);
									setTagInput("");
									setIsEditingTags(true);
								}}
								title={t("notebook.inspector.editTags")}
							>
								<TagsIcon size={12} />
								{frontmatter.tags.length > 0 ? t("notebook.inspector.editTags") : t("notes.properties.addTag")}
							</button>
						) : null}
					</div>
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
	const isCurrentSourceRegenerating = Boolean(sourceId && state.regeneratingSourceId === sourceId);

	if (state.isLoading) {
		return (
			<div className="flex h-full items-center justify-center text-[var(--inno-text-muted)]">
				<span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" />
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
					<FrontmatterHeader
						frontmatter={parsed.frontmatter}
						canEditTags={false}
						onOpenNoteId={onOpenNoteId}
						onOpenNote={onOpenNote}
					/>
				) : null}
				<div className="min-h-0 flex-1 overflow-hidden">
					<MilkdownEditor
						editorKey={state.currentPage.path}
						value={state.editBuffer}
						onChange={(value) => notebookStore.updateEditBuffer(value)}
					/>
				</div>
				<div className="flex gap-2 border-t border-[var(--inno-border)] p-3">
					<button className="rounded-md inno-primary-button px-3 py-1.5 text-sm text-white" onClick={() => void notebookStore.savePage()}>
						{t("common.save")}
					</button>
					<button className="rounded-md bg-[var(--inno-surface-muted)] px-3 py-1.5 text-sm text-[var(--inno-text-muted)] hover:bg-slate-200 hover:text-[var(--inno-text)]" onClick={() => notebookStore.cancelEditing()}>
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
			<div className="min-h-0 flex-1 overflow-hidden">
				<MilkdownEditor
					editorKey={`${state.currentPage.path}:readonly`}
					value={normalizeMarkdownMath(parsed.body)}
					onChange={() => undefined}
					readOnly
				/>
			</div>
			<div className="flex gap-2 border-t border-[var(--inno-border)] p-3">
				<button className="rounded-md inno-primary-button px-3 py-1.5 text-sm text-white" onClick={() => notebookStore.startEditing()}>
					{t("common.edit")}
				</button>
				{sourceId ? (
					<button
						className="inline-flex items-center gap-1 rounded-md bg-[var(--inno-surface-muted)] px-3 py-1.5 text-sm text-[var(--inno-text-muted)] hover:bg-slate-200 hover:text-[var(--inno-text)] disabled:opacity-50"
						disabled={state.isRegeneratingSource}
						onClick={() => void notebookStore.regenerateSource(sourceId)}
					>
						<RefreshCw size={14} className={isCurrentSourceRegenerating ? "animate-spin" : ""} />
						{isCurrentSourceRegenerating ? t("notebook.page.regenerating") : t("notebook.page.regenerate")}
					</button>
				) : null}
				<button className="rounded-md bg-[var(--inno-surface-muted)] px-3 py-1.5 text-sm text-[var(--inno-text-muted)] hover:bg-slate-200 hover:text-[var(--inno-text)]" onClick={() => notebookStore.setView("graph")}>
					{t("notebook.page.backToGraph")}
				</button>
			</div>
		</div>
	);
}
