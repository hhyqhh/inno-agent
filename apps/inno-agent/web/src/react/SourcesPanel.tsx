import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import {
	ArchiveRestore,
	Download,
	ExternalLink,
	FileText,
	FileUp,
	Loader2,
	PanelLeftClose,
	PanelLeftOpen,
	Paperclip,
	Plus,
	RefreshCw,
	Sparkles,
	Trash2,
	Upload,
} from "lucide-react";
import { l2RawUrl, fetchRawFile } from "../api/sources.js";
import { appStore } from "../stores/app-store.js";
import { notebookStore } from "../stores/notebook-store.js";
import { sourcesStore } from "../stores/sources-store.js";
import type { OrphanRawFile, SourceDraftFilter, SourceSummary } from "../types/sources.js";
import { useStoreSnapshot } from "./hooks.js";
import { MilkdownMarkdownEditor } from "./MilkdownMarkdownEditor.js";
import { NoteAttachmentsPanel } from "./NoteAttachmentsPanel.js";

const FILTER_DRAFTS: SourceDraftFilter[] = ["all", "draft", "archived"];

function isMarkdownFile(fileName: string): boolean {
	return fileName.toLowerCase().endsWith(".md");
}

function isMarkdownSource(source: SourceSummary): boolean {
	return isMarkdownFile(source.fileName) || source.wikiPages.length > 0;
}

function contentKindIcon(isMarkdown: boolean) {
	return isMarkdown ? <FileText size={14} /> : <Paperclip size={14} />;
}

function formatSize(size: number): string {
	if (size < 1024) return `${size} B`;
	if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
	return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
	try {
		return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "2-digit", day: "2-digit" });
	} catch {
		return iso;
	}
}

