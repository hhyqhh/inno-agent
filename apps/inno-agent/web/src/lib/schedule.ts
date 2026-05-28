// Structured schedule <-> cron conversion.
//
// Cron uses 5 fields: minute hour day-of-month month day-of-week.
// We only generate a small, well-behaved subset (no ranges, no step values),
// so that parsing back is reliable. Anything we can't parse back becomes
// frequency: "custom" with the raw cron string.

export type Frequency = "daily" | "weekday" | "weekly" | "monthly" | "once" | "custom";

export interface ScheduleSpec {
	frequency: Frequency;
	hour: number;        // 0..23
	minute: number;      // 0..59
	weekdays: number[];  // 0..6 (Sun..Sat) — for weekly
	day: number;         // 1..31 or -1 ("last day") — for monthly
	date: string;        // yyyy-mm-dd — for once
	cron: string;        // raw fallback for "custom"
}

export const DEFAULT_SCHEDULE: ScheduleSpec = {
	frequency: "daily",
	hour: 9,
	minute: 0,
	weekdays: [1],
	day: 1,
	date: "",
	cron: "0 9 * * *",
};

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

export function scheduleToCron(spec: ScheduleSpec): string {
	const minute = clampInt(spec.minute, 0, 59);
	const hour = clampInt(spec.hour, 0, 23);
	switch (spec.frequency) {
		case "custom":
			return (spec.cron ?? "").trim();
		case "daily":
			return `${minute} ${hour} * * *`;
		case "weekday":
			return `${minute} ${hour} * * 1-5`;
		case "weekly": {
			const days = (spec.weekdays.length ? spec.weekdays : [1])
				.map((d) => clampInt(d, 0, 6))
				.sort((a, b) => a - b)
				.join(",");
			return `${minute} ${hour} * * ${days}`;
		}
		case "monthly": {
			if (spec.day === -1) return `${minute} ${hour} L * *`;
			const dom = clampInt(spec.day, 1, 31);
			return `${minute} ${hour} ${dom} * *`;
		}
		case "once": {
			if (!spec.date) return `${minute} ${hour} * * *`;
			const [y, m, d] = spec.date.split("-").map((v) => Number(v));
			if (!y || !m || !d) return `${minute} ${hour} * * *`;
			return `${minute} ${hour} ${d} ${m} *`;
		}
	}
}

export function cronToSchedule(cron: string): ScheduleSpec {
	const raw = (cron ?? "").trim();
	const fields = raw.split(/\s+/);
	if (fields.length !== 5) return { ...DEFAULT_SCHEDULE, frequency: "custom", cron: raw };

	const [minStr, hourStr, domStr, monStr, dowStr] = fields;
	const minute = parseLiteral(minStr);
	const hour = parseLiteral(hourStr);

	if (minute === null || hour === null) {
		return { ...DEFAULT_SCHEDULE, frequency: "custom", cron: raw };
	}

	// daily
	if (domStr === "*" && monStr === "*" && dowStr === "*") {
		return { ...DEFAULT_SCHEDULE, frequency: "daily", hour, minute };
	}
	// weekday Mon-Fri
	if (domStr === "*" && monStr === "*" && dowStr === "1-5") {
		return { ...DEFAULT_SCHEDULE, frequency: "weekday", hour, minute };
	}
	// weekly (specific weekdays)
	if (domStr === "*" && monStr === "*" && dowStr !== "*") {
		const days = parseList(dowStr, 0, 6);
		if (days) return { ...DEFAULT_SCHEDULE, frequency: "weekly", hour, minute, weekdays: days };
	}
	// monthly last day
	if (monStr === "*" && dowStr === "*" && (domStr === "L" || domStr === "l")) {
		return { ...DEFAULT_SCHEDULE, frequency: "monthly", hour, minute, day: -1 };
	}
	// monthly on specific day
	if (monStr === "*" && dowStr === "*" && domStr !== "*") {
		const day = parseLiteral(domStr);
		if (day !== null && day >= 1 && day <= 31) {
			return { ...DEFAULT_SCHEDULE, frequency: "monthly", hour, minute, day };
		}
	}
	// once (literal day + month)
	if (dowStr === "*" && domStr !== "*" && monStr !== "*") {
		const day = parseLiteral(domStr);
		const month = parseLiteral(monStr);
		if (day !== null && month !== null) {
			const year = new Date().getFullYear();
			const date = `${year}-${pad2(month)}-${pad2(day)}`;
			return { ...DEFAULT_SCHEDULE, frequency: "once", hour, minute, date };
		}
	}
	return { ...DEFAULT_SCHEDULE, frequency: "custom", cron: raw };
}

export interface HumanizeI18n {
	daily: (time: string) => string;
	weekday: (time: string) => string;
	weekly: (days: string, time: string) => string;
	monthly: (day: string, time: string) => string;
	monthlyLast: (time: string) => string;
	once: (date: string, time: string) => string;
	weekdayName: (idx: number) => string;
}

export function humanizeSchedule(spec: ScheduleSpec, i18n: HumanizeI18n): string {
	const time = `${pad2(spec.hour)}:${pad2(spec.minute)}`;
	switch (spec.frequency) {
		case "daily":
			return i18n.daily(time);
		case "weekday":
			return i18n.weekday(time);
		case "weekly": {
			const days = (spec.weekdays.length ? spec.weekdays : [1])
				.map((d) => i18n.weekdayName(d))
				.join("、");
			return i18n.weekly(days, time);
		}
		case "monthly":
			return spec.day === -1 ? i18n.monthlyLast(time) : i18n.monthly(String(spec.day), time);
		case "once":
			return i18n.once(spec.date || "", time);
		case "custom":
			return spec.cron;
	}
}

export function humanizeCron(cron: string, i18n: HumanizeI18n): string {
	return humanizeSchedule(cronToSchedule(cron), i18n);
}

function parseLiteral(value: string): number | null {
	if (!/^\d+$/.test(value)) return null;
	return Number(value);
}

function parseList(value: string, min: number, max: number): number[] | null {
	const parts = value.split(",");
	const out: number[] = [];
	for (const part of parts) {
		const n = parseLiteral(part);
		if (n === null || n < min || n > max) return null;
		out.push(n);
	}
	return out.sort((a, b) => a - b);
}

function clampInt(n: number, min: number, max: number): number {
	const v = Math.trunc(Number(n));
	if (!Number.isFinite(v)) return min;
	if (v < min) return min;
	if (v > max) return max;
	return v;
}
