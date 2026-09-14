import { AnimatePresence, motion } from "motion/react";
import { lazy, Suspense, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Terminal as TerminalIcon, RotateCcw, History } from "lucide-react";
import { RunsPanel } from "./RunsPanel.js";
import { terminalStore, type TerminalStatus } from "../../stores/terminal-store.js";
import { sessionsStore } from "../../stores/sessions-store.js";
import { workspaceStore } from "../../stores/workspace-store.js";
import { useStoreSnapshot } from "../hooks.js";

const TerminalView = lazy(() => import("./TerminalView.js").then((module) => ({ default: module.TerminalView })));

/**
 * Touch accessory keys. Soft keyboards have no Esc/Tab/arrows/Ctrl, so coarse
 * pointers get a key bar (display gated by pointer: coarse CSS). Values are
 * the raw escape/control bytes sent straight to the PTY.
 */
const TOUCH_KEY_BAR: { label: string; data: string; title: string }[] = [
	{ label: "Esc", data: "\x1b", title: "Escape" },
	{ label: "Tab", data: "\t", title: "Tab" },
	{ label: "↑", data: "\x1b[A", title: "Arrow up" },
	{ label: "↓", data: "\x1b[B", title: "Arrow down" },
	{ label: "←", data: "\x1b[D", title: "Arrow left" },
	{ label: "→", data: "\x1b[C", title: "Arrow right" },
	{ label: "⌃C", data: "\x03", title: "Ctrl+C" },
	{ label: "⌃D", data: "\x04", title: "Ctrl+D" },
	{ label: "⌃L", data: "\x0c", title: "Ctrl+L" },
	{ label: "⌃Z", data: "\x1a", title: "Ctrl+Z" },
];

const STATUS_DOT: Record<TerminalStatus, string> = {
	idle: "bg-[var(--inno-border-strong)]",
	connecting: "bg-[var(--inno-warning)] animate-pulse",
	connected: "bg-[var(--inno-success)]",
	running: "bg-[var(--inno-accent)] animate-pulse",
	disconnected: "bg-[var(--inno-border-strong)]",
	error: "bg-[var(--inno-danger)]",
};

/**
 * Bottom drawer hosting the xterm. The closed state is not rendered; the
 * actual xterm DOM is kept through the exit animation and then unmounted.
 */
export function TerminalDrawer() {
	const { t } = useTranslation();
	const STATUS_LABEL: Record<TerminalStatus, string> = {
		idle: t("terminal.status.idle"),
		connecting: t("terminal.status.connecting"),
		connected: t("terminal.status.connected"),
		running: t("terminal.status.running"),
		disconnected: t("terminal.status.disconnected"),
		error: t("terminal.status.error"),
	};
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
		<AnimatePresence>
			{term.isOpen ? (
				<motion.div
					key="practice-terminal"
					initial={{ height: 0, opacity: 0 }}
					animate={{ height: "auto", opacity: 1 }}
					exit={{ height: 0, opacity: 0 }}
					transition={{ duration: 0.3, ease: [0.23, 1, 0.32, 1] }}
					className="flex shrink-0 flex-col overflow-hidden border-t border-[var(--inno-border)] bg-[var(--inno-workspace-bg)]"
				>
					<div className="flex h-8 items-center gap-2 border-b border-[var(--inno-border)] bg-[var(--inno-workspace-chrome)] px-2 text-xs text-[var(--inno-text-muted)]">
						<button
							onClick={toggle}
							className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[var(--inno-text-muted)] transition-colors hover:bg-[var(--inno-surface)] hover:text-[var(--inno-text)]"
							title={term.isOpen ? t("terminal.collapse") : t("terminal.expand")}
						>
							<TerminalIcon size={12} />
							<span className="font-medium">{t("terminal.title")}</span>
							<ChevronDown size={12} />
						</button>
						<span
							className={`inline-block h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[term.status]}`}
							title={STATUS_LABEL[term.status]}
							aria-label={STATUS_LABEL[term.status]}
						/>
						{term.cwd ? <span className="truncate text-[11px] text-[var(--inno-text-subtle)]" title={term.cwd}>{term.cwd}</span> : null}
						{term.error ? <span className="text-[11px] text-[var(--inno-danger)]">{term.error}</span> : null}
						<div className="ml-auto flex items-center gap-1">
							{term.isOpen && sess.currentSessionId ? (
								<>
									<button
										onClick={toggleHistory}
										className={`flex h-6 w-6 items-center justify-center rounded-md transition-colors ${showHistory ? "bg-[var(--inno-surface)] text-[var(--inno-text)]" : "text-[var(--inno-text-subtle)] hover:bg-[var(--inno-surface)] hover:text-[var(--inno-text)]"}`}
										title={t("terminal.history")}
									>
										<History size={12} />
									</button>
									<button
										onClick={() => void restart()}
										className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--inno-text-subtle)] transition-colors hover:bg-[var(--inno-surface)] hover:text-[var(--inno-text)]"
										title={t("terminal.restart")}
									>
										<RotateCcw size={12} />
									</button>
								</>
							) : null}
						</div>
					</div>
					{sess.currentSessionId ? (
						showHistory ? (
							<div className="min-h-[220px] flex-1">
								<RunsPanel sessionId={sess.currentSessionId} onClose={() => setShowHistory(false)} />
							</div>
						) : (
							<div className="flex-1 min-h-0 p-2">
								<div className="inno-terminal-keybar" role="toolbar" aria-label={t("terminal.title")}>
									{TOUCH_KEY_BAR.map((key) => (
										<button
											key={key.label}
											type="button"
											className="inno-terminal-key"
											title={key.title}
											onClick={() => terminalStore.input(key.data)}
										>
											{key.label}
										</button>
									))}
								</div>
								<Suspense fallback={<div className="h-[200px] w-full" aria-busy="true" />}>
									<TerminalView
										key={`${sess.currentSessionId}:${ws.activeWorkspaceId ?? "default"}`}
										innoSessionId={sess.currentSessionId}
										workspaceId={ws.activeWorkspaceId ?? undefined}
										className="h-[200px] w-full max-md:h-[38dvh]"
									/>
								</Suspense>
							</div>
						)
					) : (
						<div className="flex h-[120px] items-center justify-center text-xs text-[var(--inno-text-muted)]">
							{t("terminal.noSession")}
						</div>
					)}
				</motion.div>
			) : null}
		</AnimatePresence>
	);
}
