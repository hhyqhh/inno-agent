import { useCallback, useEffect, useState } from "react";
import { Archive, ChevronRight, RefreshCw, X } from "lucide-react";
import { archiveRun, getRun, listRuns } from "../../api/terminal.js";
import { notebookStore } from "../../stores/notebook-store.js";
import type { RunRecord } from "../../types/terminal.js";

interface RunsPanelProps {
	sessionId: string;
	onClose(): void;
}

function statusBadge(code: number | null | undefined): { text: string; cls: string } {
	if (code === null || code === undefined) return { text: "未完成", cls: "bg-[var(--inno-surface-muted)] text-[var(--inno-text-muted)] ring-1 ring-slate-200" };
	if (code === 0) return { text: "✓ 0", cls: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100" };
	return { text: `✗ ${code}`, cls: "bg-red-50 text-red-700 ring-1 ring-red-100" };
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
			setError(err instanceof Error ? err.message : "加载失败");
		} finally {
			setLoading(false);
		}
	}, [sessionId, selectedId]);

	useEffect(() => { void load(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [sessionId]);

	useEffect(() => {
		if (!selectedId) { setDetail(null); return; }
		let cancelled = false;
		void getRun(selectedId, 500)
			.then((d) => { if (!cancelled) setDetail(d); })
			.catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "加载详情失败"); });
		return () => { cancelled = true; };
	}, [selectedId]);

	const handleArchive = useCallback(async () => {
		if (!detail) return;
		setArchiveBusy(true);
		setArchiveMsg("");
		try {
			const r = await archiveRun(detail.id, { title: `Run: ${detail.command.slice(0, 40)}` });
			setArchiveMsg(`已归档为 ${r.path}`);
			// Refresh the Notebook tab so the new page shows up immediately.
			void notebookStore.loadAll();
		} catch (err) {
			setArchiveMsg(err instanceof Error ? err.message : "归档失败");
		} finally {
			setArchiveBusy(false);
		}
	}, [detail]);

	return (
		<div className="flex h-full min-h-0 flex-1 flex-col bg-[var(--inno-surface)] text-[var(--inno-text)]">
			<div className="flex h-8 items-center gap-2 border-b border-[var(--inno-border)] bg-[var(--inno-workspace-chrome)] px-2 text-xs text-[var(--inno-text-muted)]">
				<span className="font-medium text-[var(--inno-text)]">运行历史</span>
				<span className="text-[11px] text-[var(--inno-text-subtle)]">{runs.length} 条</span>
				<button
					onClick={() => void load()}
					disabled={loading}
					className="ml-auto flex h-6 w-6 items-center justify-center rounded-md text-[var(--inno-text-subtle)] transition-colors hover:bg-[var(--inno-surface)] hover:text-[var(--inno-text)] disabled:opacity-40"
					title="刷新"
				>
					<RefreshCw size={12} className={loading ? "animate-spin" : ""} />
				</button>
				<button
					onClick={onClose}
					className="flex h-6 w-6 items-center justify-center rounded-full text-[var(--inno-text-subtle)] transition-colors hover:bg-[var(--inno-surface)] hover:text-[var(--inno-text)]"
					title="关闭"
				>
					<X size={12} />
				</button>
			</div>

			<div className="grid min-h-0 flex-1 grid-cols-[220px_minmax(0,1fr)] divide-x divide-slate-200">
				{/* List */}
				<div className="min-h-0 overflow-y-auto bg-[var(--inno-workspace-bg)]">
					{runs.length === 0 && !loading ? (
						<div className="p-3 text-center text-xs text-[var(--inno-text-subtle)]">暂无运行记录</div>
					) : null}
					{runs.map((r) => {
						const badge = statusBadge(r.exitCode);
						const selected = r.id === selectedId;
						return (
							<button
								key={r.id}
								onClick={() => setSelectedId(r.id)}
								className={`flex w-full items-start gap-2 border-b border-[var(--inno-border)] px-2 py-1.5 text-left text-[11px] transition-colors ${selected ? "bg-[var(--inno-surface)] ring-1 ring-inset ring-slate-200" : "hover:bg-[var(--inno-surface)]"}`}
							>
								<span className={`shrink-0 rounded px-1 py-0.5 font-mono ${badge.cls}`}>{badge.text}</span>
								<div className="min-w-0 flex-1">
									<div className="truncate font-mono text-[var(--inno-text)]" title={r.command}>{r.command}</div>
									<div className="truncate text-[10px] text-[var(--inno-text-subtle)]">{formatTime(r.startedAt)} · {formatDuration(r.startedAt, r.endedAt)}{r.sourceFile ? ` · ${r.sourceFile}` : ""}</div>
								</div>
								<ChevronRight size={10} className="mt-0.5 shrink-0 text-[var(--inno-text-subtle)]" />
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
									exit={detail.exitCode ?? "(none)"} · {formatDuration(detail.startedAt, detail.endedAt)} · {detail.sourceFile ? `源: ${detail.sourceFile}` : "无源文件"}
								</div>
								<div className="truncate text-[10px] text-[var(--inno-text-subtle)]" title={detail.cwd}>cwd: {detail.cwd}</div>
							</div>
							<div className="flex items-center gap-2 border-b border-[var(--inno-border)] bg-[var(--inno-surface)] px-2 py-1">
								<button
									onClick={() => void handleArchive()}
									disabled={archiveBusy}
									className="flex h-6 items-center gap-1 rounded-full inno-primary-button px-2 text-[11px] font-medium text-white transition-colors disabled:opacity-50"
								>
									{archiveBusy ? "归档中…" : "归档为笔记"}
								</button>
								{archiveMsg ? <span className="text-[10px] text-[var(--inno-text-muted)]">{archiveMsg}</span> : null}
							</div>
							<pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words bg-[#0f172a] p-3 font-mono text-[11px] leading-snug text-slate-100">
								{detail.outputTail || "(无输出)"}
							</pre>
						</>
					) : (
						<div className="flex h-full items-center justify-center text-xs text-[var(--inno-text-subtle)]">选择左侧一条记录查看详情</div>
					)}
				</div>
			</div>
			{error ? <div className="border-t border-red-200 bg-red-50 p-2 text-[11px] text-red-700">{error}</div> : null}
		</div>
	);
}
