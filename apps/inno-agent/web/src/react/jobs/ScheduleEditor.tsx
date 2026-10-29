import { useTranslation } from "react-i18next";
import type { ScheduleSpec, Frequency } from "../../lib/schedule.js";
import { Button, Input, Select, SelectContent, SelectOption, SelectTrigger, SelectValue } from "../ui/index.js";

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
					<Select
						value={value.frequency}
						onValueChange={(frequency) => patch({ frequency: frequency as Frequency })}
					>
						<SelectTrigger className="w-full min-h-10 text-sm"><SelectValue /></SelectTrigger>
						<SelectContent>
						{FREQUENCIES.map((f) => (
							<SelectOption key={f} value={f} label={t(`jobs.frequency.${f}`)} />
						))}
						</SelectContent>
					</Select>
				</label>
				{value.frequency !== "custom" ? (
					<label className="block text-sm">
						<span className="mb-1 block font-medium text-[var(--inno-text)]">{t("jobs.form.time")}</span>
						<Input
							type="time"
							className="rounded-md px-3 py-2 text-sm"
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
							<Button
								key={d}
								variant={active ? "primary" : "secondary"}
								size="xs"
								shape="pill"
								aria-pressed={active}
								onClick={() => {
										const next = active
											? value.weekdays.filter((x) => x !== d)
											: [...value.weekdays, d];
										patch({ weekdays: next.sort((a, b) => a - b) });
								}}
							>
								{t(`jobs.weekdays.${d}`)}
							</Button>
							);
						})}
					</div>
				</div>
			) : null}

			{value.frequency === "monthly" ? (
				<label className="block text-sm">
					<span className="mb-1 block font-medium text-[var(--inno-text)]">{t("jobs.form.dayOfMonth")}</span>
					<Select
						value={String(value.day)}
						onValueChange={(day) => patch({ day: Number(day) })}
					>
						<SelectTrigger className="w-full min-h-10 text-sm"><SelectValue /></SelectTrigger>
						<SelectContent>
						{Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
							<SelectOption key={d} value={String(d)} label={d} />
						))}
						<SelectOption value="-1" label={t("jobs.form.lastDay")} />
						</SelectContent>
					</Select>
				</label>
			) : null}

			{value.frequency === "once" ? (
				<label className="block text-sm">
					<span className="mb-1 block font-medium text-[var(--inno-text)]">{t("jobs.form.onceDate")}</span>
					<Input
						type="date"
						className="rounded-md px-3 py-2 text-sm"
						value={value.date}
						onChange={(e) => patch({ date: e.target.value })}
					/>
				</label>
			) : null}

			{value.frequency === "custom" ? (
				<label className="block text-sm">
					<span className="mb-1 block font-medium text-[var(--inno-text)]">{t("jobs.form.customCron")}</span>
					<Input
						className="rounded-md px-3 py-2 font-mono text-sm"
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
