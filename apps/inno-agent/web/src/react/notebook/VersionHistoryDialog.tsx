import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { History, LoaderCircle, RotateCcw, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { fetchNoteVersion, listNoteVersions, restoreNoteVersion } from "../../api/notes.js";
import type { NoteVersion, NoteVersionSummary } from "../../types/notes.js";
import { normalizeMarkdownMath } from "../../utils/markdown-math.js";
import { noteImageUrl } from "../../stores/notes-store.js";
import { ConfirmDialog } from "../ConfirmDialog.js";
import { MilkdownEditor } from "./MilkdownEditor.js";

export function VersionHistoryDialog({
	open,
	rawPath,
	canRestore,
	onClose,
	onRestored,
}: {
	open: boolean;
	rawPath: string;
	canRestore: boolean;
	onClose(): void;
	onRestored(): Promise<void> | void;
}) {
	const { t, i18n } = useTranslation();
	const [versions, setVersions] = useState<NoteVersionSummary[]>([]);
	const [selected, setSelected] = useState<NoteVersion | null>(null);
	const [loading, setLoading] = useState(false);
	const [restoring, setRestoring] = useState(false);
	const [confirmRestore, setConfirmRestore] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!open || !rawPath) return;
		let cancelled = false;
		setLoading(true);
		setError(null);
		void listNoteVersions(rawPath)
			.then(async (items) => {
				if (cancelled) return;
				setVersions(items);
				setSelected(items[0] ? await fetchNoteVersion(rawPath, items[0].versionId) : null);
			})
			.catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)))
			.finally(() => !cancelled && setLoading(false));
		return () => { cancelled = true; };
	}, [open, rawPath]);

	async function chooseVersion(version: NoteVersionSummary): Promise<void> {
		setLoading(true);
		setError(null);
		try {
			setSelected(await fetchNoteVersion(rawPath, version.versionId));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}

	async function restore(): Promise<void> {
		if (!selected) return;
		setRestoring(true);
		setError(null);
		try {
			await restoreNoteVersion(rawPath, selected.versionId);
			await onRestored();
			setConfirmRestore(false);
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setRestoring(false);
		}
	}

	if (!open || typeof document === "undefined") return null;
	return createPortal(
		<>
			<div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/45 p-4" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
				<div className="flex h-[min(720px,88vh)] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-[var(--inno-border)] bg-[var(--inno-surface)] shadow-2xl">
					<header className="flex items-center gap-2 border-b border-[var(--inno-border)] px-4 py-3">
						<History size={18} />
						<h2 className="font-semibold">{t("notes.history.title")}</h2>
						<button className="ml-auto rounded p-1.5 hover:bg-[var(--inno-surface-muted)]" onClick={onClose} aria-label={t("common.cancel")}><X size={17} /></button>
					</header>
					<div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)]">
						<aside className="overflow-y-auto border-r border-[var(--inno-border)]">
							{versions.map((version) => (
								<button key={version.versionId} className={`block w-full border-b border-[var(--inno-border)] px-3 py-2.5 text-left text-sm hover:bg-[var(--inno-surface-muted)] ${selected?.versionId === version.versionId ? "bg-[var(--inno-accent-soft)]" : ""}`} onClick={() => void chooseVersion(version)}>
									<div className="font-medium">{new Date(version.createdAt).toLocaleString(i18n.language)}</div>
									<div className="mt-1 text-xs text-[var(--inno-text-muted)]">{t(`notes.history.reason.${version.reason}`)} · {version.contentLength} {t("notes.history.characters")}</div>
								</button>
							))}
							{!loading && versions.length === 0 ? <p className="p-4 text-sm text-[var(--inno-text-muted)]">{t("notes.history.empty")}</p> : null}
						</aside>
						<main className="flex min-w-0 flex-col overflow-hidden" data-color-mode="light">
							{loading ? <div className="flex items-center gap-2 px-4 pt-4 text-sm text-[var(--inno-text-muted)]"><LoaderCircle size={15} className="animate-spin" />{t("common.loading")}</div> : null}
							{error ? <p className="mx-4 mt-4 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p> : null}
							{selected ? (
								<>
									<div className="border-b border-[var(--inno-border)] px-4 py-3">
										<h3 className="text-lg font-semibold">{selected.title}</h3>
										<div className="mt-2 flex flex-wrap gap-1">
											{selected.tags.map((tag) => <span key={tag} className="rounded bg-[var(--inno-surface-muted)] px-2 py-0.5 text-xs">#{tag}</span>)}
										</div>
									</div>
									<div className="min-h-0 flex-1 overflow-hidden">
										<MilkdownEditor
											editorKey={`note-version:${selected.versionId}`}
											value={normalizeMarkdownMath(selected.content)}
											onChange={() => undefined}
											resolveImageUrl={(url) => noteImageUrl(rawPath, url)}
											readOnly
										/>
									</div>
								</>
							) : null}
						</main>
					</div>
					<footer className="flex items-center justify-end border-t border-[var(--inno-border)] px-4 py-3">
						{canRestore ? <button className="inline-flex items-center gap-1.5 rounded-md bg-[var(--inno-accent)] px-3 py-1.5 text-sm text-white disabled:opacity-50" disabled={!selected || restoring} onClick={() => setConfirmRestore(true)}><RotateCcw size={14} />{t("notes.history.restore")}</button> : <span className="text-xs text-[var(--inno-text-muted)]">{t("notes.history.unarchiveToRestore")}</span>}
					</footer>
				</div>
			</div>
			<ConfirmDialog open={confirmRestore} title={t("notes.history.restoreTitle")} description={t("notes.history.restoreConfirm")} confirmLabel={t("notes.history.restore")} cancelLabel={t("common.cancel")} busy={restoring} onConfirm={() => void restore()} onCancel={() => setConfirmRestore(false)} />
		</>,
		document.body,
	);
}
