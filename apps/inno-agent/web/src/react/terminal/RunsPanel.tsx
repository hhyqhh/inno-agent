import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Archive, ChevronRight, RefreshCw, X } from "lucide-react";
import { archiveRun, getRun, listRuns } from "../../api/terminal.js";
import { notebookStore } from "../../stores/notebook-store.js";
import type { RunRecord } from "../../types/terminal.js";

interface RunsPanelProps {
	sessionId: string;
	onClose(): void;
}

function statusBadge(code: number | null | undefined, incompleteLabel: string): { text: string; cls: string } {
	if (code === null || code === undefined) return { text: incompleteLabel, cls: "bg-[var(--inno-surface-muted)] text-[var(--inno-text-muted)]" };
	if (code === 0) return { text: "✓ 0", cls: "bg-[var(--inno-success-bg)] text-[var(--inno-success)]" };
	return { text: `✗ ${code}`, cls: "bg-[var(--inno-danger-bg)] text-[var(--inno-danger)]" };
}

function formatDuration(start: string, end?: string): string {
	if (!end) return "—";
	const ms = Date.parse(end) - Date.parse(start);
	if (ms < 1000) return `${ms} ms`;
	return `${(ms / 1000).toFixed(1)} s`;
}

function formatTime(iso: string): string {
	const d = new Date(iso);
	return d.toLocaleTimeString();
}

