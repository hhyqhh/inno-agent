import { useCallback, useState } from "react";
import { ChevronDown, ChevronUp, Terminal as TerminalIcon, RotateCcw, History } from "lucide-react";
import { TerminalView } from "./TerminalView.js";
import { RunsPanel } from "./RunsPanel.js";
import { terminalStore, type TerminalStatus } from "../../stores/terminal-store.js";
import { sessionsStore } from "../../stores/sessions-store.js";
import { workspaceStore } from "../../stores/workspace-store.js";
import { useStoreSnapshot } from "../hooks.js";

const STATUS_LABEL: Record<TerminalStatus, string> = {
	idle: "未连接",
	connecting: "连接中…",
	connected: "已连接",
	running: "运行中…",
	disconnected: "已断开",
	error: "错误",
};

const STATUS_DOT: Record<TerminalStatus, string> = {
	idle: "bg-slate-300",
	connecting: "bg-amber-400 animate-pulse",
	connected: "bg-emerald-500",
	running: "bg-blue-500 animate-pulse",
	disconnected: "bg-slate-300",
	error: "bg-red-500",
};

/**
 * Bottom drawer hosting the xterm. Toggles open/closed; hands the actual
 * xterm DOM to TerminalView when open.
 */
export function TerminalDrawer() {
	const term = useStoreSnapshot(terminalStore, () => ({
		isOpen: terminalStore.isOpen,
		status: terminalStore.status,
		cwd: terminalStore.cwd,
		error: terminalStore.error,
		lastCommand: terminalStore.lastCommand,
	}));
	const sess = useStoreSnapshot(sessionsStore, () => ({
		currentSessionId: sessionsStore.currentSessionId,
	}));
	const ws = useStoreSnapshot(workspaceStore, () => ({
		activeWorkspaceId: workspaceStore.activeWorkspaceId,
	}));

	const [showHistory, setShowHistory] = useState(false);

	const toggle = useCallback(() => {
		terminalStore.setOpen(!term.isOpen);
	}, [term.isOpen]);

	const toggleHistory = useCallback(() => {
		// Make sure the drawer itself is open when showing history.
		if (!term.isOpen) terminalStore.setOpen(true);
		setShowHistory((v) => !v);
	}, [term.isOpen]);

	const restart = useCallback(async () => {
		if (!sess.currentSessionId) return;
		await terminalStore.disconnect();
		await terminalStore.connect(sess.currentSessionId, ws.activeWorkspaceId ?? undefined);
	}, [sess.currentSessionId, ws.activeWorkspaceId]);

	return (
		<div className={`flex flex-col border-t border-slate-200 bg-[var(--inno-workspace-bg)] ${term.isOpen ? "min-h-[220px]" : ""}`}>
			<div className="flex h-8 items-center gap-2 border-b border-slate-200 bg-[var(--inno-workspace-chrome)] px-2 text-xs text-slate-600">
				<button
					onClick={toggle}
					className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-slate-500 transition-colors hover:bg-white hover:text-slate-900"
					title={term.isOpen ? "收起终端" : "展开终端"}
				>
					<TerminalIcon size={12} />
					<span className="font-medium">终端</span>
					{term.isOpen ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
				</button>
				<span
					className={`inline-block h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[term.status]}`}
					title={STATUS_LABEL[term.status]}
					aria-label={STATUS_LABEL[term.status]}
				/>
				{term.cwd ? <span className="truncate text-[11px] text-slate-400" title={term.cwd}>{term.cwd}</span> : null}
				{term.error ? <span className="text-[11px] text-red-600">{term.error}</span> : null}
				<div className="ml-auto flex items-center gap-1">
					{term.isOpen && sess.currentSessionId ? (
						<>
							<button
								onClick={toggleHistory}
								className={`flex h-6 w-6 items-center justify-center rounded-md transition-colors ${showHistory ? "bg-white text-slate-900 ring-1 ring-slate-200" : "text-slate-400 hover:bg-white hover:text-slate-700"}`}
								title="历史"
							>
								<History size={12} />
							</button>
							<button
								onClick={() => void restart()}
								className="flex h-6 w-6 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-white hover:text-slate-700"
								title="重启终端"
							>
								<RotateCcw size={12} />
							</button>
						</>
					) : null}
				</div>
			</div>
			{term.isOpen ? (
				sess.currentSessionId ? (
					showHistory ? (
						<div className="min-h-[220px] flex-1">
							<RunsPanel sessionId={sess.currentSessionId} onClose={() => setShowHistory(false)} />
						</div>
					) : (
						<div className="flex-1 min-h-0 p-2">
							<div className="h-full overflow-hidden rounded-md border border-slate-200 bg-[#0f172a] p-1.5 shadow-inner">
								<TerminalView
									key={`${sess.currentSessionId}:${ws.activeWorkspaceId ?? "default"}`}
									innoSessionId={sess.currentSessionId}
									workspaceId={ws.activeWorkspaceId ?? undefined}
									className="h-[200px] w-full"
								/>
							</div>
						</div>
					)
				) : (
					<div className="flex h-[120px] items-center justify-center text-xs text-slate-500">
						请先打开或新建一个会话
					</div>
				)
			) : null}
		</div>
	);
}
