import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Brain, Files } from "lucide-react";
import { notebookStore } from "../stores/notebook-store.js";
import { notesStore } from "../stores/notes-store.js";
import { Notebook } from "./Notebook.js";
import { NotesPanel } from "./NotesPanel.js";

export type KnowledgeView = "notebook" | "wiki";

export function KnowledgePanel() {
	const { t } = useTranslation();
	const [view, setView] = useState<KnowledgeView>("notebook");

	const openWiki = useCallback(async (wikiPath: string) => {
		setView("wiki");
		await notebookStore.loadAll();
		await notebookStore.selectPage(wikiPath);
	}, []);

	const openNoteById = useCallback(async (noteId: string) => {
		setView("notebook");
		await notesStore.loadAll();
		const note = notesStore.findNoteById(noteId);
		if (note) await notesStore.selectNote(note);
	}, []);

	const openNoteByPath = useCallback(async (rawPath: string) => {
		setView("notebook");
		await notesStore.loadAll();
		const note = notesStore.notes.find((item) => item.rawPath === rawPath);
		if (note) await notesStore.selectNote(note);
	}, []);

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex items-center gap-2 border-b border-[var(--inno-border)] bg-[var(--inno-workspace-chrome)] px-3 py-2">
				<div className="inline-flex rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] p-0.5 text-xs">
					<button
						type="button"
						className={`inline-flex items-center gap-1 rounded px-3 py-1 ${view === "notebook" ? "bg-[var(--inno-surface)] shadow text-[var(--inno-text)]" : "text-[var(--inno-text-muted)]"}`}
						onClick={() => setView("notebook")}
					>
						<Files size={13} />
						{t("knowledge.views.notebook")}
					</button>
					<button
						type="button"
						className={`inline-flex items-center gap-1 rounded px-3 py-1 ${view === "wiki" ? "bg-[var(--inno-surface)] shadow text-[var(--inno-text)]" : "text-[var(--inno-text-muted)]"}`}
						onClick={() => setView("wiki")}
					>
						<Brain size={13} />
						{t("knowledge.views.wiki")}
					</button>
				</div>
			</div>
			<div className="min-h-0 flex-1 overflow-hidden">
				{view === "notebook" ? (
					<NotesPanel onOpenWiki={(path) => void openWiki(path)} />
				) : (
					<Notebook
						onOpenNoteId={(id) => void openNoteById(id)}
						onOpenNote={(path) => void openNoteByPath(path)}
					/>
				)}
			</div>
		</div>
	);
}
