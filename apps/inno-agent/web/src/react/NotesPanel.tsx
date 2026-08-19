import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MilkdownEditor } from "./notebook/MilkdownEditor.js";
import { NoteAttachments } from "./notebook/NoteAttachments.js";
import { NoteProperties } from "./notebook/NoteProperties.js";
import {
	Archive,
	ArchiveRestore,
	Download,
	ExternalLink,
	FileText,
	FileUp,
	History,
	LoaderCircle,
	MessageSquareText,
	RefreshCw,
	Save,
	Sparkles,
	Trash2,
} from "lucide-react";
import { l2RawFileUrl } from "../api/notes.js";
import { notesStore } from "../stores/notes-store.js";
import type { NoteSummary } from "../types/notes.js";
import { useStoreSnapshot } from "./hooks.js";
import { MeetingProgress, MeetingRecorder } from "./meetings/MeetingRecorder.js";
import { meetingStore } from "../stores/meeting-store.js";
import { TemplateEditor } from "./note-templates/TemplateEditor.js";
import { TemplateMenu } from "./note-templates/TemplateMenu.js";
import { TemplateSidebar } from "./note-templates/TemplateSidebar.js";
import { noteTemplateStore } from "../stores/note-template-store.js";
import { VersionHistoryDialog } from "./notebook/VersionHistoryDialog.js";

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
	const [templateMode, setTemplateMode] = useState(false);
	const [historyOpen, setHistoryOpen] = useState(false);
	const uploadRef = useRef<HTMLInputElement>(null);
	const meetingState = useStoreSnapshot(meetingStore, () => meetingStore.state);
	const state = useStoreSnapshot(notesStore, () => ({
		notes: notesStore.filteredNotes,
		aiContextRawPaths: notesStore.aiContextRawPaths,
		aiContextNotes: notesStore.aiContextNotes,
		aiContextLimit: notesStore.aiContextLimit,
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
		isPolishing: notesStore.isPolishing,
		isArchiving: notesStore.isArchiving,
		isDeleting: notesStore.isDeleting,
		isUploading: notesStore.isUploading,
		searchQuery: notesStore.searchQuery,
		filterTag: notesStore.filterTag,
		tagSummaries: notesStore.tagSummaries,
		notice: notesStore.notice,
		polishTemplateLabel: notesStore.polishTemplateLabel,
		error: notesStore.error,
	}));
	const focusChatWithSummaryPrompt = useCallback(() => {
		const input = document.getElementById("chat-input") as HTMLTextAreaElement | null;
		if (!input) return;
		if (!input.value.trim()) {
			input.value = t("notes.context.defaultPrompt");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		}
		input.focus();
	}, [t]);

	useEffect(() => {
		void notesStore.loadAll();
	}, []);

	const openTemplates = useCallback(async (create = false) => {
		if (!(await notesStore.saveSelected())) return;
		await noteTemplateStore.load();
		if (create) noteTemplateStore.startCreate();
		else if (!noteTemplateStore.selectedId && noteTemplateStore.templates[0]) noteTemplateStore.select(noteTemplateStore.templates[0].id);
		setTemplateMode(true);
	}, []);
	const closeTemplates = useCallback(() => {
		if (noteTemplateStore.isDirty && typeof window !== "undefined" && !window.confirm(t("notes.templates.discardConfirm"))) return;
		setTemplateMode(false);
	}, [t]);

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

	const openHistory = useCallback(async () => {
		if (!(await notesStore.saveSelected())) return;
		setHistoryOpen(true);
	}, []);

	const reloadAfterRestore = useCallback(async () => {
		const rawPath = notesStore.selected?.rawPath;
		if (!rawPath) return;
		await notesStore.loadAll();
		const restored = notesStore.notes.find((note) => note.rawPath === rawPath);
		if (restored) await notesStore.selectNote(restored);
	}, []);

	const selected = state.selected;
	const isMarkdown = selected?.kind === "markdown";
	const isRawEditableMarkdown = Boolean(selected && selected.kind !== "markdown" && selected.contentType === "markdown");
	const showRearchive =
		(selected?.kind === "markdown" || selected?.kind === "archived") && selected.status === "outdated";
	const showOpenWiki = Boolean(selected?.wikiPagePath && onOpenWiki);
	const showDownload = selected && !isMarkdown;
	const canArchiveNow =
		selected &&
		(selected.kind === "orphan" ||
			(selected.kind === "archived" && selected.status === "outdated") ||
			(selected.kind === "markdown" && (selected.status === "draft" || selected.status === "outdated")));
	const canDelete = Boolean(
		selected && (selected.kind === "orphan" || (selected.kind === "markdown" && selected.status === "draft")),
	);
	const canUnarchive = Boolean(
		selected && (selected.kind === "archived" || (selected.kind === "markdown" && selected.status !== "draft")),
	);
	const meetingBusy = ["connecting", "recording", "paused", "finishing", "importing", "summarizing"].includes(meetingState);

	const handleFiles = useCallback(async (files: FileList) => {
		const audioExtensions = new Set(["wav", "mp3", "m4a", "webm", "ogg", "mp4", "aac", "flac"]);
		const all = Array.from(files);
		const audio = all.filter((file) => audioExtensions.has(file.name.split(".").pop()?.toLowerCase() ?? ""));
		const documents = all.filter((file) => !audio.includes(file));
		for (const file of audio) await meetingStore.importAudio(file);
		if (documents.length) await notesStore.uploadFiles(documents);
	}, []);

	function renderBottomActions() {
		if (!selected) return null;
		const hasActions =
			isRawEditableMarkdown ||
			showDownload ||
			(canArchiveNow && (selected.status === "draft" || selected.kind === "orphan")) ||
			showRearchive ||
			canDelete ||
			canUnarchive ||
			showOpenWiki;
		if (!hasActions) return null;
		return (
			<div className="flex flex-wrap gap-2 border-t border-[var(--inno-border)] p-3">
				{isRawEditableMarkdown ? (
					<button
						type="button"
						className="inline-flex items-center gap-1 rounded-md border border-[var(--inno-border)] px-3 py-1.5 text-sm hover:bg-[var(--inno-surface-muted)] disabled:opacity-50"
						disabled={!state.isDirty || state.isSaving}
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
				{(selected.status === "draft" || selected.kind === "orphan") && canArchiveNow ? (
					<button
						type="button"
						className="inline-flex items-center gap-1 rounded-md bg-[var(--inno-accent)] px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-50"
						disabled={state.isArchiving}
						onClick={() => void handleArchive()}
					>
						{state.isArchiving ? <LoaderCircle size={14} className="animate-spin" /> : <Archive size={14} />}
						{state.isArchiving ? t("notes.actions.archiving") : t("notes.actions.archive")}
					</button>
				) : null}
				{showRearchive ? (
					<button
						type="button"
						className="inline-flex items-center gap-1 rounded-md bg-[var(--inno-accent)] px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-50"
						disabled={state.isArchiving}
						onClick={() => void handleArchive()}
					>
						{state.isArchiving ? <LoaderCircle size={14} className="animate-spin" /> : <Archive size={14} />}
						{state.isArchiving ? t("notes.actions.archiving") : t("notes.actions.rearchive")}
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
				{canDelete ? (
					<button
						type="button"
						className="inline-flex items-center gap-1 rounded-md border border-[var(--inno-border)] px-3 py-1.5 text-sm text-[var(--inno-text-muted)] hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
						disabled={state.isDeleting}
						onClick={() => void handleDelete()}
					>
						<Trash2 size={14} />
						{t("notes.actions.delete")}
					</button>
				) : null}
				{canUnarchive ? (
					<button
						type="button"
						className="inline-flex items-center gap-1 rounded-md border border-[var(--inno-border)] px-3 py-1.5 text-sm text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)] disabled:opacity-50"
						disabled={state.isArchiving}
						onClick={() => void handleUnarchive()}
					>
						<ArchiveRestore size={14} />
						{t("notes.actions.unarchive")}
					</button>
				) : null}
			</div>
		);
	}

	if (templateMode) {
		return (
			<div className="grid h-full min-h-0 grid-cols-[280px_minmax(0,1fr)] gap-3 p-3">
				<TemplateSidebar onBack={closeTemplates} />
				<TemplateEditor />
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
						<TemplateMenu
							isCreating={state.isCreating}
							onCreateBlank={() => void notesStore.createFromTemplate("blank")}
							onUseTemplate={(id) => void notesStore.createFromTemplate(id)}
							onCreateTemplate={() => void openTemplates(true)}
							onManageTemplates={() => void openTemplates(false)}
						/>
						<button
							type="button"
							className="inline-flex items-center justify-center gap-1 rounded-md border border-[var(--inno-border)] px-2 py-1 text-xs hover:bg-[var(--inno-surface-muted)] disabled:opacity-50"
							disabled={state.isUploading || meetingBusy}
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
							if (e.target.files?.length) void handleFiles(e.target.files);
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
					{state.tagSummaries.length > 0 ? (
						<select
							className="w-full rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] px-2 py-1 text-xs text-[var(--inno-text-muted)] outline-none"
							value={state.filterTag ?? ""}
							onChange={(event) => notesStore.setFilterTag(event.target.value || null)}
							aria-label={t("notes.properties.tags")}
						>
							<option value="">{t("notes.tagFilterAll")}</option>
							{state.tagSummaries.map((tag) => (
								<option key={tag.displayName.toLocaleLowerCase()} value={tag.displayName}>
									#{tag.displayName} ({tag.usageCount})
								</option>
							))}
						</select>
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
						const isInAiContext = state.aiContextRawPaths.has(note.rawPath);
						const canUseAsAiContext = notesStore.canUseAsAiContext(note);
						return (
							<div
								key={note.rawPath}
								className={`flex w-full border-b border-[var(--inno-border)] text-sm ${isSelected ? "bg-[var(--inno-accent-soft)]" : "hover:bg-[var(--inno-surface-muted)]"}`}
							>
								<label className={`flex w-8 shrink-0 items-center justify-center ${canUseAsAiContext ? "cursor-pointer" : "cursor-not-allowed opacity-40"}`} title={canUseAsAiContext ? t("notes.context.add") : t("notes.context.unavailable")}>
									<input type="checkbox" checked={isInAiContext} disabled={!canUseAsAiContext || (!isInAiContext && state.aiContextRawPaths.size >= state.aiContextLimit)} onChange={() => notesStore.toggleAiContext(note)} />
								</label>
								<button type="button" className="min-w-0 flex-1 px-1 py-2 pr-3 text-left" onClick={() => void notesStore.selectNote(note)}>
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
							</div>
						);
					})}
				</div>
				{state.aiContextNotes.length ? (
					<div className="shrink-0 border-t border-[var(--inno-border)] bg-[var(--inno-accent-soft)] p-2">
						<div className="mb-2 flex items-center justify-between text-xs text-[var(--inno-text-muted)]"><span>{t("notes.context.selected", { count: state.aiContextNotes.length, limit: state.aiContextLimit })}</span><button type="button" className="text-[var(--inno-accent)] hover:underline" onClick={() => notesStore.clearAiContext()}>{t("notes.context.clear")}</button></div>
						<button type="button" className="inno-primary-button flex h-8 w-full items-center justify-center gap-1.5 rounded-md text-xs" onClick={focusChatWithSummaryPrompt}><MessageSquareText size={13} />{t("notes.context.useInChat")}</button>
					</div>
				) : null}
			</aside>

			<section className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)]">
				{state.notice ? (
					<p className="border-b border-emerald-100 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
						{t(`notes.flash.${state.notice}`, { template: state.polishTemplateLabel ?? "" })}
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
						{t("notes.flash.archiving")}
					</p>
				) : null}
				{selected ? <MeetingProgress rawPath={selected.rawPath} meetingId={selected.meetingId} /> : null}

				{!selected ? (
					<div className="flex flex-1 items-center justify-center p-6 text-sm text-[var(--inno-text-muted)]">
						{t("notes.selectHint")}
					</div>
				) : isMarkdown ? (
					<div className="flex min-h-0 flex-1 flex-col">
						<div className="flex items-center justify-end gap-2 border-b border-[var(--inno-border)] px-4 py-2">
							<button
								type="button"
								className="inline-flex items-center gap-1 rounded-md border border-[var(--inno-border)] px-2 py-1 text-xs hover:bg-[var(--inno-surface-muted)]"
								onClick={() => void openHistory()}
							>
								<History size={13} />
								{t("notes.history.title")}
							</button>
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
										onUploadImage={(file) => notesStore.uploadInlineImage(file)}
										resolveImageUrl={(url) => notesStore.resolveInlineImageUrl(url)}
										toolbarAction={(<>
											<MeetingRecorder toolbar rawPath={selected.rawPath} title={state.editorTitle || selected.title} />
											<button
												type="button"
												className="top-bar-item inno-milkdown-polish-button"
												disabled={state.isPolishing || !state.editorContent.trim() || state.isArchiving}
												onClick={() => void notesStore.polishSelected()}
												title={state.isPolishing ? t("notes.actions.polishing") : t("notes.actions.polish")}
											>
												{state.isPolishing ? <LoaderCircle size={17} className="animate-spin" /> : <Sparkles size={17} />}
											</button>
										</>)}
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
						<div className={`min-h-0 flex-1 ${isRawEditableMarkdown || selected.contentType === "pdf" || selected.contentType === "image" ? "overflow-hidden" : "overflow-auto p-4"}`}>
							{state.isLoadingPreview ? (
								<p className="p-4 text-sm text-[var(--inno-text-muted)]">{t("common.loading")}</p>
							) : isRawEditableMarkdown ? (
								<MilkdownEditor
									editorKey={`${selected.rawPath}:raw`}
									value={state.previewContent}
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
			{selected?.kind === "markdown" ? (
				<VersionHistoryDialog
					open={historyOpen}
					rawPath={selected.rawPath}
					onClose={() => setHistoryOpen(false)}
					onRestored={reloadAfterRestore}
				/>
			) : null}
		</div>
	);
}
