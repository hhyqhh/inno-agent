import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { motion } from "motion/react";
import { Plus, Play, Pencil, ToggleLeft, ToggleRight, Trash2 } from "lucide-react";
import { jobsStore } from "../stores/jobs-store.js";
import type { CreateJobInput, ScheduledJob, TaskType } from "../types/jobs.js";
import { useStoreSnapshot } from "./hooks.js";
import { checkboxCls } from "./ui/checkbox.js";
import { Spinner } from "./ui/Spinner.js";
import { ScheduleEditor } from "./jobs/ScheduleEditor.js";
import {
	DEFAULT_SCHEDULE,
	cronToSchedule,
	humanizeCron,
	humanizeSchedule,
	scheduleToCron,
	type ScheduleSpec,
} from "../lib/schedule.js";

const TASK_TYPE_IDS: TaskType[] = [
	"daily_review",
	"weekly_summary",
	"graphify_update",
	"learner_profile_reflection",
	"spaced_review",
	"push_reminder",
	"custom_prompt",
];

interface JobFormState {
	name: string;
	schedule: ScheduleSpec;
	taskType: TaskType;
	prompt: string;
	enabled: boolean;
}

const defaultForm: JobFormState = {
	name: "",
	schedule: { ...DEFAULT_SCHEDULE },
	taskType: "custom_prompt",
	prompt: "",
	enabled: true,
};

function formatDate(iso?: string): string {
	if (!iso) return "-";
	try {
		return new Date(iso).toLocaleString("zh-CN", {
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		});
	} catch {
		return iso;
	}
}

