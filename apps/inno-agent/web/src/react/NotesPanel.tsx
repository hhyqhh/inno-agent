import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MilkdownEditor } from "./notebook/MilkdownEditor.js";
import { NoteAttachments } from "./notebook/NoteAttachments.js";
import { NoteProperties } from "./notebook/NoteProperties.js";
import {
	Archive,
	ArchiveRestore,
	ChevronDown,
	Download,
	ExternalLink,
	FileText,
	FileUp,
	LoaderCircle,
	Plus,
	RefreshCw,
	Save,
	Trash2,
	X,
} from "lucide-react";
import { getVisibleNoteTemplates } from "../lib/build-note-from-template.js";
import { l2RawFileUrl } from "../api/notes.js";
import { notesStore } from "../stores/notes-store.js";
import type { NoteSummary } from "../types/notes.js";
import { normalizeMarkdownMath } from "../utils/markdown-math.js";
import { useStoreSnapshot } from "./hooks.js";

interface NotesPanelProps {
	onOpenWiki?(wikiPath: string): void;
}

function formatSize(bytes?: number): string {
	if (bytes == null) return "";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function rawFileName(rawPath: string): string {
	return rawPath.split(/[\\/]/).pop() || rawPath;
}

export function NotesPanel({ onOpenWiki }: NotesPanelProps) {
	const { t } = useTranslation();
	const [templateMenuOpen, setTemplateMenuOpen] = useState(false);
	const [tagsOpen, setTagsOpen] = useState(false);
	const templateMenuRef = useRef<HTMLDivElement>(null);
	const uploadRef = useRef<HTMLInputElement>(null);
	const state = useStoreSnapshot(notesStore, () => ({
		notes: notesStore.filteredNotes,
		selected: notesStore.selected,
		listBox: notesStore.listBox,
		draftCount: notesStore.draftCount,
		archivedCount: notesStore.archivedCount,
		editorTitle: notesStore.editorTitle,
		editorContent: notesStore.editorContent,
		editorTags: notesStore.editorTags,
		editorRecordDate: notesStore.editorRecordDate,
		attachments: notesStore.attachments,
		isUploadingAttachment: notesStore.isUploadingAttachment,
		deletingAttachmentId: notesStore.deletingAttachmentId,
		previewContent: notesStore.previewContent,
		isDirty: notesStore.isDirty,
		isLoading: notesStore.isLoading,
		isLoadingContent: notesStore.isLoadingContent,
		isLoadingPreview: notesStore.isLoadingPreview,
		isCreating: notesStore.isCreating,
		isSaving: notesStore.isSaving,
		isArchiving: notesStore.isArchiving,
		archivingRawPath: notesStore.archivingRawPath,
		archivingRawPaths: notesStore.archivingRawPaths,
		isDeleting: notesStore.isDeleting,
		isUploading: notesStore.isUploading,
		searchQuery: notesStore.searchQuery,
		filterTag: notesStore.filterTag,
		tagSummaries: notesStore.tagSummaries,
		notice: notesStore.notice,
		error: notesStore.error,
	}));

	useEffect(() => {
		void notesStore.loadAll();
	}, []);

	useEffect(() => {
		if (!templateMenuOpen) return;
		const handlePointerDown = (event: PointerEvent) => {
			const target = event.target;
			if (!(target instanceof Node) || templateMenuRef.current?.contains(target)) return;
			setTemplateMenuOpen(false);
		};
		document.addEventListener("pointerdown", handlePointerDown, true);
		return () => document.removeEventListener("pointerdown", handlePointerDown, true);
	}, [templateMenuOpen]);

	const templates = getVisibleNoteTemplates();

	const handleArchive = useCallback(async () => {
		const wikiPath = await notesStore.archiveSelected();
		if (wikiPath && onOpenWiki) onOpenWiki(wikiPath);
	}, [onOpenWiki]);

	const handleDelete = useCallback(async () => {
		const selected = notesStore.selected;
		if (!selected) return;
		const confirmed = typeof window === "undefined" ? true : window.confirm(t("notes.deleteConfirm", { title: selected.title }));
		if (!confirmed) return;
		await notesStore.deleteSelected();
	}, [t]);

	const handleUnarchive = useCallback(async () => {
		const selected = notesStore.selected;
		if (!selected) return;
		const confirmed = typeof window === "undefined" ? true : window.confirm(t("notes.unarchiveConfirm", { title: selected.title }));
		if (!confirmed) return;
		await notesStore.unarchiveSelected();
	}, [t]);

	const selected = state.selected;
	const isMarkdown = selected?.kind === "markdown";
	const isRawEditableMarkdown = Boolean(selected && selected.kind !== "markdown" && selected.contentType === "markdown");
	const showRearchive =
		(selected?.kind === "markdown" || selected?.kind === "archived") && selected.status === "outdated";
	const isUnarchivedFile =
		selected?.notebookType === "file" &&
		(selected.status === "uploaded" || selected.status === "extracted" || selected.status === "error");
	const showOpenWiki = Boolean(selected?.wikiPagePath && onOpenWiki);
	const showDownload = selected && !isMarkdown;
	const canArchiveNow =
		selected &&
		(selected.kind === "orphan" ||
			isUnarchivedFile ||
			(selected.kind === "archived" && selected.status === "outdated") ||
			(selected.kind === "markdown" && (selected.status === "draft" || selected.status === "outdated")));
	const canUnarchive =
		selected &&
		(selected.kind === "archived" ||
			(selected.kind === "markdown" && (selected.status === "indexed" || selected.status === "outdated")));
	const canDelete =
		selected &&
		(selected.kind === "orphan" || (selected.kind === "markdown" && selected.status === "draft"));
	const canSave = Boolean(selected && (isMarkdown || isRawEditableMarkdown));
	const isSelectedArchiving = Boolean(selected && state.archivingRawPaths.includes(selected.rawPath));
	const tagSearchQuery = state.searchQuery.trim().toLowerCase();
	const visibleTagSummaries = tagSearchQuery
		? state.tagSummaries.filter((tag) => tag.displayName.toLowerCase().includes(tagSearchQuery))
		: state.tagSummaries;

	function renderBottomActions() {
		if (!selected) return null;
		const hasActions =
			canSave ||
			showDownload ||
			(canArchiveNow && (selected.status === "draft" || selected.kind === "orphan" || isUnarchivedFile)) ||
			showRearchive ||
			canUnarchive ||
			canDelete ||
			showOpenWiki;
		if (!hasActions) return null;
		return (
			<div className="flex flex-wrap gap-2 border-t border-[var(--inno-border)] p-3">
				{canSave ? (
					<button
						type="button"
						className="inline-flex items-center gap-1 rounded-md border border-[var(--inno-border)] px-3 py-1.5 text-sm hover:bg-[var(--inno-surface-muted)] disabled:opacity-50"
						disabled={!state.isDirty || state.isSaving || isSelectedArchiving}
						onClick={() => void notesStore.saveSelected()}
					>
						<Save size={14} />
						{t("notes.actions.save")}
					</button>
				) : null}
				{showDownload ? (
					<a
						className="inline-flex items-center gap-1 rounded-md border border-[var(--inno-border)] px-3 py-1.5 text-sm hover:bg-[var(--inno-surface-muted)]"
						href={l2RawFileUrl(selected.rawPath)}
						target="_blank"
						rel="noreferrer"
					>
						<Download size={14} />
						{t("notes.download")}
					</a>
				) : null}
				{(selected.status === "draft" || selected.kind === "orphan" || isUnarchivedFile) && canArchiveNow ? (
					<button
						type="button"
						className="inline-flex items-center gap-1 rounded-md bg-[var(--inno-accent)] px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-50"
						disabled={isSelectedArchiving}
						onClick={() => void handleArchive()}
					>
						{isSelectedArchiving ? <LoaderCircle size={14} className="animate-spin" /> : <Archive size={14} />}
						{isSelectedArchiving ? t("notes.actions.archiving", "归档中...") : t("notes.actions.archive")}
					</button>
				) : null}
				{showRearchive ? (
					<button
						type="button"
						className="inline-flex items-center gap-1 rounded-md bg-[var(--inno-accent)] px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-50"
						disabled={isSelectedArchiving}
						onClick={() => void handleArchive()}
					>
						{isSelectedArchiving ? <LoaderCircle size={14} className="animate-spin" /> : <Archive size={14} />}
						{isSelectedArchiving ? t("notes.actions.archiving", "归档中...") : t("notes.actions.rearchive")}
					</button>
				) : null}
				{showOpenWiki ? (
					<button
						type="button"
						className="inline-flex items-center gap-1 rounded-md border border-[var(--inno-border)] px-3 py-1.5 text-sm hover:bg-[var(--inno-surface-muted)]"
						onClick={() => onOpenWiki!(selected.wikiPagePath!)}
					>
						<ExternalLink size={14} />
						{t("notes.actions.openWiki")}
					</button>
				) : null}
				{canUnarchive ? (
					<button
						type="button"
						className="inline-flex items-center gap-1 rounded-md border border-[var(--inno-border)] px-3 py-1.5 text-sm text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)] disabled:opacity-50"
						disabled={state.isArchiving || isSelectedArchiving}
						onClick={() => void handleUnarchive()}
					>
						<ArchiveRestore size={14} />
						{t("notes.actions.unarchive")}
					</button>
				) : null}
				{canDelete ? (
					<button
						type="button"
						className="inline-flex items-center gap-1 rounded-md border border-[var(--inno-border)] px-3 py-1.5 text-sm text-[var(--inno-text-muted)] hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
						disabled={state.isDeleting || isSelectedArchiving}
						onClick={() => void handleDelete()}
					>
						<Trash2 size={14} />
						{t("notes.actions.delete")}
					</button>
				) : null}
			</div>
		);
	}

	return (
		<div className="inno-notes-panel-shell h-full min-h-0">
			<div className="inno-notes-panel grid h-full min-h-0 grid-cols-[280px_minmax(0,1fr)] gap-3 p-3">
				<aside className="inno-notes-panel-list flex min-h-0 flex-col overflow-hidden rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)]">
				<div className="space-y-2 border-b border-[var(--inno-border)] p-2">
					<input
						type="text"
						className="w-full rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] px-3 py-1.5 text-sm focus:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-100"
						placeholder={t("notes.search") ?? ""}
						value={state.searchQuery}
						onChange={(e) => notesStore.setSearchQuery(e.target.value)}
					/>
					<div className="flex gap-1">
						<div className="relative flex flex-1" ref={templateMenuRef}>
							<button
								type="button"
								className="inline-flex flex-1 items-center justify-center gap-1 rounded-l-md border border-[var(--inno-border)] px-2 py-1 text-xs hover:bg-[var(--inno-surface-muted)] disabled:opacity-50"
								disabled={state.isCreating}
								onClick={() => void notesStore.createFromTemplate("blank")}
							>
								<Plus size={13} />
								{t("notes.actions.createDraft")}
							</button>
							<button
								type="button"
								className="inline-flex w-7 items-center justify-center rounded-r-md border border-l-0 border-[var(--inno-border)] hover:bg-[var(--inno-surface-muted)] disabled:opacity-50"
								disabled={state.isCreating}
								onClick={() => setTemplateMenuOpen((open) => !open)}
								title={t("notes.actions.templates")}
							>
								<ChevronDown size={13} />
							</button>
							{templateMenuOpen ? (
								<div className="absolute left-0 top-full z-20 mt-1 max-h-64 w-64 overflow-y-auto rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] py-1 shadow-lg">
									{templates.map((template) => (
										<button
											key={template.id}
											type="button"
											className="w-full px-3 py-2 text-left hover:bg-[var(--inno-surface-muted)]"
											onClick={() => {
												setTemplateMenuOpen(false);
												void notesStore.createFromTemplate(template.id);
											}}
										>
											<div className="text-sm font-medium">{template.label}</div>
											{template.description ? (
												<div className="text-xs text-[var(--inno-text-muted)]">{template.description}</div>
											) : null}
										</button>
									))}
								</div>
							) : null}
						</div>
						<button
							type="button"
							className="inline-flex items-center justify-center gap-1 rounded-md border border-[var(--inno-border)] px-2 py-1 text-xs hover:bg-[var(--inno-surface-muted)] disabled:opacity-50"
							disabled={state.isUploading}
							onClick={() => uploadRef.current?.click()}
							title={t("notes.actions.upload")}
						>
							<FileUp size={13} />
						</button>
						<button
							type="button"
							className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-[var(--inno-border)] hover:bg-[var(--inno-surface-muted)]"
							title={t("common.refresh")}
							onClick={() => void notesStore.loadAll()}
						>
							<RefreshCw size={13} className={state.isLoading ? "animate-spin" : ""} />
						</button>
					</div>
					<input
						ref={uploadRef}
						type="file"
						className="hidden"
						multiple
						onChange={(e) => {
							if (e.target.files?.length) void notesStore.uploadFiles(e.target.files);
							e.target.value = "";
						}}
					/>
					<div className="inline-flex w-full rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] p-0.5 text-xs">
						<button
							type="button"
							className={`flex-1 rounded px-2 py-1 ${state.listBox === "drafts" ? "bg-[var(--inno-surface)] shadow text-[var(--inno-text)]" : "text-[var(--inno-text-muted)]"}`}
							onClick={() => notesStore.setListBox("drafts")}
						>
							{t("notes.tabs.drafts", { count: state.draftCount })}
						</button>
						<button
							type="button"
							className={`flex-1 rounded px-2 py-1 ${state.listBox === "archived" ? "bg-[var(--inno-surface)] shadow text-[var(--inno-text)]" : "text-[var(--inno-text-muted)]"}`}
							onClick={() => notesStore.setListBox("archived")}
						>
							{t("notes.tabs.archived", { count: state.archivedCount })}
						</button>
					</div>
					{state.filterTag || visibleTagSummaries.length > 0 ? (
					<div className="rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] p-2">
						<div className="flex items-center justify-between gap-2">
							<button
								type="button"
								className="inline-flex min-w-0 flex-1 items-center gap-1 text-left text-[11px] font-medium uppercase tracking-wide text-[var(--inno-text-subtle)] hover:text-[var(--inno-text)]"
								onClick={() => setTagsOpen((open) => !open)}
							>
								<ChevronDown size={13} className={`shrink-0 transition-transform ${tagsOpen ? "" : "-rotate-90"}`} />
								<span className="truncate">{t("notes.properties.tags")}</span>
							</button>
							{state.filterTag ? (
								<button
									type="button"
									className="inline-flex max-w-[150px] items-center gap-1 rounded-full bg-[var(--inno-accent-soft)] px-2 py-0.5 text-xs text-[var(--inno-accent)] ring-1 ring-blue-100"
								onClick={() => notesStore.setFilterTag(null)}
									title={state.filterTag}
							>
									<span className="truncate">{state.filterTag}</span>
									<X size={12} className="shrink-0" />
							</button>
							) : null}
						</div>
						{tagsOpen ? (
							<div className="mt-1.5 flex max-h-24 flex-wrap content-start gap-1.5 overflow-y-auto pr-1">
								{visibleTagSummaries.slice(0, 24).map((tag) => (
									<button
										key={tag.displayName}
										type="button"
										className={`max-w-full rounded-full px-2 py-0.5 text-xs transition-colors ${
											state.filterTag?.toLowerCase() === tag.displayName.toLowerCase()
												? "bg-[var(--inno-accent-soft)] text-[var(--inno-accent)] ring-1 ring-blue-100"
												: "bg-[var(--inno-surface)] text-[var(--inno-text-muted)] hover:bg-slate-200 hover:text-[var(--inno-text)]"
										}`}
										onClick={() => notesStore.setFilterTag(tag.displayName)}
										title={tag.displayName}
									>
										<span className="block truncate">{tag.displayName}</span>
									</button>
								))}
							</div>
						) : null}
					</div>
					) : null}
				</div>

				<div className="min-h-0 flex-1 overflow-y-auto">
					{state.isLoading && state.notes.length === 0 ? (
						<p className="p-4 text-center text-sm text-[var(--inno-text-muted)]">{t("common.loading")}</p>
					) : null}
					{!state.isLoading && state.notes.length === 0 ? (
						<p className="p-4 text-center text-sm text-[var(--inno-text-muted)]">{t("notes.empty")}</p>
					) : null}
					{state.notes.map((note: NoteSummary) => {
						const isSelected = state.selected?.rawPath === note.rawPath;
						const isThisNoteArchiving = state.archivingRawPaths.includes(note.rawPath);
						const statusLabel = isThisNoteArchiving
							? t("notes.status.archiving", "归档中")
							: t(`notes.status.${note.status}`, note.status);
						return (
							<div
								key={`${note.kind}:${note.noteId}:${note.rawPath}`}
								className={`border-b border-[var(--inno-border)] text-sm ${isSelected ? "bg-[var(--inno-accent-soft)]" : "hover:bg-[var(--inno-surface-muted)]"}`}
							>
								<button
									type="button"
									className="w-full px-3 py-2 text-left"
									onClick={() => void notesStore.selectNote(note)}
								>
									<div className="flex items-center gap-1 truncate font-medium">
										<FileText size={13} className="shrink-0 text-[var(--inno-text-muted)]" />
										<span className="truncate">{note.title}</span>
									</div>
									<div className="mt-1 flex flex-wrap gap-2 text-xs text-[var(--inno-text-muted)]">
										<span>{statusLabel}</span>
										{note.size ? <span>{formatSize(note.size)}</span> : null}
									</div>
								</button>
								{note.tags.length > 0 ? (
									<div className="flex flex-wrap gap-1 px-3 pb-2">
										{note.tags.slice(0, 5).map((tag) => (
											<button
												key={tag}
												type="button"
												className={`rounded-full px-1.5 py-0.5 text-xs transition-colors ${
													state.filterTag?.toLowerCase() === tag.toLowerCase()
														? "bg-[var(--inno-accent-soft)] text-[var(--inno-accent)] ring-1 ring-blue-100"
														: "bg-[var(--inno-surface-muted)] text-[var(--inno-text-muted)] hover:bg-slate-200 hover:text-[var(--inno-text)]"
												}`}
												onClick={() => notesStore.setFilterTag(tag)}
											>
												#{tag}
											</button>
										))}
									</div>
								) : null}
							</div>
						);
					})}
				</div>
			</aside>

				<section className="inno-notes-panel-detail flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)]">
				{state.notice ? (
					<p className="border-b border-emerald-100 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
						{t(`notes.flash.${state.notice}`)}
					</p>
				) : null}
				{state.error ? (
					<p className="border-b border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700">
						{t(`notes.flash.${state.error}`)}
					</p>
				) : null}
				{state.isArchiving ? (
					<p className="flex items-center gap-2 border-b border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-700">
						<LoaderCircle size={13} className="animate-spin" />
						{t("notes.flash.archiving", "正在归档到 Wiki...")}
					</p>
				) : null}

				{!selected ? (
					<div className="flex flex-1 items-center justify-center p-6 text-sm text-[var(--inno-text-muted)]">
						{t("notes.selectHint")}
					</div>
				) : isMarkdown ? (
					<div className="flex min-h-0 flex-1 flex-col">
						<div className="inno-milkdown-editor-shell min-h-0 flex-1 overflow-hidden">
							{state.isLoadingContent ? (
								<p className="p-4 text-sm text-[var(--inno-text-muted)]">{t("common.loading")}</p>
							) : (
								<>
									<NoteProperties
										editorKey={selected.rawPath}
										title={state.editorTitle}
										tags={state.editorTags}
										recordDate={state.editorRecordDate}
										onTitleChange={(title) => notesStore.updateEditorTitle(title)}
										onTagsChange={(tags) => notesStore.updateEditorTags(tags)}
										onRecordDateChange={(recordDate) => notesStore.updateEditorRecordDate(recordDate)}
									/>
									<MilkdownEditor
										key={selected.rawPath}
										editorKey={selected.rawPath}
										value={state.editorContent}
										onChange={(value) => notesStore.updateEditorContent(value)}
									/>
								</>
							)}
						</div>
						{!state.isLoadingContent && selected ? (
							<NoteAttachments
								attachments={state.attachments}
								isUploading={state.isUploadingAttachment}
								deletingAttachmentId={state.deletingAttachmentId}
								onUpload={(files) => notesStore.uploadAttachments(files)}
								onDelete={(attachmentId) => notesStore.deleteAttachment(attachmentId)}
							/>
						) : null}
						{renderBottomActions()}
					</div>
				) : (
					<div className="flex min-h-0 flex-1 flex-col">
						<div className="border-b border-[var(--inno-border)] px-4 py-3">
							<div className="min-w-0">
								<h3 className="truncate font-medium">{selected.title}</h3>
								<p className="truncate text-xs text-[var(--inno-text-muted)]">{selected.rawPath}</p>
							</div>
						</div>
						<div className={`min-h-0 flex-1 ${selected.contentType === "markdown" || selected.contentType === "pdf" || selected.contentType === "image" ? "overflow-hidden" : "overflow-auto p-4"}`}>
							{state.isLoadingPreview ? (
								<p className="p-4 text-sm text-[var(--inno-text-muted)]">{t("common.loading")}</p>
							) : selected.contentType === "markdown" ? (
								<MilkdownEditor
									editorKey={`${selected.rawPath}:raw`}
									value={normalizeMarkdownMath(state.previewContent)}
									onChange={(value) => notesStore.updatePreviewContent(value)}
								/>
							) : selected.contentType === "pdf" ? (
								<iframe
									className="h-full w-full border-0 bg-[var(--inno-surface)]"
									src={`${l2RawFileUrl(selected.rawPath)}#view=FitH&zoom=page-width`}
									title={rawFileName(selected.rawPath)}
								/>
							) : selected.contentType === "image" ? (
								<div className="flex h-full items-center justify-center overflow-auto bg-[var(--inno-surface-muted)] p-4">
									<img
										className="max-h-full max-w-full object-contain"
										src={l2RawFileUrl(selected.rawPath)}
										alt={rawFileName(selected.rawPath)}
									/>
								</div>
							) : state.previewContent ? (
								<pre className="whitespace-pre-wrap text-sm">{state.previewContent}</pre>
							) : (
								<p className="p-4 text-sm text-[var(--inno-text-muted)]">{t("notes.previewBinaryHint")}</p>
							)}
						</div>
						{renderBottomActions()}
					</div>
				)}
				</section>
			</div>
		</div>
	);
}
