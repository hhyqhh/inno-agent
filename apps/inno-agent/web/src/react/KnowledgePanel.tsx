import { useState } from "react";
import { Brain, Files } from "lucide-react";
import { useTranslation } from "react-i18next";
import { notesStore } from "../stores/notes-store.js";
import { Notebook } from "./Notebook.js";
import { NotesPanel } from "./NotesPanel.js";

type KnowledgeView = "drafts" | "wiki";

export function KnowledgePanel() {
	const { t } = useTranslation();
	const [view, setView] = useState<KnowledgeView>("drafts");

	const changeView = (nextView: KnowledgeView) => {
		if (nextView === view) return;
		if (view === "drafts" && notesStore.isDirty) {
			if (!window.confirm(t("notes.unsavedConfirm"))) return;
			notesStore.discardChanges();
		}
		setView(nextView);
	};

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex items-center border-b border-[var(--inno-border)] bg-[var(--inno-workspace-chrome)] px-3 py-2">
				<div className="inline-flex rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] p-0.5 text-xs">
					<button
						type="button"
						className={`inline-flex items-center gap-1 rounded px-3 py-1 ${view === "drafts" ? "bg-[var(--inno-surface)] text-[var(--inno-text)] shadow" : "text-[var(--inno-text-muted)]"}`}
						onClick={() => changeView("drafts")}
					>
						<Files size={13} />
						{t("knowledge.views.drafts")}
					</button>
					<button
						type="button"
						className={`inline-flex items-center gap-1 rounded px-3 py-1 ${view === "wiki" ? "bg-[var(--inno-surface)] text-[var(--inno-text)] shadow" : "text-[var(--inno-text-muted)]"}`}
						onClick={() => changeView("wiki")}
					>
						<Brain size={13} />
						{t("knowledge.views.wiki")}
					</button>
				</div>
			</div>
			<div className="min-h-0 flex-1 overflow-hidden">
				{view === "drafts" ? <NotesPanel /> : <Notebook />}
			</div>
		</div>
	);
}
