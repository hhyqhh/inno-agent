import { useTranslation } from "react-i18next";
import type { ScheduleSpec, Frequency } from "../../lib/schedule.js";

interface ScheduleEditorProps {
	value: ScheduleSpec;
	onChange(next: ScheduleSpec): void;
	error?: string | null;
}

const FREQUENCIES: Frequency[] = ["daily", "weekday", "weekly", "monthly", "once", "custom"];
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

function pad2(n: number) {
	return String(n).padStart(2, "0");
}

export function ScheduleEditor({ value, onChange, error }: ScheduleEditorProps) {
	const { t } = useTranslation();

	function patch(p: Partial<ScheduleSpec>) {
		onChange({ ...value, ...p });
	}

	const timeStr = `${pad2(value.hour)}:${pad2(value.minute)}`;

	return (
		<div className="flex flex-col gap-3 rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] p-3">
			<div className="grid grid-cols-2 gap-2">
				<label className="block text-sm">
					<span className="mb-1 block font-medium text-[var(--inno-text)]">{t("jobs.form.frequency")}</span>
					<select
						className="w-full rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] px-3 py-2 text-sm focus-visible:border-[var(--inno-focus-border)] focus-visible:outline-none focus-visible:shadow-[var(--inno-ring)]"
						value={value.frequency}
						onChange={(e) => patch({ frequency: e.target.value as Frequency })}
					>
						{FREQUENCIES.map((f) => (
							<option key={f} value={f}>
								{t(`jobs.frequency.${f}`)}
							</option>
						))}
					</select>
				</label>
				{value.frequency !== "custom" ? (
					<label className="block text-sm">
						<span className="mb-1 block font-medium text-[var(--inno-text)]">{t("jobs.form.time")}</span>
						<input
							type="time"
							className="w-full rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] px-3 py-2 text-sm focus-visible:border-[var(--inno-focus-border)] focus-visible:outline-none focus-visible:shadow-[var(--inno-ring)]"
							value={timeStr}
							onChange={(e) => {
								const [h, m] = e.target.value.split(":").map(Number);
								patch({ hour: Number.isFinite(h) ? h : 0, minute: Number.isFinite(m) ? m : 0 });
							}}
						/>
					</label>
				) : null}
			</div>

			{value.frequency === "weekly" ? (
				<div className="text-sm">
					<span className="mb-1 block font-medium text-[var(--inno-text)]">{t("jobs.form.weekdays")}</span>
					<div className="flex flex-wrap gap-1.5">
						{WEEKDAYS.map((d) => {
							const active = value.weekdays.includes(d);
							return (
								<button
									type="button"
									key={d}
									className={`rounded-full px-3 py-1 text-xs transition-colors ${ active ? "inno-primary-button" : "bg-[var(--inno-surface)] text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)]" }`}
									onClick={() => {
										const next = active
											? value.weekdays.filter((x) => x !== d)
											: [...value.weekdays, d];
										patch({ weekdays: next.sort((a, b) => a - b) });
									}}
								>
									{t(`jobs.weekdays.${d}`)}
								</button>
							);
						})}
					</div>
				</div>
			) : null}

			{value.frequency === "monthly" ? (
				<label className="block text-sm">
					<span className="mb-1 block font-medium text-[var(--inno-text)]">{t("jobs.form.dayOfMonth")}</span>
					<select
						className="w-full rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] px-3 py-2 text-sm focus-visible:border-[var(--inno-focus-border)] focus-visible:outline-none focus-visible:shadow-[var(--inno-ring)]"
						value={String(value.day)}
						onChange={(e) => patch({ day: Number(e.target.value) })}
					>
						{Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
							<option key={d} value={d}>
								{d}
							</option>
						))}
						<option value={-1}>{t("jobs.form.lastDay")}</option>
					</select>
				</label>
			) : null}

			{value.frequency === "once" ? (
				<label className="block text-sm">
					<span className="mb-1 block font-medium text-[var(--inno-text)]">{t("jobs.form.onceDate")}</span>
					<input
						type="date"
						className="w-full rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] px-3 py-2 text-sm focus-visible:border-[var(--inno-focus-border)] focus-visible:outline-none focus-visible:shadow-[var(--inno-ring)]"
						value={value.date}
						onChange={(e) => patch({ date: e.target.value })}
					/>
				</label>
			) : null}

			{value.frequency === "custom" ? (
				<label className="block text-sm">
					<span className="mb-1 block font-medium text-[var(--inno-text)]">{t("jobs.form.customCron")}</span>
					<input
						className="w-full rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] px-3 py-2 font-mono text-sm focus-visible:border-[var(--inno-focus-border)] focus-visible:outline-none focus-visible:shadow-[var(--inno-ring)]"
						placeholder={t("jobs.form.cronPlaceholder") ?? ""}
						value={value.cron}
						onChange={(e) => patch({ cron: e.target.value })}
					/>
					<span className="mt-1 block text-xs text-[var(--inno-text-muted)]">{t("jobs.form.cronHint")}</span>
				</label>
			) : null}

			{error ? <div className="text-xs text-[var(--inno-danger)]">{error}</div> : null}
		</div>
	);
}