export function JobsPanel() {
	const { t } = useTranslation();
	const [showForm, setShowForm] = useState(false);
	const [editingJob, setEditingJob] = useState<ScheduledJob | null>(null);
	const [form, setForm] = useState<JobFormState>(defaultForm);
	const [formError, setFormError] = useState<string | null>(null);
	const [isSaving, setIsSaving] = useState(false);
	const state = useStoreSnapshot(jobsStore, () => ({
		jobs: jobsStore.jobs,
		isLoading: jobsStore.isLoading,
		runningJobId: jobsStore.runningJobId,
		lastRunResult: jobsStore.lastRunResult,
	}));

	const humanI18n = useMemo(
		() => ({
			daily: (time: string) => t("jobs.humanCron.daily", { time }),
			weekday: (time: string) => t("jobs.humanCron.weekday", { time }),
			weekly: (days: string, time: string) => t("jobs.humanCron.weekly", { days, time }),
			monthly: (day: string, time: string) => t("jobs.humanCron.monthly", { day, time }),
			monthlyLast: (time: string) => t("jobs.humanCron.monthlyLast", { time }),
			once: (date: string, time: string) => t("jobs.humanCron.once", { date, time }),
			weekdayName: (idx: number) => t(`jobs.weekdays.${idx}`),
		}),
		[t],
	);

	useEffect(() => {
		void jobsStore.load();
	}, []);

	function openNewForm() {
		setEditingJob(null);
		setForm(defaultForm);
		setFormError(null);
		setShowForm(true);
	}

	function openEditForm(job: ScheduledJob) {
		setEditingJob(job);
		setForm({
			name: job.name,
			schedule: cronToSchedule(job.cron),
			taskType: job.taskType,
			prompt: job.prompt,
			enabled: job.enabled,
		});
		setFormError(null);
		setShowForm(true);
	}

	async function saveForm() {
		if (!form.name.trim()) {
			setFormError(t("jobs.errors.nameRequired"));
			return;
		}
		const cron = scheduleToCron(form.schedule).trim();
		if (!cron) {
			setFormError(t("jobs.errors.cronRequired"));
			return;
		}
		const cronFields = cron.split(/\s+/);
		if (cronFields.length !== 5) {
			setFormError(t("jobs.errors.cronInvalid"));
			return;
		}
		if (form.schedule.frequency === "weekly" && form.schedule.weekdays.length === 0) {
			setFormError(t("jobs.errors.weekdayRequired"));
			return;
		}
		if (form.schedule.frequency === "once" && !form.schedule.date) {
			setFormError(t("jobs.errors.dateRequired"));
			return;
		}
		setFormError(null);
		setIsSaving(true);
		try {
			if (editingJob) {
				await jobsStore.update(editingJob.id, {
					name: form.name,
					cron,
					taskType: form.taskType,
					prompt: form.prompt,
					enabled: form.enabled,
				});
			} else {
				const input: CreateJobInput = {
					name: form.name,
					cron,
					timezone: "Asia/Shanghai",
					taskType: form.taskType,
					prompt: form.prompt,
					enabled: form.enabled,
				};
				await jobsStore.create(input);
			}
			setShowForm(false);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			setFormError(t("jobs.errors.saveFailed", { message }));
		} finally {
			setIsSaving(false);
		}
	}

	const previewCron = scheduleToCron(form.schedule);
	const previewLabel = humanizeSchedule(form.schedule, humanI18n);

	return (
		<div className="flex h-full flex-col">
			<div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--inno-surface)]">
				<div className="flex items-center justify-between border-b border-[var(--inno-border)] bg-[var(--inno-surface-muted)] px-3 py-3">
					<div>
						<h3 className="text-sm font-medium text-[var(--inno-text)]">{t("jobs.title")}</h3>
						<p className="text-xs text-[var(--inno-text-muted)]">{t("jobs.subtitle")}</p>
					</div>
					<button className="flex items-center gap-1 rounded-md inno-primary-button px-3 py-1.5 text-sm text-white" onClick={openNewForm}>
						<Plus size={14} />
						{t("jobs.newJob")}
					</button>
				</div>

				<div className="min-h-0 flex-1 overflow-y-auto p-3">
					{state.isLoading ? (
						<div className="flex items-center justify-center py-8 text-[var(--inno-text-muted)]">
							<Spinner size={16} className="mr-2" />
							{t("common.loading")}
						</div>
					) : null}
					{!state.isLoading && state.jobs.length === 0 ? (
						<p className="py-8 text-center text-sm text-[var(--inno-text-muted)]">{t("jobs.empty")}</p>
					) : null}
					<div className="flex flex-col gap-2">
						{state.jobs.map((job) => {
							const isRunning = state.runningJobId === job.id;
							const human = humanizeCron(job.cron, humanI18n);
							return (
								<div key={job.id} className={`rounded-lg bg-[var(--inno-surface)] p-3 ${job.enabled ? "" : "opacity-60"}`}>
									<div className="flex items-start justify-between gap-2">
										<div className="min-w-0 flex-1">
											<div className="truncate text-sm font-medium text-[var(--inno-text)]">{job.name}</div>
											<div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--inno-text-muted)]">
												<span className="rounded bg-[var(--inno-surface-muted)] px-1.5 py-0.5 text-[var(--inno-text)]">{human}</span>
												<span className="rounded bg-[var(--inno-surface-muted)] px-1.5 py-0.5 text-[var(--inno-text-muted)]">
													{t(`jobs.taskTypes.${job.taskType}`)}
												</span>
												<span className={job.enabled ? "text-[var(--inno-success)]" : "text-[var(--inno-danger)]"}>
													{job.enabled ? t("common.enabled") : t("common.disabled")}
												</span>
											</div>
											<div className="mt-1 text-xs text-[var(--inno-text-muted)]">
												{t("jobs.lastRun", { time: job.lastRunAt ? formatDate(job.lastRunAt) : t("jobs.never") })}
												{job.nextRunAt ? ` · ${t("jobs.nextRun", { time: formatDate(job.nextRunAt) })}` : ""}
											</div>
										</div>
									</div>

									<div className="mt-2 flex flex-wrap gap-1.5">
										<button
											className={`flex items-center gap-1 rounded-md inno-primary-button px-2 py-1 text-xs text-white ${isRunning ? "cursor-wait opacity-50" : ""}`}
											disabled={isRunning}
											title={t("jobs.actions.run")}
											onClick={() => void jobsStore.run(job.id)}
										>
											<Play size={12} />
											{isRunning ? t("jobs.actions.running") : t("jobs.actions.run")}
										</button>
										<button
											className="flex items-center gap-1 rounded bg-[var(--inno-surface-muted)] px-2 py-1 text-xs text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]"
											title={t("jobs.actions.edit")}
											onClick={() => openEditForm(job)}
										>
											<Pencil size={12} />
											{t("jobs.actions.edit")}
										</button>
										<button
											className="flex items-center gap-1 rounded bg-[var(--inno-surface-muted)] px-2 py-1 text-xs text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]"
											title={job.enabled ? t("jobs.actions.disable") : t("jobs.actions.enable")}
											onClick={() => void jobsStore.update(job.id, { enabled: !job.enabled })}
										>
											{job.enabled ? <ToggleRight size={12} /> : <ToggleLeft size={12} />}
											{job.enabled ? t("jobs.actions.disable") : t("jobs.actions.enable")}
										</button>
										<button
											className="flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--inno-danger)] hover:bg-[var(--inno-danger-bg)]"
											title={t("jobs.actions.delete")}
											onClick={() => void jobsStore.remove(job.id)}
										>
											<Trash2 size={12} />
											{t("jobs.actions.delete")}
										</button>
									</div>
								</div>
							);
						})}
					</div>
				</div>

				{state.lastRunResult ? (
					<div className="border-t border-[var(--inno-border)] p-3">
						<div className="mb-1 text-xs font-medium text-[var(--inno-text)]">{t("jobs.lastResult")}</div>
						<pre className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded bg-[var(--inno-surface-muted)] p-2 text-xs text-[var(--inno-text)]">{state.lastRunResult}</pre>
					</div>
				) : null}
			</div>

			{showForm ? (
				<motion.div
					className="fixed inset-0 z-50 flex items-center justify-center"
					initial={{ backgroundColor: "rgba(0,0,0,0)" }}
					animate={{ backgroundColor: "rgba(0,0,0,0.45)" }}
					transition={{ duration: 0.2 }}
					onClick={() => setShowForm(false)}
				>
					<motion.div
						className="max-h-[85vh] w-[460px] overflow-y-auto rounded-xl bg-[var(--inno-surface)] p-5 shadow-xl"
						initial={{ opacity: 0, scale: 0.95 }}
						animate={{ opacity: 1, scale: 1 }}
						transition={{ duration: 0.2, ease: "easeOut" }}
						onClick={(event) => event.stopPropagation()}
					>
						<h3 className="mb-4 text-base font-medium text-[var(--inno-text)]">
							{editingJob ? t("jobs.form.editTitle") : t("jobs.form.newTitle")}
						</h3>
						<div className="flex flex-col gap-3">
							<label className="block text-sm">
								<span className="mb-1 block font-medium text-[var(--inno-text)]">{t("jobs.form.name")}</span>
								<input
									className="w-full rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] px-3 py-2 text-sm focus-visible:border-[var(--inno-focus-border)] focus-visible:outline-none focus-visible:shadow-[var(--inno-ring)]"
									placeholder={t("jobs.form.namePlaceholder") ?? ""}
									value={form.name}
									onChange={(event) => setForm({ ...form, name: event.target.value })}
								/>
							</label>

							<div className="block text-sm">
								<span className="mb-1 block font-medium text-[var(--inno-text)]">{t("jobs.form.schedule")}</span>
								<ScheduleEditor
									value={form.schedule}
									onChange={(schedule) => setForm({ ...form, schedule })}
								/>
								<div className="mt-1 text-xs text-[var(--inno-text-muted)]">
									<span className="font-mono">{previewCron || "-"}</span>
									{previewLabel ? <span className="ml-2">· {previewLabel}</span> : null}
								</div>
							</div>

							<label className="block text-sm">
								<span className="mb-1 block font-medium text-[var(--inno-text)]">{t("jobs.form.taskType")}</span>
								<select
									className="w-full rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] px-3 py-2 text-sm focus-visible:border-[var(--inno-focus-border)] focus-visible:outline-none focus-visible:shadow-[var(--inno-ring)]"
									value={form.taskType}
									onChange={(event) => setForm({ ...form, taskType: event.target.value as TaskType })}
								>
									{TASK_TYPE_IDS.map((id) => (
										<option key={id} value={id}>
											{t(`jobs.taskTypes.${id}`)}
										</option>
									))}
								</select>
							</label>

							<label className="block text-sm">
								<span className="mb-1 block font-medium text-[var(--inno-text)]">{t("jobs.form.prompt")}</span>
								<textarea
									className="h-24 w-full resize-none rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] px-3 py-2 text-sm focus-visible:border-[var(--inno-focus-border)] focus-visible:outline-none focus-visible:shadow-[var(--inno-ring)]"
									placeholder={t("jobs.form.promptPlaceholder") ?? ""}
									value={form.prompt}
									onChange={(event) => setForm({ ...form, prompt: event.target.value })}
								/>
							</label>

							<label className="flex items-center gap-2 text-sm text-[var(--inno-text)]">
								<input
									type="checkbox"
									className={checkboxCls}
									checked={form.enabled}
									onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
								/>
								{t("jobs.form.enabled")}
							</label>
						</div>
						<div className="mt-4 flex justify-end gap-2">
							{formError ? <div className="mr-auto text-xs text-[var(--inno-danger)]">{formError}</div> : null}
							<button
								className="rounded-md bg-[var(--inno-surface-muted)] px-3 py-1.5 text-sm text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)] disabled:opacity-50"
								disabled={isSaving}
								onClick={() => setShowForm(false)}
							>
								{t("common.cancel")}
							</button>
							<button
								className="rounded-md inno-primary-button px-3 py-1.5 text-sm text-white disabled:opacity-50"
								disabled={isSaving}
								onClick={() => void saveForm()}
							>
								{isSaving ? t("common.saving") : t("common.save")}
							</button>
						</div>
					</motion.div>
				</motion.div>
			) : null}
		</div>
	);
}
