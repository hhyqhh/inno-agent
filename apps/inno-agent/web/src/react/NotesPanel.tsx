import { useEffect, useRef, useState } from "react";
import { FileText, Plus, RefreshCw, Save, Search, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ensureNotesBeforeUnloadProtection, notesStore } from "../stores/notes-store.js";
import type { NoteDraftSummary } from "../types/notes.js";
import { useStoreSnapshot } from "./hooks.js";
import { MilkdownEditor } from "./notebook/MilkdownEditor.js";
import { ConfirmDialog } from "./ConfirmDialog.js";

function confirmDiscard(message: string): boolean {
	return !notesStore.isDirty || window.confirm(message);
}

export function NotesPanel() {
	const { t, i18n } = useTranslation();
	const panelRef = useRef<HTMLDivElement>(null);
	const [notePendingDeletion, setNotePendingDeletion] = useState<NoteDraftSummary | null>(null);
	const state = useStoreSnapshot(notesStore, () => ({
		drafts: notesStore.filteredDrafts,
		selected: notesStore.selected,
		editorTitle: notesStore.editorTitle,
		editorContent: notesStore.editorContent,
		searchQuery: notesStore.searchQuery,
		isDirty: notesStore.isDirty,
		isLoading: notesStore.isLoading,
		isLoadingContent: notesStore.isLoadingContent,
		isCreating: notesStore.isCreating,
		isSaving: notesStore.isSaving,
		isDeleting: notesStore.isDeleting,
		error: notesStore.error,
		notice: notesStore.notice,
	}));

	useEffect(() => {
		ensureNotesBeforeUnloadProtection();
		void notesStore.loadAll();
	}, []);

	useEffect(() => {
		const saveWithKeyboard = (event: KeyboardEvent) => {
			if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== "s") return;
			if (!(event.target instanceof Node) || !panelRef.current?.contains(event.target)) return;
			if (!notesStore.selected || notesStore.isSaving || !notesStore.isDirty) return;
			event.preventDefault();
			void notesStore.saveSelected();
		};
		window.addEventListener("keydown", saveWithKeyboard);
		return () => window.removeEventListener("keydown", saveWithKeyboard);
	}, []);

	const selectDraft = (draft: NoteDraftSummary) => {
		if (draft.rawPath === state.selected?.rawPath) return;
		if (!confirmDiscard(t("notes.unsavedConfirm"))) return;
		void notesStore.selectDraft(draft);
	};

	const createDraft = () => {
		if (!confirmDiscard(t("notes.unsavedConfirm"))) return;
		void notesStore.createDraft(t("notes.untitled"));
	};

	const handleDelete = () => {
		if (state.selected) setNotePendingDeletion(state.selected);
	};

	const confirmDelete = async () => {
		if (!notePendingDeletion || notesStore.selected?.rawPath !== notePendingDeletion.rawPath) {
			setNotePendingDeletion(null);
			return;
		}
		const deleted = await notesStore.deleteSelected();
		if (deleted) setNotePendingDeletion(null);
	};

	const formatUpdatedAt = (value: string) => {
		const date = new Date(value);
		return Number.isNaN(date.valueOf()) ? "" : new Intl.DateTimeFormat(i18n.language, {
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		}).format(date);
	};

	return (
		<>
		<div ref={panelRef} className="grid h-full min-h-0 grid-rows-[minmax(180px,40%)_minmax(0,1fr)] gap-3 p-3 md:grid-cols-[260px_minmax(0,1fr)] md:grid-rows-1">
			<aside className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)]">
				<div className="space-y-2 border-b border-[var(--inno-border)] p-2">
					<div className="relative">
						<Search className="pointer-events-none absolute left-2.5 top-2 text-[var(--inno-text-subtle)]" size={14} />
						<input
							type="search"
							className="w-full rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] py-1.5 pl-8 pr-3 text-sm focus-visible:border-[var(--inno-focus-border)] focus-visible:outline-none focus-visible:shadow-[var(--inno-ring)]"
							placeholder={t("notes.search")}
							value={state.searchQuery}
							onChange={(event) => notesStore.setSearchQuery(event.target.value)}
						/>
					</div>
					<div className="flex gap-1">
						<button
							type="button"
							className="inno-primary-button inline-flex flex-1 items-center justify-center gap-1 rounded-md px-2 py-1.5 text-xs text-white disabled:opacity-50"
							disabled={state.isCreating}
							onClick={createDraft}
						>
							<Plus size={14} />
							{t("notes.createDraft")}
						</button>
						<button
							type="button"
							className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[var(--inno-border)] text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)]"
							title={t("common.refresh")}
							onClick={() => void notesStore.loadAll()}
						>
							<RefreshCw size={14} className={state.isLoading ? "animate-spin" : ""} />
						</button>
					</div>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto">
					{state.isLoading && state.drafts.length === 0 ? (
						<p className="p-4 text-center text-sm text-[var(--inno-text-muted)]">{t("common.loading")}</p>
					) : null}
					{!state.isLoading && state.drafts.length === 0 ? (
						<p className="p-4 text-center text-sm text-[var(--inno-text-muted)]">{t("notes.empty")}</p>
					) : null}
					{state.drafts.map((draft) => (
						<button
							key={draft.rawPath}
							type="button"
							className={`w-full border-b border-[var(--inno-border)] px-3 py-2 text-left text-sm ${state.selected?.rawPath === draft.rawPath ? "bg-[var(--inno-accent-soft)]" : "hover:bg-[var(--inno-surface-muted)]"}`}
							onClick={() => selectDraft(draft)}
						>
							<div className="flex items-center gap-1.5">
								<FileText className="shrink-0 text-[var(--inno-text-subtle)]" size={14} />
								<span className="truncate font-medium">{draft.title}</span>
							</div>
							<div className="mt-1 pl-5 text-xs text-[var(--inno-text-muted)]">{formatUpdatedAt(draft.updatedAt)}</div>
						</button>
					))}
				</div>
			</aside>

			<section className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)]">
				{state.notice ? (
					<p className="border-b border-[var(--inno-success)]/20 bg-[var(--inno-success-bg)] px-3 py-2 text-xs text-[var(--inno-success)]">{t(`notes.flash.${state.notice}`)}</p>
				) : null}
				{state.error ? (
					<p className="border-b border-[var(--inno-danger)]/20 bg-[var(--inno-danger-bg)] px-3 py-2 text-xs text-[var(--inno-danger)]">{t(`notes.flash.${state.error}`)}</p>
				) : null}
				{!state.selected ? (
					<div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-[var(--inno-text-muted)]">{t("notes.selectHint")}</div>
				) : state.isLoadingContent ? (
					<div className="flex flex-1 items-center justify-center text-sm text-[var(--inno-text-muted)]">{t("common.loading")}</div>
				) : (
					<>
						<div className="flex items-center gap-2 border-b border-[var(--inno-border)] p-3">
							<input
								className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 py-1 text-base font-semibold focus-visible:border-[var(--inno-focus-border)] focus-visible:outline-none"
								value={state.editorTitle}
								placeholder={t("notes.titlePlaceholder")}
								onChange={(event) => notesStore.updateTitle(event.target.value)}
							/>
							<button
								type="button"
								className="inno-primary-button inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-xs text-white disabled:opacity-50"
								disabled={!state.isDirty || state.isSaving || state.isDeleting}
								onClick={() => void notesStore.saveSelected()}
							>
								<Save size={14} />
								{state.isSaving ? t("common.saving") : t("common.save")}
							</button>
						</div>
						<div className="inno-milkdown-editor-shell min-h-0 flex-1 overflow-hidden">
							<MilkdownEditor
								key={state.selected.rawPath}
								editorKey={state.selected.rawPath}
								value={state.editorContent}
								onChange={(value) => notesStore.updateContent(value)}
							/>
						</div>
						<div className="flex items-center gap-3 border-t border-[var(--inno-border)] px-3 py-2.5 text-xs text-[var(--inno-text-muted)]">
							<span className="min-w-0 flex-1 truncate">{state.selected.rawPath}</span>
							<span>{state.isDirty ? t("notes.unsaved") : t("common.saved")}</span>
							<button
								type="button"
								className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-red-200 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50"
								disabled={state.isDeleting || state.isSaving}
								onClick={handleDelete}
							>
								<Trash2 size={14} />
								{t("common.delete")}
							</button>
						</div>
					</>
				)}
			</section>
		</div>
		<ConfirmDialog
			open={notePendingDeletion !== null}
			title={t("notes.deleteDialogTitle")}
			description={t("notes.deleteConfirm", { title: notePendingDeletion?.title ?? "" })}
			confirmLabel={t("common.delete")}
			cancelLabel={t("common.cancel")}
			busy={state.isDeleting}
			onConfirm={() => void confirmDelete()}
			onCancel={() => setNotePendingDeletion(null)}
		/>
		</>
	);
}
