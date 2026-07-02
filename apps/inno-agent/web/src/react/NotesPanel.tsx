import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MilkdownEditor } from "./notebook/MilkdownEditor.js";
import { NoteAttachments } from "./notebook/NoteAttachments.js";
import { NoteProperties } from "./notebook/NoteProperties.js";
import {
	Archive,
	ChevronDown,
	Download,
	ExternalLink,
	FileText,
	FileUp,
	Plus,
	RefreshCw,
	Save,
} from "lucide-react";
import { getVisibleNoteTemplates } from "../lib/build-note-from-template.js";
import { l2RawFileUrl } from "../api/notes.js";
import { notesStore } from "../stores/notes-store.js";
import type { NoteSummary } from "../types/notes.js";
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

export function NotesPanel({ onOpenWiki }: NotesPanelProps) {
	const { t } = useTranslation();
	const [templateMenuOpen, setTemplateMenuOpen] = useState(false);
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
		isUploading: notesStore.isUploading,
		searchQuery: notesStore.searchQuery,
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

	const selected = state.selected;
	const isMarkdown = selected?.kind === "markdown";
	const showRearchive = selected?.kind === "markdown" && selected.status === "outdated";
	const showOpenWiki = Boolean(selected?.wikiPagePath && onOpenWiki);
	const showDownload = selected && !isMarkdown;
	const canArchiveNow =
		selected &&
		(selected.kind === "orphan" ||
			(selected.kind === "markdown" && (selected.status === "draft" || selected.status === "outdated")));

	function renderBottomActions() {
		if (!selected) return null;
		const hasActions =
			showDownload ||
			(canArchiveNow && (selected.status === "draft" || selected.kind === "orphan")) ||
			showRearchive ||
			showOpenWiki;
		if (!hasActions) return null;
		return (
			<div className="flex flex-wrap gap-2 border-t border-[var(--inno-border)] p-3">
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
				{(selected.status === "draft" || selected.kind === "orphan") && canArchiveNow ? (
					<button
						type="button"
						className="inline-flex items-center gap-1 rounded-md bg-[var(--inno-accent)] px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-50"
						disabled={state.isArchiving}
						onClick={() => void handleArchive()}
					>
						<Archive size={14} />
						{t("notes.actions.archive")}
					</button>
				) : null}
				{showRearchive ? (
					<button
						type="button"
						className="inline-flex items-center gap-1 rounded-md bg-[var(--inno-accent)] px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-50"
						disabled={state.isArchiving}
						onClick={() => void handleArchive()}
					>
						<Archive size={14} />
						{t("notes.actions.rearchive")}
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
			</div>
		);
	}

	return (
		<div className="grid h-full min-h-0 grid-cols-[280px_minmax(0,1fr)] gap-3 p-3">
			<aside className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)]">
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
						return (
							<button
								key={note.rawPath}
								type="button"
								className={`w-full border-b border-[var(--inno-border)] px-3 py-2 text-left text-sm ${isSelected ? "bg-[var(--inno-accent-soft)]" : "hover:bg-[var(--inno-surface-muted)]"}`}
								onClick={() => void notesStore.selectNote(note)}
							>
								<div className="flex items-center gap-1 truncate font-medium">
									<FileText size={13} className="shrink-0 text-[var(--inno-text-muted)]" />
									<span className="truncate">{note.title}</span>
								</div>
								<div className="mt-1 flex flex-wrap gap-2 text-xs text-[var(--inno-text-muted)]">
									<span>{t(`notes.itemType.${note.kind}`, note.kind)}</span>
									<span>{t(`notes.status.${note.status}`, note.status)}</span>
									{note.size ? <span>{formatSize(note.size)}</span> : null}
									{note.tags.slice(0, 2).map((tag) => (
										<span key={tag}>#{tag}</span>
									))}
								</div>
							</button>
						);
					})}
				</div>
			</aside>

			<section className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)]">
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

				{!selected ? (
					<div className="flex flex-1 items-center justify-center p-6 text-sm text-[var(--inno-text-muted)]">
						{t("notes.selectHint")}
					</div>
				) : isMarkdown ? (
					<div className="flex min-h-0 flex-1 flex-col">
						<div className="flex items-center justify-end border-b border-[var(--inno-border)] px-4 py-2">
							<button
								type="button"
								className="inline-flex items-center gap-1 rounded-md border border-[var(--inno-border)] px-2 py-1 text-xs hover:bg-[var(--inno-surface-muted)] disabled:opacity-50"
								disabled={!state.isDirty || state.isSaving}
								onClick={() => void notesStore.saveSelected()}
							>
								<Save size={13} />
								{t("notes.actions.save")}
							</button>
						</div>
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
							<h3 className="font-medium">{selected.title}</h3>
							<p className="text-xs text-[var(--inno-text-muted)]">{selected.rawPath}</p>
						</div>
						<div className="min-h-0 flex-1 overflow-auto p-4">
							{state.isLoadingPreview ? (
								<p className="text-sm text-[var(--inno-text-muted)]">{t("common.loading")}</p>
							) : state.previewContent ? (
								<pre className="whitespace-pre-wrap text-sm">{state.previewContent}</pre>
							) : (
								<p className="text-sm text-[var(--inno-text-muted)]">{t("notes.previewBinaryHint")}</p>
							)}
						</div>
						{renderBottomActions()}
					</div>
				)}
			</section>
		</div>
	);
}
