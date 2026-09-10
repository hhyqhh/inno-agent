import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CalendarCheck, Check, ChevronDown, ChevronUp, CircleAlert, Clock, Flame, Play, SkipForward } from "lucide-react";
import { getCheckInStatus } from "../../api/checkins.js";
import type { CheckInOccurrence, CheckInStatus } from "../../types/checkins.js";
import { jobsStore } from "../../stores/jobs-store.js";
import { findJobById, runJobInConversation } from "./runJobInConversation.js";
import { Spinner } from "../ui/Spinner.js";

function formatTime(iso: string, timezone: string): string {
	try {
		return new Date(iso).toLocaleTimeString(undefined, { timeZone: timezone, hour: "2-digit", minute: "2-digit" });
	} catch {
		return iso;
	}
}

interface CheckInCardProps {
	onStatusChange?: (status: CheckInStatus) => void;
}

export function CheckInCard({ onStatusChange }: CheckInCardProps) {
	const { t } = useTranslation();
	const [status, setStatus] = useState<CheckInStatus | null>(null);
	const [isLoading, setIsLoading] = useState(true);
	const [isOpen, setIsOpen] = useState(true);
	const [runningOccurrenceId, setRunningOccurrenceId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const lastDayStatus = useRef<CheckInStatus["dayStatus"] | null>(null);

	const applyStatus = useCallback((next: CheckInStatus): void => {
		if (lastDayStatus.current !== null && lastDayStatus.current !== "completed" && next.dayStatus === "completed") {
			setNotice(t("jobs.checkIn.autoCompleted"));
		}
		lastDayStatus.current = next.dayStatus;
		onStatusChange?.(next);
		setStatus(next);
	}, [onStatusChange, t]);

	const refresh = useCallback(async (): Promise<void> => {
		try {
			const next = await getCheckInStatus();
			applyStatus(next);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setIsLoading(false);
		}
	}, [applyStatus]);

	useEffect(() => {
		void refresh();
		// 15s: keeps slot states (and the run/retry buttons) fresh enough that a
		// user rarely clicks into a slot the server already settled.
		const timer = setInterval(() => void refresh(), 15_000);
		const unsubscribe = jobsStore.on("change", () => void refresh());
		return () => {
			clearInterval(timer);
			unsubscribe();
		};
	}, [refresh]);

	async function runOccurrence(occurrence: CheckInOccurrence): Promise<void> {
		if (runningOccurrenceId) return;
		setRunningOccurrenceId(occurrence.occurrenceId);
		setError(null);
		setNotice(null);
		try {
			// Slot runs follow the same flow as the jobs panel: a dedicated
			// conversation with the run streamed into it. The card refreshes via
			// the jobsStore change events the run emits.
			const job = await findJobById(occurrence.jobId);
			if (!job) {
				setError(t("jobs.errors.jobNotFound"));
				return;
			}
			await runJobInConversation(job, t, occurrence.occurrenceId);
			// The run may have been silently dropped (slot already settled) —
			// pull the fresh plan so the card never shows a stale button.
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			await refresh();
		} finally {
			setRunningOccurrenceId(null);
		}
	}

	return (
		<section className="rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] p-3" aria-live="polite">
			<button
				type="button"
				className="flex w-full items-start justify-between gap-3 text-left"
				onClick={() => setIsOpen((open) => !open)}
				aria-expanded={isOpen}
			>
				<div className="flex min-w-0 items-start gap-2">
					<div className="mt-0.5 rounded-md bg-[var(--inno-warning-bg)] p-1.5 text-[var(--inno-warning)]">
						<CalendarCheck size={16} />
					</div>
					<div className="min-w-0">
						<h3 className="text-sm font-medium text-[var(--inno-text)]">{t("jobs.checkIn.title")}</h3>
						<p className="mt-0.5 text-xs text-[var(--inno-text-muted)]">
							{status?.dayStatus === "no_tasks" ? t("jobs.checkIn.noTasks") : t("jobs.checkIn.subtitle")}
						</p>
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					{status?.todayCheckedIn ? (
						<span className="flex items-center gap-1 text-xs text-[var(--inno-success)]">
							<Check size={13} />
							{t("jobs.checkIn.completed")}
						</span>
					) : null}
					{isOpen ? <ChevronUp size={15} className="text-[var(--inno-text-muted)]" /> : <ChevronDown size={15} className="text-[var(--inno-text-muted)]" />}
				</div>
			</button>

			{isLoading ? (
				<div className="mt-3 flex items-center text-xs text-[var(--inno-text-muted)]">
					<Spinner size={14} className="mr-1.5" />
					{t("common.loading")}
				</div>
			) : status ? (
				<div className="mt-3 flex items-center justify-between gap-2">
					<div className="text-sm text-[var(--inno-text)]">
						{status.dayStatus === "no_tasks"
							? t("jobs.checkIn.noTasks")
							: t("jobs.checkIn.progress", { completed: status.completedCount, total: status.requiredCount })}
					</div>
					{status.failedCount > 0 ? (
						<span className="flex items-center gap-1 text-xs text-[var(--inno-danger)]">
							<CircleAlert size={13} />
							{t("jobs.checkIn.failedCount", { count: status.failedCount })}
						</span>
					) : null}
				</div>
			) : null}

			{isOpen && status && status.dayStatus !== "no_tasks" ? (
				<div className="mt-3 flex flex-col gap-3 border-t border-[var(--inno-border)] pt-3">
					{status.jobs.map((job) => (
						<div key={job.jobId}>
							<div className="mb-1 text-xs font-medium text-[var(--inno-text)]">{job.jobName}</div>
							<div className="flex flex-col gap-1">
								{job.occurrences.map((occurrence) => {
									const isRunning = runningOccurrenceId === occurrence.occurrenceId;
									const isFailed = occurrence.status === "error";
									return (
										<div key={occurrence.occurrenceId} className="flex items-center justify-between gap-2 rounded-md bg-[var(--inno-surface-muted)] px-2 py-1.5 text-xs">
											<div className="flex min-w-0 items-center gap-1.5 text-[var(--inno-text-muted)]">
												{occurrence.status === "success" ? <Check size={13} className="shrink-0 text-[var(--inno-success)]" /> : null}
												{occurrence.status === "skipped" ? <SkipForward size={13} className="shrink-0 text-[var(--inno-text-muted)]" /> : null}
												{occurrence.status === "error" ? <CircleAlert size={13} className="shrink-0 text-[var(--inno-danger)]" /> : null}
												{occurrence.status === "pending" ? <Clock size={13} className="shrink-0 text-[var(--inno-warning)]" /> : null}
												<span>{formatTime(occurrence.scheduledAt, status.timezone)}</span>
												<span className={isFailed ? "text-[var(--inno-danger)]" : ""}>
													{occurrence.status === "success" ? t("jobs.checkIn.slotSuccess") : null}
													{occurrence.status === "pending" ? t("jobs.checkIn.slotPending") : null}
													{occurrence.status === "error" ? t("jobs.checkIn.slotFailed") : null}
													{occurrence.status === "skipped" ? t("jobs.checkIn.slotSkipped") : null}
												</span>
											</div>
											{occurrence.status === "pending" || occurrence.status === "error" ? (
												<button
													type="button"
									className="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-[var(--inno-accent)] hover:bg-[var(--inno-surface)] disabled:cursor-wait disabled:opacity-50"
													disabled={Boolean(runningOccurrenceId)}
													onClick={() => void runOccurrence(occurrence)}
												>
													{isRunning ? <Spinner size={12} /> : <Play size={12} />}
													{isFailed ? t("jobs.checkIn.retry") : t("jobs.checkIn.runNow")}
												</button>
											) : null}
										</div>
									);
								})}
							</div>
						</div>
					))}
					{status.skippedCount > 0 ? (
						<div className="text-[10px] text-[var(--inno-text-muted)]">
							{t("jobs.checkIn.skippedNote", { count: status.skippedCount })}
						</div>
					) : null}
				</div>
			) : null}

			{status ? (
				<div className="mt-3 grid grid-cols-3 gap-2 text-center">
					<div className="rounded-md bg-[var(--inno-surface-muted)] px-2 py-1.5">
						<div className="flex items-center justify-center gap-1 text-sm font-semibold text-[var(--inno-text)]">
							<Flame size={14} className="text-[var(--inno-warning)]" />
							{status.currentStreak}
						</div>
						<div className="mt-0.5 text-[10px] text-[var(--inno-text-muted)]">{t("jobs.checkIn.currentStreak")}</div>
					</div>
					<div className="rounded-md bg-[var(--inno-surface-muted)] px-2 py-1.5">
						<div className="text-sm font-semibold text-[var(--inno-text)]">{status.totalCount}</div>
						<div className="mt-0.5 text-[10px] text-[var(--inno-text-muted)]">{t("jobs.checkIn.total")}</div>
					</div>
					<div className="rounded-md bg-[var(--inno-surface-muted)] px-2 py-1.5">
						<div className="text-sm font-semibold text-[var(--inno-text)]">{status.longestStreak}</div>
						<div className="mt-0.5 text-[10px] text-[var(--inno-text-muted)]">{t("jobs.checkIn.longestStreak")}</div>
					</div>
				</div>
			) : null}

			{notice ? <div className="mt-2 rounded-md bg-[var(--inno-success-bg)] px-2 py-1.5 text-xs text-[var(--inno-success)]" role="status">{notice}</div> : null}
			{error ? <div className="mt-2 text-xs text-[var(--inno-danger)]">{t("jobs.checkIn.error", { message: error })}</div> : null}
		</section>
	);
}
