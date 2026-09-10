import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { BellRing, Play } from "lucide-react";
import { claimOccurrence, getPendingRuns, skipOccurrence, type PendingRun } from "../../api/checkins.js";
import { chatStore } from "../../stores/chat-store.js";
import { sessionsStore } from "../../stores/sessions-store.js";
import { findJobById, runJobInConversation } from "../jobs/runJobInConversation.js";

/** Claim the slot slightly before the deadline so the client wins the race
 *  against the server-side headless auto-execution. */
const TAKEOVER_LEAD_MS = 1_200;

/**
 * In-app notice for fired interactive scheduled slots: theme-styled banner
 * with a countdown. 立即执行 / countdown takeover both run the slot in a
 * fresh conversation with live streaming; 不执行 marks it skipped. If the
 * page is idle the server still auto-executes headless at the deadline.
 */
export function ScheduledRunBanner() {
	const { t } = useTranslation();
	const [runs, setRuns] = useState<PendingRun[]>([]);
	const [busyId, setBusyId] = useState<string | null>(null);
	const busyRef = useRef<string | null>(null);
	const runsRef = useRef<PendingRun[]>([]);
	const handledRef = useRef<Set<string>>(new Set());
	const [, setTick] = useState(0);
	runsRef.current = runs;
	busyRef.current = busyId;

	useEffect(() => {
		let disposed = false;
		const poll = async (): Promise<void> => {
			try {
				const next = await getPendingRuns();
				if (disposed) return;
				// A run that vanished without our doing means the server settled
				// it (auto-exec) — pull the new conversation into the sidebar.
				const nextIds = new Set(next.map((run) => run.occurrenceId));
				const vanished = runsRef.current.some((run) => !nextIds.has(run.occurrenceId) && !handledRef.current.has(run.occurrenceId));
				if (vanished) void sessionsStore.refresh();
				setRuns(next);
			} catch {
				// transient — retry on the next tick
			}
		};
		void poll();
		const pollTimer = setInterval(poll, 2_000);
		const tickTimer = setInterval(() => {
			setTick((value) => value + 1);
			// Countdown takeover: with the page open the client runs the slot
			// itself so the output streams visibly instead of headless.
			for (const run of runsRef.current) {
				if (handledRef.current.has(run.occurrenceId)) continue;
				if (Date.parse(run.deadline) - Date.now() > TAKEOVER_LEAD_MS) continue;
				if (chatStore.isSending || chatStore.jobStreaming || busyRef.current) continue;
				handledRef.current.add(run.occurrenceId);
				void takeOver(run);
			}
		}, 500);
		return () => {
			disposed = true;
			clearInterval(pollTimer);
			clearInterval(tickTimer);
		};
	}, []);

	async function takeOver(run: PendingRun): Promise<void> {
		setBusyId(run.occurrenceId);
		try {
			await claimOccurrence(run.occurrenceId);
			const job = await findJobById(run.jobId);
			if (!job) {
				void sessionsStore.refresh();
				return;
			}
			setRuns((prev) => prev.filter((candidate) => candidate.occurrenceId !== run.occurrenceId));
			await runJobInConversation(job, t, run.occurrenceId);
		} catch {
			// Server already started it (or the slot settled) — just resync.
			setRuns((prev) => prev.filter((candidate) => candidate.occurrenceId !== run.occurrenceId));
			void sessionsStore.refresh();
		} finally {
			setBusyId(null);
		}
	}

	async function handleRun(run: PendingRun): Promise<void> {
		if (busyId) return;
		handledRef.current.add(run.occurrenceId);
		setBusyId(run.occurrenceId);
		try {
			// Only one conversation may stream — stop whatever is active first.
			if (chatStore.isSending) chatStore.cancel();
			if (chatStore.jobStreaming) chatStore.cancelJobStream();
			const job = await findJobById(run.jobId);
			if (!job) return;
			setRuns((prev) => prev.filter((candidate) => candidate.occurrenceId !== run.occurrenceId));
			await runJobInConversation(job, t, run.occurrenceId);
		} finally {
			setBusyId(null);
		}
	}

	async function handleSkip(run: PendingRun): Promise<void> {
		handledRef.current.add(run.occurrenceId);
		try {
			await skipOccurrence(run.occurrenceId);
		} finally {
			setRuns((prev) => prev.filter((candidate) => candidate.occurrenceId !== run.occurrenceId));
		}
	}

	if (runs.length === 0) return null;

	return (
		<div className="absolute left-1/2 top-3 z-50 flex w-[min(92%,26rem)] -translate-x-1/2 flex-col gap-2">
			{runs.map((run) => {
				const secondsLeft = Math.max(0, Math.ceil((Date.parse(run.deadline) - Date.now()) / 1000));
				const isBusy = busyId === run.occurrenceId;
				return (
					<div
						key={run.occurrenceId}
						role="status"
						className="flex items-stretch overflow-hidden rounded-xl border border-[var(--inno-border)] bg-[var(--inno-surface)] shadow-lg"
					>
						<div className="flex items-center bg-[var(--inno-accent-soft)] px-3">
							<BellRing size={18} className="text-[var(--inno-accent)]" />
						</div>
						<div className="min-w-0 flex-1 px-3 py-2.5">
							<div className="truncate text-sm font-medium text-[var(--inno-text)]">
								{t("jobs.pending.title", { name: run.jobName })}
							</div>
							<div className="mt-0.5 text-xs text-[var(--inno-text-muted)]">
								{secondsLeft > 0
									? t("jobs.pending.countdown", { seconds: secondsLeft })
									: t("jobs.pending.starting")}
							</div>
						</div>
						<div className="flex items-center gap-1.5 px-3">
							<button
								type="button"
								className="flex items-center gap-1 rounded-md inno-primary-button px-3 py-1.5 text-xs text-white disabled:cursor-wait disabled:opacity-60"
								disabled={Boolean(busyId)}
								onClick={() => void handleRun(run)}
							>
								<Play size={12} />
								{t("jobs.pending.runNow")}
							</button>
							<button
								type="button"
								className="rounded-md px-2 py-1.5 text-xs text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)] disabled:cursor-wait disabled:opacity-60"
								disabled={Boolean(busyId)}
								onClick={() => void handleSkip(run)}
							>
								{t("jobs.pending.skip")}
							</button>
						</div>
					</div>
				);
			})}
		</div>
	);
}
