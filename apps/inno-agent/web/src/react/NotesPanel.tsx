import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
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
	MessageSquareText,
	Save,
	Sparkles,
	Square,
	Trash2,
	X,
} from "lucide-react";
import { l2RawFileUrl } from "../api/notes.js";
import { notesStore } from "../stores/notes-store.js";
import type { NoteSummary } from "../types/notes.js";
import { normalizeMarkdownMath } from "../utils/markdown-math.js";
import { useStoreSnapshot } from "./hooks.js";
import { MeetingProgress, MeetingRecorder } from "./meetings/MeetingRecorder.js";
import { meetingStore } from "../stores/meeting-store.js";
import { chatStore } from "../stores/chat-store.js";
import { sessionsStore } from "../stores/sessions-store.js";
import { appStore } from "../stores/app-store.js";
import { workspaceStore } from "../stores/workspace-store.js";
import { noteTemplateStore } from "../stores/note-template-store.js";
import { TemplateEditor } from "./note-templates/TemplateEditor.js";
import { TemplateMenu } from "./note-templates/TemplateMenu.js";
import { TemplateSidebar } from "./note-templates/TemplateSidebar.js";

interface NotesPanelProps {
	viewSelector?: ReactNode;
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

const NOTE_POLISH_SESSIONS_KEY = "inno.notePolishSessions";

function readNotePolishSessions(): Record<string, string> {
	if (typeof window === "undefined") return {};
	try {
		const parsed = JSON.parse(window.localStorage.getItem(NOTE_POLISH_SESSIONS_KEY) ?? "{}");
		return parsed && typeof parsed === "object" ? parsed as Record<string, string> : {};
	} catch {
		return {};
	}
}

function rememberNotePolishSession(rawPath: string, sessionId: string): void {
	if (typeof window === "undefined") return;
	const sessions = readNotePolishSessions();
	sessions[rawPath] = sessionId;
	window.localStorage.setItem(NOTE_POLISH_SESSIONS_KEY, JSON.stringify(sessions));
}

export function NotesPanel({ viewSelector, onOpenWiki }: NotesPanelProps) {
	const { t } = useTranslation();
	const [panelMode, setPanelMode] = useState<"notes" | "templates">("notes");
	const [tagsOpen, setTagsOpen] = useState(false);
	const [isConversationalPolishing, setIsConversationalPolishing] = useState(false);
	const panelRef = useRef<HTMLDivElement>(null);
	const uploadRef = useRef<HTMLInputElement>(null);
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
		archivingRawPath: notesStore.archivingRawPath,
		archivingRawPaths: notesStore.archivingRawPaths,
		isDeleting: notesStore.isDeleting,
		isUploading: notesStore.isUploading,
		searchQuery: notesStore.searchQuery,
		filterTag: notesStore.filterTag,
		tagSummaries: notesStore.tagSummaries,
		availableTags: notesStore.availableTags,
		notice: notesStore.notice,
		polishTemplateLabel: notesStore.polishTemplateLabel,
		polishSuggestedTags: notesStore.polishSuggestedTags,
		error: notesStore.error,
		errorDetail: notesStore.errorDetail,
	}));
	const meetingState = useStoreSnapshot(meetingStore, () => meetingStore.state);
	const chatIsSending = useStoreSnapshot(chatStore, () => chatStore.isSending);

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

	useEffect(() => {
		const handleSaveShortcut = (event: KeyboardEvent) => {
			if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== "s") return;
			const target = event.target;
			if (!(target instanceof Node) || !panelRef.current?.contains(target)) return;
			const note = notesStore.selected;
			const editable = note?.kind === "markdown" || (note?.kind === "orphan" && note.contentType === "markdown");
			if (!editable) return;
			event.preventDefault();
			if (notesStore.isSaving || notesStore.archivingRawPaths.includes(note.rawPath) || !notesStore.isDirty) return;
			void notesStore.saveSelected();
		};
		window.addEventListener("keydown", handleSaveShortcut);
		return () => window.removeEventListener("keydown", handleSaveShortcut);
	}, []);

	async function handleConversationalPolish(): Promise<void> {
		const note = notesStore.selected;
		if (!note || note.kind !== "markdown" || chatStore.isSending || isConversationalPolishing) return;
		setIsConversationalPolishing(true);
		try {
			if (!(await notesStore.saveSelected())) return;
			if (appStore.workspaceMode === "full") {
				if (appStore.workspaceWidth > 640) appStore.setWorkspaceWidth(560);
				appStore.setWorkspaceMode("half");
			}
			const noteTitle = notesStore.editorTitle.trim() || note.title;
			const mappedSessionId = readNotePolishSessions()[note.rawPath];
			let openedMappedSession = false;
			if (mappedSessionId) {
				await sessionsStore.refresh();
				if (sessionsStore.sessions.some((session) => session.id === mappedSessionId)) {
					if (sessionsStore.currentSessionId !== mappedSessionId) {
						await sessionsStore.openSession(mappedSessionId);
					}
					openedMappedSession = true;
				}
			}
			if (!openedMappedSession) {
				const workspaceId = sessionsStore.preselectedWorkspaceId ?? workspaceStore.activeWorkspaceId;
				await sessionsStore.createSessionWith(workspaceId ? { workspaceId } : {});
				const sessionId = sessionsStore.currentSessionId;
				if (!sessionId) throw new Error("Failed to create note polish session");
				rememberNotePolishSession(note.rawPath, sessionId);
				await sessionsStore.renameSession(sessionId, `AI 润色：${noteTitle}`);
			}
			const prompt = `对“${noteTitle}”笔记进行 AI 润色。\n\n` +
				`<inno-internal-context>\nnote_raw_path: ${note.rawPath}\n</inno-internal-context>`;
			await chatStore.send(
				prompt,
				undefined,
				t("notes.actions.polishingNote", { title: noteTitle }),
			);
			await notesStore.reloadNoteIfSelected(note.rawPath);
		} finally {
			setIsConversationalPolishing(false);
		}
	}

	async function handleUploadedFiles(files: FileList): Promise<void> {
		if (["connecting", "recording", "paused", "finishing", "importing", "summarizing"].includes(meetingState)) return;
		const audioExtensions = new Set(["wav", "mp3", "m4a", "webm", "ogg", "mp4", "aac", "flac"]);
		const all = Array.from(files);
		const audioFiles = all.filter((file) => audioExtensions.has(file.name.split(".").pop()?.toLowerCase() ?? ""));
		const otherFiles = all.filter((file) => !audioFiles.includes(file));
		for (const file of audioFiles) await meetingStore.importAudio(file);
		if (otherFiles.length > 0) await notesStore.uploadFiles(otherFiles);
	}

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
	const isRawEditableMarkdown = Boolean(selected && selected.kind === "orphan" && selected.contentType === "markdown");
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
	const canPolish = Boolean(
		selected?.kind === "markdown" &&
		selected.meetingStatus !== "recording" &&
		selected.meetingStatus !== "summarizing",
	);
	const isSelectedArchiving = Boolean(selected && state.archivingRawPaths.includes(selected.rawPath));
	const isEmptyNoteForArchive = Boolean(
		selected?.kind === "markdown" && !state.editorContent.trim() && state.attachments.length === 0,
	);
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
			<div className="flex flex-wrap items-center gap-2 border-t border-[var(--inno-border)] bg-[var(--inno-surface)] px-3 py-2.5">
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
						className={`inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 ${isSelectedArchiving ? "bg-red-600" : "bg-[var(--inno-accent)]"}`}
						disabled={isEmptyNoteForArchive && !isSelectedArchiving}
						title={isEmptyNoteForArchive ? t("notes.flash.emptyCannotArchive") : undefined}
						onClick={() => isSelectedArchiving ? notesStore.stopArchive(selected.rawPath) : void handleArchive()}
					>
						{isSelectedArchiving ? <Square size={13} fill="currentColor" /> : <Archive size={14} />}
						{isSelectedArchiving ? t("notes.actions.stopArchiving") : t("notes.actions.archive")}
					</button>
				) : null}
				{isEmptyNoteForArchive ? (
					<span className="text-xs text-amber-700">{t("notes.flash.emptyCannotArchive")}</span>
				) : null}
				{showRearchive ? (
					<button
						type="button"
						className={`inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-sm text-white hover:opacity-90 ${isSelectedArchiving ? "bg-red-600" : "bg-[var(--inno-accent)]"}`}
						onClick={() => isSelectedArchiving ? notesStore.stopArchive(selected.rawPath) : void handleArchive()}
					>
						{isSelectedArchiving ? <Square size={13} fill="currentColor" /> : <Archive size={14} />}
						{isSelectedArchiving ? t("notes.actions.stopArchiving") : t("notes.actions.rearchive")}
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
						className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-red-200 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50"
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

	function openTemplateManager(create = false): void {
		setPanelMode("templates");
		void noteTemplateStore.load().then(() => {
			if (create) noteTemplateStore.startCreate();
			else if (!noteTemplateStore.selectedId && noteTemplateStore.templates.length > 0) {
				noteTemplateStore.select(noteTemplateStore.templates[0].id);
			}
		});
	}

	function closeTemplateManager(): void {
		if (noteTemplateStore.isDirty && !window.confirm(t("notes.templates.discardConfirm", "当前模板尚未保存，是否放弃修改？"))) return;
		setPanelMode("notes");
	}

	if (panelMode === "templates") {
		return (
			<div ref={panelRef} className="grid h-full min-h-0 grid-cols-[280px_minmax(0,1fr)]">
				<TemplateSidebar viewSelector={viewSelector} onBack={closeTemplateManager} />
				<TemplateEditor />
			</div>
		);
	}

	return (
		<div ref={panelRef} className="inno-notes-panel-shell h-full min-h-0">
			<div className="inno-notes-panel grid h-full min-h-0 grid-cols-[280px_minmax(0,1fr)]">
				<aside className="inno-notes-panel-list flex min-h-0 flex-col overflow-hidden border-r border-[var(--inno-border)] bg-[var(--inno-workspace-chrome)]">
				<div className="space-y-2 border-b border-[var(--inno-border)] p-3">
					{viewSelector}
					<input
						type="text"
						className="w-full rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] px-3 py-1.5 text-sm focus:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-100"
						placeholder={t("notes.search") ?? ""}
						value={state.searchQuery}
						onChange={(e) => notesStore.setSearchQuery(e.target.value)}
					/>
					<div className="grid grid-cols-[minmax(0,1fr)_auto] gap-1.5">
						<TemplateMenu
							isCreating={state.isCreating}
							onCreateBlank={() => void notesStore.createFromTemplate("blank")}
							onUseTemplate={(id) => void notesStore.createFromTemplate(id)}
							onCreateTemplate={() => openTemplateManager(true)}
							onManageTemplates={() => openTemplateManager(false)}
						/>
						<button
							type="button"
							className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-[var(--inno-border)] px-2.5 text-xs font-medium text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)] disabled:opacity-50"
							disabled={state.isUploading || ["connecting", "recording", "paused", "finishing", "importing", "summarizing"].includes(meetingState)}
							onClick={() => uploadRef.current?.click()}
							title={t("notes.actions.upload")}
							aria-label={t("notes.actions.upload")}
						>
							{state.isUploading ? <LoaderCircle size={13} className="animate-spin" /> : <FileUp size={13} />}
							<span>{t("notes.actions.upload")}</span>
						</button>
					</div>
					<input
						ref={uploadRef}
						type="file"
						className="hidden"
						multiple
						onChange={(e) => {
							if (e.target.files?.length) void handleUploadedFiles(e.target.files);
							e.target.value = "";
						}}
					/>
					<div className="flex w-full border-b border-[var(--inno-border)] text-xs">
						<button
							type="button"
							className={`flex-1 border-b-2 px-2 py-1.5 transition-colors ${state.listBox === "drafts" ? "border-[var(--inno-accent)] font-medium text-[var(--inno-accent)]" : "border-transparent text-[var(--inno-text-muted)] hover:text-[var(--inno-text)]"}`}
							onClick={() => notesStore.setListBox("drafts")}
						>
							{t("notes.tabs.drafts", { count: state.draftCount })}
						</button>
						<button
							type="button"
							className={`flex-1 border-b-2 px-2 py-1.5 transition-colors ${state.listBox === "archived" ? "border-[var(--inno-accent)] font-medium text-[var(--inno-accent)]" : "border-transparent text-[var(--inno-text-muted)] hover:text-[var(--inno-text)]"}`}
							onClick={() => notesStore.setListBox("archived")}
						>
							{t("notes.tabs.archived", { count: state.archivedCount })}
						</button>
					</div>
					{state.filterTag || visibleTagSummaries.length > 0 ? (
					<div className="bg-[var(--inno-surface-muted)]/70 px-1 py-1.5">
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
						const isInAiContext = state.aiContextRawPaths.has(note.rawPath);
						const canUseAsAiContext = notesStore.canUseAsAiContext(note);
						const isThisNoteArchiving = state.archivingRawPaths.includes(note.rawPath);
						const statusLabel = isThisNoteArchiving
							? t("notes.status.archiving", "归档中")
							: t(`notes.status.${note.status}`, note.status);
						return (
							<div
								key={`${note.kind}:${note.noteId}:${note.rawPath}`}
								className={`border-b border-l-2 border-[var(--inno-border)] text-sm transition-colors ${isSelected ? "border-l-[var(--inno-accent)] bg-[var(--inno-accent-soft)]" : "border-l-transparent hover:bg-[var(--inno-surface-muted)]"}`}
							>
								<div className="flex items-start">
									<label className={`flex h-9 w-9 shrink-0 items-center justify-center ${canUseAsAiContext ? "cursor-pointer" : "cursor-not-allowed opacity-40"}`} title={canUseAsAiContext ? t("notes.context.add") : t("notes.context.unavailable")}>
										<input
											type="checkbox"
											className="h-3.5 w-3.5 rounded border-[var(--inno-border)] accent-[var(--inno-accent)]"
											checked={isInAiContext}
											disabled={!canUseAsAiContext || (!isInAiContext && state.aiContextRawPaths.size >= state.aiContextLimit)}
											onChange={() => notesStore.toggleAiContext(note)}
										/>
									</label>
									<button
									type="button"
									className="min-w-0 flex-1 py-2 pr-3 text-left"
									onClick={() => void notesStore.selectNote(note)}
								>
									<div className="flex items-center gap-1 truncate font-medium">
										<FileText size={13} className="shrink-0 text-[var(--inno-text-muted)]" />
										<span className="truncate">{note.title}</span>
									</div>
									<div className="mt-1 flex flex-wrap gap-2 text-xs text-[var(--inno-text-muted)]">
										<span>{statusLabel}</span>
										{note.meetingStatus ? <span>{t(`notes.meeting.status.${note.meetingStatus}`)}</span> : null}
										{note.size ? <span>{formatSize(note.size)}</span> : null}
									</div>
									</button>
								</div>
								{note.tags.length > 0 ? (
									<div
										className="truncate whitespace-nowrap px-3 pb-2 text-xs leading-5 text-[var(--inno-text-muted)]"
										title={note.tags.map((tag) => `#${tag}`).join("  ")}
									>
										{note.tags.map((tag) => `#${tag}`).join("  ")}
									</div>
								) : null}
							</div>
						);
					})}
				</div>
				{state.aiContextNotes.length > 0 ? (
					<div className="shrink-0 border-t border-[var(--inno-border)] bg-[var(--inno-accent-soft)] p-2">
						<div className="mb-2 flex items-center justify-between gap-2 text-xs text-[var(--inno-text-muted)]">
							<span>{t("notes.context.selected", { count: state.aiContextNotes.length, limit: state.aiContextLimit })}</span>
							<button type="button" className="text-[var(--inno-accent)] hover:underline" onClick={() => notesStore.clearAiContext()}>{t("notes.context.clear")}</button>
						</div>
						<button type="button" className="inno-primary-button flex h-8 w-full items-center justify-center gap-1.5 rounded-md text-xs" onClick={focusChatWithSummaryPrompt}>
							<MessageSquareText size={13} />
							{t("notes.context.useInChat")}
						</button>
					</div>
				) : null}
			</aside>

				<section className="inno-notes-panel-detail flex min-h-0 min-w-0 flex-col overflow-hidden bg-[var(--inno-surface)]">
				{state.notice ? (
					<p className="border-b border-emerald-100 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
						{t(`notes.flash.${state.notice}`, {
							template: state.polishTemplateLabel ?? "",
							tags: state.polishSuggestedTags.join("、"),
						})}
					</p>
				) : null}
				{state.error ? (
					<div className="flex items-start gap-2 border-b border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700" role="alert">
						<div className="min-w-0 flex-1">
							<p>{t(`notes.flash.${state.error}`)}</p>
							{state.errorDetail ? <p className="mt-0.5 break-words text-red-600">{t("notes.flash.errorDetail", { message: state.errorDetail })}</p> : null}
						</div>
						<button type="button" className="shrink-0 rounded p-0.5 hover:bg-red-100" onClick={() => notesStore.clearMessages()} aria-label={t("notes.flash.dismissError")}><X size={13} /></button>
					</div>
				) : null}
				{state.isArchiving ? (
					<div className="flex items-center gap-2 border-b border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-700">
						<LoaderCircle size={13} className="animate-spin" />
						<span className="flex-1">{t("notes.flash.archiving", "正在归档到 Wiki...")}</span>
						<button type="button" className="rounded px-2 py-0.5 text-red-600 hover:bg-red-50" onClick={() => notesStore.stopArchive()}>
							{t("notes.actions.stopArchiving")}
						</button>
					</div>
				) : null}
				{selected ? <MeetingProgress rawPath={selected.rawPath} meetingId={selected.meetingId} /> : null}

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
										availableTags={state.availableTags}
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
										toolbarAction={
											<>
												<MeetingRecorder toolbar />
												{canPolish ? (
													<button
														type="button"
														className="top-bar-item inno-milkdown-polish-button"
													disabled={isConversationalPolishing || chatIsSending || state.isLoadingContent || !state.editorContent.trim() || isSelectedArchiving}
													onClick={() => void handleConversationalPolish()}
													title={isConversationalPolishing ? t("notes.actions.polishing") : t("notes.actions.polish")}
													aria-label={isConversationalPolishing ? t("notes.actions.polishing") : t("notes.actions.polish")}
												>
													{isConversationalPolishing ? <LoaderCircle size={17} className="animate-spin" /> : <Sparkles size={17} />}
													</button>
												) : null}
											</>
										}
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
									readOnly={selected.kind === "archived"}
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
						{selected.notebookType === "note" && !state.isLoadingContent ? (
							<NoteAttachments
								attachments={state.attachments}
								readOnly
								onUpload={(files) => notesStore.uploadAttachments(files)}
								onDelete={(attachmentId) => notesStore.deleteAttachment(attachmentId)}
							/>
						) : null}
						{renderBottomActions()}
					</div>
				)}
				</section>
			</div>
		</div>
	);
}