function isPreviewable(fileName: string): boolean {
	const lower = fileName.toLowerCase();
	return [".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].some((ext) => lower.endsWith(ext));
}

function openWikiPage(path: string): void {
	appStore.setRightPanelTab("notebook");
	appStore.setWorkspaceMode("half");
	void notebookStore.selectPage(path);
}

function isUserNotePath(rawPath: string): boolean {
	const normalized = rawPath.replace(/^\/+/, "");
	return normalized.startsWith("raw/notes/") && normalized.toLowerCase().endsWith(".md");
}

function UserNoteEditor({
	rawPath,
	title,
	isSaving,
	isDeleting,
	isArchiving,
	isUnarchiving,
	showArchiveButton,
	showUnarchiveButton,
	onSave,
	onArchive,
	onUnarchive,
	onDelete,
}: {
	rawPath: string;
	title: string;
	isSaving: boolean;
	isDeleting: boolean;
	isArchiving?: boolean;
	isUnarchiving?: boolean;
	showArchiveButton?: boolean;
	showUnarchiveButton?: boolean;
	onSave: (content: string) => Promise<boolean>;
	onArchive?: (content: string) => Promise<boolean>;
	onUnarchive?: () => void;
	onDelete: () => void;
}) {
	const { t, i18n } = useTranslation();
	const [content, setContent] = useState("");
	const [draft, setDraft] = useState("");
	const [isLoading, setIsLoading] = useState(true);
	const [isDirty, setIsDirty] = useState(false);

	useEffect(() => {
		let cancelled = false;
		setIsLoading(true);
		setIsDirty(false);
		void fetchRawFile(rawPath)
			.then((text) => {
				if (cancelled) return;
				setContent(text);
				setDraft(text);
			})
			.catch(() => {
				if (cancelled) return;
				setContent("");
				setDraft("");
			})
			.finally(() => {
				if (!cancelled) setIsLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [rawPath]);

	return (
		<div className="flex h-full flex-col">
			<div className="border-b border-slate-200 px-4 py-3">
				<div className="flex items-start justify-between gap-2">
					<h3 className="min-w-0 truncate text-base font-medium text-slate-950">{title}</h3>
					<div className="flex shrink-0 items-center gap-1.5">
						{showUnarchiveButton && onUnarchive ? (
							<button
								type="button"
								className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
								disabled={isUnarchiving}
								onClick={onUnarchive}
							>
								{isUnarchiving ? <Loader2 size={12} className="animate-spin" /> : <ArchiveRestore size={12} />}
								{t("sources.actions.unarchive")}
							</button>
						) : null}
						<button
							type="button"
							className="inline-flex shrink-0 items-center gap-1 rounded-md border border-red-200 bg-white px-2.5 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50"
							disabled={isDeleting}
							onClick={onDelete}
						>
							{isDeleting ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
							{t("common.delete")}
						</button>
					</div>
				</div>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto">
				{isLoading ? (
					<div className="flex h-full min-h-[16rem] items-center justify-center">
						<Loader2 size={20} className="animate-spin text-slate-400" />
					</div>
				) : (
					<>
						<div className="h-[min(55vh,640px)] min-h-[20rem]">
							<MilkdownMarkdownEditor
								fileKey={rawPath}
								value={draft}
								uiLanguage={i18n.language.startsWith("zh") ? "zh" : "en"}
								onChange={(nextValue) => {
									setDraft(nextValue);
									setIsDirty(nextValue !== content);
								}}
							/>
						</div>
						<NoteAttachmentsPanel noteRawPath={rawPath} />
					</>
				)}
			</div>
			<div className="flex gap-2 border-t border-slate-200 p-3">
				<button
					type="button"
					className="rounded-md bg-slate-900 px-3 py-1.5 text-sm text-white hover:bg-slate-800 disabled:opacity-50"
					disabled={isSaving || isLoading || !isDirty}
					onClick={() =>
						void onSave(draft).then((ok) => {
							if (ok) {
								setContent(draft);
								setIsDirty(false);
							}
						})
					}
				>
					{isSaving ? t("common.saving") : t("common.save")}
				</button>
				{showArchiveButton && onArchive ? (
					<button
						type="button"
						className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
						disabled={isSaving || isArchiving || isLoading}
						onClick={() => void onArchive(draft)}
					>
						{isArchiving ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
						{t("sources.actions.archive")}
					</button>
				) : null}
			</div>
		</div>
	);
}

function SourceDetail({
	source,
	isSaving,
	isDeleting,
	isUnarchiving,
	onSaveNote,
	onUnarchive,
	onDelete,
}: {
	source: SourceSummary;
	isSaving: boolean;
	isDeleting: boolean;
	isUnarchiving: boolean;
	onSaveNote: (rawPath: string, content: string) => Promise<boolean>;
	onUnarchive: () => void;
	onDelete: () => void;
}) {
	const { t } = useTranslation();
	if (isUserNotePath(source.rawPath)) {
		return (
			<UserNoteEditor
				rawPath={source.rawPath}
				title={source.title}
				isSaving={isSaving}
				isDeleting={isDeleting}
				isUnarchiving={isUnarchiving}
				showUnarchiveButton
				onSave={(content) => onSaveNote(source.rawPath, content)}
				onUnarchive={onUnarchive}
				onDelete={onDelete}
			/>
		);
	}

	const isMarkdown = isMarkdownSource(source);
	const canPreview = !isMarkdown && isPreviewable(source.fileName);

	return (
		<div className="flex h-full flex-col">
			<div className="border-b border-slate-200 px-4 py-3">
				<div className="flex items-start justify-between gap-2">
					<h3 className="min-w-0 truncate text-base font-medium text-slate-950">{source.title}</h3>
					<div className="flex shrink-0 items-center gap-1.5">
						<button
							type="button"
							className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
							disabled={isUnarchiving}
							onClick={onUnarchive}
						>
							{isUnarchiving ? <Loader2 size={12} className="animate-spin" /> : <ArchiveRestore size={12} />}
							{t("sources.actions.unarchive")}
						</button>
						<button
							type="button"
							className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-white px-2.5 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50"
							disabled={isDeleting}
							onClick={onDelete}
						>
							{isDeleting ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
							{t("common.delete")}
						</button>
					</div>
				</div>
				<div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
					<span className="inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">
						{contentKindIcon(isMarkdown)}
						{t(isMarkdown ? "sources.contentKind.markdown" : "sources.contentKind.attachment")}
					</span>
					<span className="text-slate-400">{formatSize(source.size)}</span>
					<span className="text-slate-400">{t(`sources.origin.${source.origin}`, source.origin)}</span>
					<span className="text-slate-400">{formatDate(source.updatedAt)}</span>
				</div>
				{source.tags.length > 0 ? (
					<div className="mt-2 flex flex-wrap gap-1">
						{source.tags.map((tag) => (
							<span key={tag} className="rounded-full bg-blue-50 px-1.5 py-0.5 text-xs text-blue-700 ring-1 ring-blue-100">
								#{tag}
							</span>
						))}
					</div>
				) : null}
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto p-4 space-y-4">
				{source.wikiPages.length > 0 ? (
					<section>
						<h4 className="mb-2 text-xs font-medium text-slate-500">{t("sources.detail.markdown")}</h4>
						<div className="space-y-1">
							{source.wikiPages.map((page) => (
								<button
									key={page.path}
									type="button"
									className="flex w-full items-center gap-2 rounded-md border border-slate-100 px-3 py-2 text-left text-sm hover:bg-slate-50"
									onClick={() => openWikiPage(page.path)}
								>
									<FileText size={14} className="shrink-0 text-slate-400" />
									<span className="truncate text-slate-950">{page.title}</span>
								</button>
							))}
						</div>
					</section>
				) : null}

				<section className="rounded-lg border border-slate-200 bg-slate-50/50 p-3">
					<h4 className="mb-2 text-xs font-medium text-slate-500">{t("sources.detail.attachment")}</h4>
					<div className="truncate text-sm font-medium text-slate-950">{source.fileName}</div>
					<div className="mt-2 flex flex-wrap gap-2">
						{canPreview ? (
							<a
								href={l2RawUrl(source.rawPath)}
								target="_blank"
								rel="noreferrer"
								className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50"
							>
								<ExternalLink size={12} />
								{t("sources.preview")}
							</a>
						) : null}
						<a
							href={l2RawUrl(source.rawPath, { download: true })}
							className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50"
						>
							<Download size={12} />
							{t("sources.download")}
						</a>
					</div>
					{source.url ? (
						<a
							href={source.url}
							target="_blank"
							rel="noreferrer"
							className="mt-2 inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
						>
							<ExternalLink size={11} />
							<span className="truncate">{source.url}</span>
						</a>
					) : null}
				</section>
			</div>
		</div>
	);
}

function noteTitleFromFileName(fileName: string): string {
	return fileName.replace(/\.md$/i, "").replace(/-\d{4}-\d{2}-\d{2}-[a-f0-9]{6}$/i, "").replace(/-/g, " ").trim() || fileName;
}

function OrphanDetail({
	file,
	onArchive,
	onDelete,
	isDeleting,
	isSaving,
	isArchiving,
	onSave,
}: {
	file: OrphanRawFile;
	onArchive: () => void;
	onDelete: () => void;
	isDeleting: boolean;
	isSaving: boolean;
	isArchiving: boolean;
	onSave: (content: string) => Promise<boolean>;
}) {
	const { t } = useTranslation();
	const isMarkdown = isMarkdownFile(file.fileName);
	const canPreview = !isMarkdown && isPreviewable(file.fileName);

	if (isMarkdown) {
		return (
			<UserNoteEditor
				rawPath={file.rawPath}
				title={noteTitleFromFileName(file.fileName)}
				isSaving={isSaving}
				isDeleting={isDeleting}
				isArchiving={isArchiving || isSaving}
				showArchiveButton
				onSave={onSave}
				onArchive={(content) => onSave(content)}
				onDelete={onDelete}
			/>
		);
	}

	return (
		<div className="flex h-full flex-col">
			<div className="border-b border-slate-200 px-4 py-3">
				<h3 className="truncate text-base font-medium text-slate-950">{file.fileName}</h3>
				<div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
					<span className="inline-flex items-center gap-1 rounded bg-yellow-50 px-1.5 py-0.5 text-yellow-700 ring-1 ring-yellow-100">
						{t("sources.draft.badge")}
					</span>
					<span className="inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">
						{contentKindIcon(false)}
						{t("sources.contentKind.attachment")}
					</span>
					<span className="text-slate-400">{formatSize(file.size)}</span>
					<span className="text-slate-400">{formatDate(file.updatedAt)}</span>
				</div>
				<div className="mt-3 flex flex-wrap gap-2">
					<button
						type="button"
						className="inline-flex items-center gap-1 rounded-md bg-slate-900 px-2.5 py-1 text-xs text-white hover:bg-slate-800 disabled:opacity-50"
						disabled={isArchiving}
						onClick={onArchive}
					>
						{isArchiving ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
						{t("sources.actions.archive")}
					</button>
					{canPreview ? (
						<a
							href={l2RawUrl(file.rawPath)}
							target="_blank"
							rel="noreferrer"
							className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50"
						>
							<ExternalLink size={12} />
							{t("sources.preview")}
						</a>
					) : null}
					<a
						href={l2RawUrl(file.rawPath, { download: true })}
						className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50"
					>
						<Download size={12} />
						{t("sources.download")}
					</a>
					<button
						type="button"
						className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-white px-2.5 py-1 text-xs text-red-600 hover:bg-red-50"
						disabled={isDeleting}
						onClick={onDelete}
					>
						{isDeleting ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
						{t("common.delete")}
					</button>
				</div>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto p-4">
				<p className="text-sm text-slate-500">{t("sources.orphan.hint")}</p>
			</div>
		</div>
	);
}

export function SourcesPanel() {
	const { t, i18n } = useTranslation();
	const [sidebarOpen, setSidebarOpen] = useState(true);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const mdInputRef = useRef<HTMLInputElement>(null);
	const state = useStoreSnapshot(sourcesStore, () => ({
		sources: sourcesStore.filteredSources,
		orphans: sourcesStore.filteredOrphans,
		selected: sourcesStore.selected,
		isLoading: sourcesStore.isLoading,
		isUploading: sourcesStore.isUploading,
		isImporting: sourcesStore.isImporting,
		isCreating: sourcesStore.isCreating,
		isDeleting: sourcesStore.isDeleting,
		isSavingOrphan: sourcesStore.isSavingOrphan,
		isArchiving: sourcesStore.isArchiving,
		isUnarchiving: sourcesStore.isUnarchiving,
		searchQuery: sourcesStore.searchQuery,
		filterDraft: sourcesStore.filterDraft,
		notice: sourcesStore.notice,
		error: sourcesStore.error,
	}));

	useEffect(() => {
		void sourcesStore.loadAll();
	}, []);

	const busy = state.isUploading || state.isImporting || state.isCreating;

	async function handleCreateNote() {
		await sourcesStore.createBlankNote(i18n.language);
	}

	async function handleUpload(event: ChangeEvent<HTMLInputElement>) {
		const files = Array.from(event.target.files ?? []);
		event.target.value = "";
		if (files.length === 0) return;
		await sourcesStore.uploadFiles(files);
	}

	async function handleImportMd(event: ChangeEvent<HTMLInputElement>) {
		const files = Array.from(event.target.files ?? []);
		event.target.value = "";
		if (files.length === 0) return;
		const { paths } = await sourcesStore.importMarkdownFiles(files);
		if (paths.length > 0) {
			appStore.setRightPanelTab("notebook");
			appStore.setWorkspaceMode("half");
			void notebookStore.selectPage(paths[0]!);
		}
	}

	function handleArchiveOrphan(file: OrphanRawFile) {
		if (isMarkdownFile(file.fileName)) return;
		void sourcesStore.archiveSelectedOrphan();
	}

	async function handleDelete() {
		const name =
			state.selected?.kind === "manifest"
				? state.selected.source.title
				: state.selected?.kind === "orphan"
					? state.selected.file.fileName
					: "";
		if (!name) return;
		if (!window.confirm(t("sources.confirmDelete", { name }))) return;
		await sourcesStore.deleteSelected();
	}

	async function handleUnarchive() {
		if (state.selected?.kind !== "manifest") return;
		const name = state.selected.source.title;
		if (!window.confirm(t("sources.confirmUnarchive", { name }))) return;
		await sourcesStore.unarchiveSelectedSource();
	}

	const selectedId =
		state.selected?.kind === "manifest"
			? state.selected.source.id
			: state.selected?.kind === "orphan"
				? `orphan:${state.selected.file.rawPath}`
				: null;

	return (
		<div
			className={`grid h-full min-h-0 gap-3 p-3 transition-[grid-template-columns] duration-200 ${sidebarOpen ? "grid-cols-[260px_minmax(0,1fr)]" : "grid-cols-[0px_minmax(0,1fr)]"}`}
		>
			<aside
				className={`flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white transition-opacity duration-200 ${sidebarOpen ? "opacity-100" : "pointer-events-none opacity-0"}`}
			>
				<div className="flex items-center gap-1 border-b border-slate-100 p-2">
					<input
						type="text"
						className="min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm focus:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-100"
						placeholder={t("sources.search") ?? ""}
						value={state.searchQuery}
						onChange={(event) => sourcesStore.setSearchQuery(event.target.value)}
					/>
					<button
						type="button"
						className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700"
						title={t("common.refresh")}
						onClick={() => void sourcesStore.loadAll()}
					>
						<RefreshCw size={14} className={state.isLoading ? "animate-spin" : ""} />
					</button>
				</div>
				<div className="border-b border-slate-100 px-2 pb-2">
					<button
						type="button"
						className="inline-flex w-full items-center justify-center gap-1 rounded-md border border-slate-200 bg-slate-900 px-2 py-1.5 text-xs text-white hover:bg-slate-800 disabled:opacity-50"
						disabled={busy}
						title={t("sources.create.blankHint")}
						onClick={() => void handleCreateNote()}
					>
						{state.isCreating ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
						<span className="truncate">{t("sources.create.newNote")}</span>
					</button>
				</div>
				<div className="flex gap-1 border-b border-slate-100 px-2 pb-2">
					<button
						type="button"
						className="inline-flex flex-1 items-center justify-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
						disabled={busy}
						onClick={() => mdInputRef.current?.click()}
					>
						{state.isImporting ? <Loader2 size={13} className="animate-spin" /> : <FileUp size={13} />}
						{t("sources.actions.importMd")}
					</button>
					<button
						type="button"
						className="inline-flex flex-1 items-center justify-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
						disabled={busy}
						onClick={() => fileInputRef.current?.click()}
					>
						{state.isUploading ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
						{t("sources.actions.upload")}
					</button>
				</div>
				<input
					ref={fileInputRef}
					type="file"
					multiple
					hidden
					accept=".pdf,.doc,.docx,.txt,.md,.csv,.xlsx,.ppt,.pptx,.png,.jpg,.jpeg,.gif,.webp,.zip"
					onChange={(event) => void handleUpload(event)}
				/>
				<input
					ref={mdInputRef}
					type="file"
					multiple
					hidden
					accept=".md,text/markdown"
					onChange={(event) => void handleImportMd(event)}
				/>
				{state.notice ? (
					<p className="border-b border-green-100 bg-green-50 px-3 py-1.5 text-xs text-green-700">
						{t(`sources.flash.${state.notice}`)}
					</p>
				) : null}
				{state.error ? (
					<p className="border-b border-red-100 bg-red-50 px-3 py-1.5 text-xs text-red-700">
						{t(`sources.flash.${state.error}`)}
					</p>
				) : null}
				<div className="flex flex-wrap gap-1 border-b border-slate-100 px-2 py-2">
					{FILTER_DRAFTS.map((draft) => (
						<button
							key={draft}
							type="button"
							className={`rounded-full px-2 py-0.5 text-xs transition-colors ${
								state.filterDraft === draft
									? "bg-blue-50 text-blue-700 ring-1 ring-blue-100"
									: "bg-slate-100 text-slate-500 hover:bg-slate-200 hover:text-slate-950"
							}`}
							onClick={() => sourcesStore.setFilterDraft(draft)}
						>
							{t(`sources.filter.draft.${draft}`)}
						</button>
					))}
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto">
					{state.isLoading && state.sources.length === 0 && state.orphans.length === 0 ? (
						<div className="flex justify-center p-6">
							<span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-transparent" />
						</div>
					) : null}
					{!state.isLoading && state.sources.length === 0 && state.orphans.length === 0 ? (
						<p className="p-4 text-center text-sm text-slate-500">{t("sources.empty")}</p>
					) : null}
					{state.sources.map((source) => {
						const selected = selectedId === source.id;
						const isMarkdown = isMarkdownSource(source);
						return (
							<button
								key={source.id}
								type="button"
								className={`w-full border-b border-slate-100 px-3 py-2 text-left text-sm transition-colors ${selected ? "bg-blue-50" : "hover:bg-slate-50"}`}
								onClick={() => sourcesStore.selectSource(source)}
							>
								<div className="flex items-center gap-1.5">
									<span className="text-slate-400">{contentKindIcon(isMarkdown)}</span>
									<span className="truncate font-medium text-slate-950">{source.title}</span>
								</div>
								<div className="mt-1 flex items-center gap-1.5 text-xs">
									<span className="truncate text-slate-400">{formatSize(source.size)}</span>
									{source.wikiPages.length > 0 ? (
										<span className="text-slate-400">{t("sources.linkedCount", { count: source.wikiPages.length })}</span>
									) : null}
								</div>
							</button>
						);
					})}
					{state.orphans.length > 0 ? (
						<>
							<div className="bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-500">{t("sources.draft.section")}</div>
							{state.orphans.map((file) => {
								const id = `orphan:${file.rawPath}`;
								const selected = selectedId === id;
								const isMarkdown = isMarkdownFile(file.fileName);
								return (
									<button
										key={file.rawPath}
										type="button"
										className={`w-full border-b border-slate-100 px-3 py-2 text-left text-sm transition-colors ${selected ? "bg-yellow-50" : "hover:bg-slate-50"}`}
										onClick={() => sourcesStore.selectOrphan(file)}
									>
										<div className="flex items-center gap-1.5">
											<span className="text-slate-400">{contentKindIcon(isMarkdown)}</span>
											<span className="truncate font-medium text-slate-950">
												{isMarkdown ? noteTitleFromFileName(file.fileName) : file.fileName}
											</span>
										</div>
										<div className="mt-1 flex items-center gap-1.5 text-xs">
											<span className="rounded bg-yellow-50 px-1.5 py-0.5 text-yellow-700 ring-1 ring-yellow-100">
												{t("sources.draft.badge")}
											</span>
											<span className="text-slate-400">{formatSize(file.size)}</span>
										</div>
									</button>
								);
							})}
						</>
					) : null}
				</div>
			</aside>

			<section className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white">
				<div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2">
					<button
						type="button"
						className="flex h-7 w-7 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700"
						onClick={() => setSidebarOpen((v) => !v)}
						title={sidebarOpen ? t("common.collapseSidebar", "Collapse sidebar") : t("common.expandSidebar", "Expand sidebar")}
					>
						{sidebarOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
					</button>
					<span className="text-xs text-slate-500">
						{state.selected?.kind === "manifest"
							? state.selected.source.fileName
							: state.selected?.kind === "orphan"
								? state.selected.file.fileName
								: t("sources.selectHint")}
					</span>
				</div>
				<div className="min-h-0 flex-1 overflow-auto">
					{state.selected?.kind === "manifest" ? (
						<SourceDetail
							source={state.selected.source}
							isSaving={state.isSavingOrphan}
							isDeleting={state.isDeleting}
							isUnarchiving={state.isUnarchiving}
							onSaveNote={(rawPath, content) => sourcesStore.saveNoteContent(rawPath, content)}
							onUnarchive={() => void handleUnarchive()}
							onDelete={() => void handleDelete()}
						/>
					) : state.selected?.kind === "orphan" ? (
						<OrphanDetail
							file={state.selected.file}
							isDeleting={state.isDeleting}
							isSaving={state.isSavingOrphan}
							isArchiving={state.isArchiving}
							onArchive={() => {
								const sel = state.selected;
								if (sel?.kind === "orphan") handleArchiveOrphan(sel.file);
							}}
							onDelete={() => void handleDelete()}
							onSave={(content) =>
								sourcesStore.saveNoteContent(
									state.selected?.kind === "orphan" ? state.selected.file.rawPath : "",
									content,
								)
							}
						/>
					) : (
						<div className="flex h-full items-center justify-center text-sm text-slate-500">{t("sources.selectHint")}</div>
					)}
				</div>
			</section>
		</div>
	);
}
