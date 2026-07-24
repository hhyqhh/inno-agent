import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Brain, Check, ChevronDown, Files } from "lucide-react";
import { notebookStore } from "../stores/notebook-store.js";
import { notesStore } from "../stores/notes-store.js";
import { Notebook } from "./Notebook.js";
import { NotesPanel } from "./NotesPanel.js";

export type KnowledgeView = "notebook" | "wiki";

interface KnowledgePanelProps {
	view: KnowledgeView;
	onViewChange(view: KnowledgeView): void;
}

export function KnowledgePanel({ view, onViewChange }: KnowledgePanelProps) {
	const { t } = useTranslation();
	const [viewMenuOpen, setViewMenuOpen] = useState(false);
	const viewMenuRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!viewMenuOpen) return;
		const closeOnOutsideClick = (event: MouseEvent) => {
			if (!viewMenuRef.current?.contains(event.target as Node)) setViewMenuOpen(false);
		};
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") setViewMenuOpen(false);
		};
		document.addEventListener("mousedown", closeOnOutsideClick);
		window.addEventListener("keydown", closeOnEscape);
		return () => {
			document.removeEventListener("mousedown", closeOnOutsideClick);
			window.removeEventListener("keydown", closeOnEscape);
		};
	}, [viewMenuOpen]);

	const selectView = useCallback((nextView: KnowledgeView) => {
		onViewChange(nextView);
		setViewMenuOpen(false);
	}, [onViewChange]);

	const viewSelector = (
		<div className="flex h-8 items-center justify-between gap-3">
			<h2 className="truncate text-sm font-semibold text-[var(--inno-text)]">
				{t("workspace.tabs.notebook")}
			</h2>
			<div ref={viewMenuRef} className="relative h-7 w-[104px] shrink-0">
				<button
					type="button"
					className="flex h-full w-full items-center gap-1.5 rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] px-2 text-xs font-medium text-[var(--inno-text)] shadow-sm outline-none transition-[border-color,box-shadow,background-color] hover:border-[var(--inno-border-strong)] hover:bg-[var(--inno-surface-raised)] focus:border-[var(--inno-accent)] focus:ring-2 focus:ring-[var(--inno-accent-soft)]"
					onClick={() => setViewMenuOpen((open) => !open)}
					aria-haspopup="listbox"
					aria-expanded={viewMenuOpen}
				>
					<span className="text-[var(--inno-accent)]">
						{view === "notebook" ? <Files size={13} /> : <Brain size={13} />}
					</span>
					<span className="min-w-0 flex-1 truncate text-left">
						{t(`knowledge.views.${view}`)}
					</span>
					<ChevronDown size={13} className={`shrink-0 text-[var(--inno-text-subtle)] transition-transform ${viewMenuOpen ? "rotate-180" : ""}`} />
				</button>
				{viewMenuOpen ? (
					<div
						className="absolute right-0 top-full z-30 mt-1 w-40 overflow-hidden rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] p-1 shadow-lg"
						role="listbox"
						aria-label={t("workspace.tabs.notebook")}
					>
						{(["notebook", "wiki"] as const).map((option) => {
							const selected = view === option;
							return (
								<button
									key={option}
									type="button"
									role="option"
									aria-selected={selected}
									className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors ${selected ? "bg-[var(--inno-accent-soft)] text-[var(--inno-accent)]" : "text-[var(--inno-text)] hover:bg-[var(--inno-surface-muted)]"}`}
									onClick={() => selectView(option)}
								>
									{option === "notebook" ? <Files size={15} /> : <Brain size={15} />}
									<span className="flex-1 font-medium">{t(`knowledge.views.${option}`)}</span>
									{selected ? <Check size={14} /> : null}
								</button>
							);
						})}
					</div>
				) : null}
			</div>
		</div>
	);

	const openWiki = useCallback(async (wikiPath: string) => {
		onViewChange("wiki");
		await notebookStore.loadAll();
		await notebookStore.selectPage(wikiPath);
	}, [onViewChange]);

	const openNoteById = useCallback(async (noteId: string) => {
		onViewChange("notebook");
		await notesStore.loadAll();
		const note = notesStore.findNoteById(noteId);
		if (note) await notesStore.selectNote(note);
	}, [onViewChange]);

	const openNoteByPath = useCallback(async (rawPath: string) => {
		onViewChange("notebook");
		await notesStore.loadAll();
		const note = notesStore.notes.find((item) => item.rawPath === rawPath);
		if (note) await notesStore.selectNote(note);
	}, [onViewChange]);

	return (
		<div className="h-full min-h-0 overflow-hidden">
			{view === "notebook" ? (
				<NotesPanel viewSelector={viewSelector} onOpenWiki={(path) => void openWiki(path)} />
			) : (
				<Notebook
					viewSelector={viewSelector}
					onOpenNoteId={(id) => void openNoteById(id)}
					onOpenNote={(path) => void openNoteByPath(path)}
				/>
			)}
		</div>
	);
}