export function RunsPanel({ sessionId, onClose }: RunsPanelProps) {
	const { t } = useTranslation();
	const [runs, setRuns] = useState<RunRecord[]>([]);
	const [loading, setLoading] = useState(false);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [detail, setDetail] = useState<RunRecord | null>(null);
	const [error, setError] = useState("");
	const [archiveBusy, setArchiveBusy] = useState(false);
	const [archiveMsg, setArchiveMsg] = useState("");

	const load = useCallback(async () => {
		if (!sessionId) return;
		setLoading(true);
		try {
			const list = await listRuns(sessionId, 30);
			setRuns(list);
			if (list.length > 0 && !selectedId) setSelectedId(list[0].id);
		} catch (err) {
			setError(err instanceof Error ? err.message : t("terminal.runs.loadFailed"));
		} finally {
			setLoading(false);
		}
	}, [sessionId, selectedId, t]);

	useEffect(() => { void load(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [sessionId]);

	useEffect(() => {
		if (!selectedId) { setDetail(null); return; }
		let cancelled = false;
		void getRun(selectedId, 500)
			.then((d) => { if (!cancelled) setDetail(d); })
			.catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : t("terminal.runs.loadDetailFailed")); });
		return () => { cancelled = true; };
	}, [selectedId, t]);

	const handleArchive = useCallback(async () => {
		if (!detail) return;
		setArchiveBusy(true);
		setArchiveMsg("");
		try {
			const r = await archiveRun(detail.id, { title: `Run: ${detail.command.slice(0, 40)}` });
			setArchiveMsg(t("terminal.runs.archivedTo", { path: r.path }));
			// Refresh the Notebook tab so the new page shows up immediately.
			void notebookStore.loadAll();
		} catch (err) {
			setArchiveMsg(err instanceof Error ? err.message : t("terminal.runs.archiveFailed"));
		} finally {
			setArchiveBusy(false);
		}
	}, [detail, t]);

	return (
		<div className="flex h-full min-h-0 flex-1 flex-col bg-[var(--inno-surface)] text-[var(--inno-text)]">
			<div className="flex h-8 items-center gap-2 border-b border-[var(--inno-border)] bg-[var(--inno-workspace-chrome)] px-2 text-xs text-[var(--inno-text-muted)]">
				<span className="font-medium text-[var(--inno-text)]">{t("terminal.runs.title")}</span>
				<span className="text-[11px] text-[var(--inno-text-subtle)]">{t("terminal.runs.count", { count: runs.length })}</span>
				<button
					onClick={() => void load()}
					disabled={loading}
					className="ml-auto flex h-6 w-6 items-center justify-center rounded-md text-[var(--inno-text-subtle)] transition-colors hover:bg-[var(--inno-surface)] hover:text-[var(--inno-text)] disabled:opacity-40"
					title={t("common.refresh")}
				>
					<RefreshCw size={12} className={loading ? "animate-spin" : ""} />
				</button>
				<button
					onClick={onClose}
					className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--inno-text-subtle)] transition-colors hover:bg-[var(--inno-surface)] hover:text-[var(--inno-text)]"
					title={t("common.close")}
				>
					<X size={12} />
				</button>
			</div>

			<div className="grid min-h-0 flex-1 grid-cols-[220px_minmax(0,1fr)] divide-x divide-[var(--inno-border)]">
				{/* List */}
				<div className="min-h-0 overflow-y-auto bg-[var(--inno-workspace-bg)]">
					{runs.length === 0 && !loading ? (
						<div className="p-3 text-center text-xs text-[var(--inno-text-subtle)]">{t("terminal.runs.empty")}</div>
					) : null}
					{runs.map((r) => {
						const badge = statusBadge(r.exitCode, t("terminal.runs.incomplete"));
						const selected = r.id === selectedId;
						return (
							<button
								key={r.id}
								onClick={() => setSelectedId(r.id)}
								className={`flex w-full items-start gap-2 px-2 py-1.5 text-left text-[11px] transition-colors ${selected ? "bg-[var(--inno-surface)] ring-1 ring-inset ring-[var(--inno-border)]" : "hover:bg-[var(--inno-surface)]"}`}
							>
								<span className={`shrink-0 rounded px-1 py-0.5 font-mono ${badge.cls}`}>{badge.text}</span>
								<div className="min-w-0 flex-1">
									<div className="truncate font-mono text-[var(--inno-text)]" title={r.command}>{r.command}</div>
									<div className="truncate text-[10px] text-[var(--inno-text-subtle)]">{formatTime(r.startedAt)} · {formatDuration(r.startedAt, r.endedAt)}{r.sourceFile ? ` · ${r.sourceFile}` : ""}</div>
								</div>
								<ChevronRight size={12} className="mt-0.5 shrink-0 text-[var(--inno-text-subtle)]" />
							</button>
						);
					})}
				</div>

				{/* Detail */}
				<div className="flex min-h-0 min-w-0 flex-col bg-[var(--inno-surface)]">
					{detail ? (
						<>
							<div className="border-b border-[var(--inno-border)] bg-[var(--inno-workspace-chrome)] p-2 text-[11px]">
								<div className="mb-1 break-all font-mono text-[var(--inno-text)]">{detail.command}</div>
								<div className="text-[var(--inno-text-muted)]">
									exit={detail.exitCode ?? "(none)"} · {formatDuration(detail.startedAt, detail.endedAt)} · {detail.sourceFile ? t("terminal.runs.source", { file: detail.sourceFile }) : t("terminal.runs.noSource")}
								</div>
								<div className="truncate text-[10px] text-[var(--inno-text-subtle)]" title={detail.cwd}>cwd: {detail.cwd}</div>
							</div>
							<div className="flex items-center gap-2 border-b border-[var(--inno-border)] bg-[var(--inno-surface)] px-2 py-1">
								<button
									onClick={() => void handleArchive()}
									disabled={archiveBusy}
									className="flex h-6 items-center gap-1 rounded-md inno-primary-button px-2 text-[11px] font-medium text-white transition-colors disabled:opacity-50"
								>
									<Archive size={12} />
									{archiveBusy ? t("terminal.runs.archiving") : t("terminal.runs.archiveAsNote")}
								</button>
								{archiveMsg ? <span className="text-[10px] text-[var(--inno-text-muted)]">{archiveMsg}</span> : null}
							</div>
							<pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words bg-[#0f172a] p-3 font-mono text-[11px] leading-snug text-[var(--inno-text-muted)]">
								{detail.outputTail || t("terminal.runs.noOutput")}
							</pre>
						</>
					) : (
						<div className="flex h-full items-center justify-center text-xs text-[var(--inno-text-subtle)]">{t("terminal.runs.selectRecord")}</div>
					)}
				</div>
			</div>
			{error ? <div className="border-t border-[var(--inno-danger-border)] bg-[var(--inno-danger-bg)] p-2 text-[11px] text-[var(--inno-danger)]">{error}</div> : null}
		</div>
	);
}
