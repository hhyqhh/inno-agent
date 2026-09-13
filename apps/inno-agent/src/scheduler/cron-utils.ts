import { logger } from "../logger.js";
import { CronExpressionParser } from "cron-parser";

/**
 * Default timezone for scheduled jobs when neither the job nor the global
 * `scheduler.timezone` config specifies one.
 */
export const DEFAULT_SCHEDULER_TIMEZONE = "Asia/Shanghai";

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_OCCURRENCES_PER_DAY = 10_000;

export function computeNextRunAt(
	cron: string,
	timezone: string,
	currentDate: Date = new Date(),
): string | undefined {
	try {
		const expr = CronExpressionParser.parse(cron, {
			currentDate,
			tz: timezone || DEFAULT_SCHEDULER_TIMEZONE,
		});
		return expr.next().toDate().toISOString();
	} catch (err) {
		logger.warn({ err, cron }, "failed to compute next run time");
		return undefined;
	}
}

export function isCronDue(
	cron: string,
	timezone: string,
	lastRunAt: string | undefined,
	now: Date = new Date(),
): boolean {
	return getCronDueAt(cron, timezone, lastRunAt, now) !== undefined;
}

/**
 * Return the most recent cron occurrence that the scheduler should execute.
 * The scheduler intentionally keeps its existing two-minute catch-up behavior
 * for jobs that have never run, while exposing the exact occurrence so daily
 * check-in progress can be tied to a plan slot instead of a wall-clock run.
 */
export function getCronDueAt(
	cron: string,
	timezone: string,
	lastRunAt: string | undefined,
	now: Date = new Date(),
): string | undefined {
	try {
		const expr = CronExpressionParser.parse(cron, {
			currentDate: now,
			tz: timezone || DEFAULT_SCHEDULER_TIMEZONE,
		});
		const prev = expr.prev().toDate();

		if (!lastRunAt) {
			const diffMs = now.getTime() - prev.getTime();
			return diffMs >= 0 && diffMs < 120_000 ? prev.toISOString() : undefined;
		}

		return prev.getTime() > new Date(lastRunAt).getTime() ? prev.toISOString() : undefined;
	} catch (err) {
		logger.warn({ err, cron }, "failed to check if cron is due");
		return undefined;
	}
}

/**
 * Enumerate every occurrence of a cron expression whose instant falls inside
 * one calendar day in `dayTimezone`. The expression itself is evaluated in
 * the job timezone, matching the scheduler, while the check-in day boundary
 * remains the global scheduler timezone.
 */
export function getCronOccurrencesForDate(
	cron: string,
	timezone: string,
	dateKey: string,
	dayTimezone: string = timezone || DEFAULT_SCHEDULER_TIMEZONE,
): string[] {
	if (!DATE_KEY_RE.test(dateKey)) return [];
	try {
		const start = zonedDateKeyToUtc(dateKey, dayTimezone);
		const end = zonedDateKeyToUtc(nextDateKey(dateKey), dayTimezone);
		const expr = CronExpressionParser.parse(cron, {
			currentDate: new Date(start.getTime() - 1),
			tz: timezone || DEFAULT_SCHEDULER_TIMEZONE,
		});
		const occurrences: string[] = [];
		for (let i = 0; i < MAX_OCCURRENCES_PER_DAY; i++) {
			const next = expr.next().toDate();
			if (next.getTime() >= end.getTime()) break;
			if (next.getTime() >= start.getTime()) occurrences.push(next.toISOString());
		}
		return occurrences;
	} catch (err) {
		logger.warn({ err, cron, timezone, dateKey, dayTimezone }, "failed to enumerate cron occurrences");
		return [];
	}
}

/** Calendar date in an IANA timezone, represented as YYYY-MM-DD. */
export function dateKeyForTimeZone(date: Date, timezone: string): string {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: timezone || DEFAULT_SCHEDULER_TIMEZONE,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(date);
	const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
	return `${values.year}-${values.month}-${values.day}`;
}

/** Return the next Gregorian calendar date for a validated date key. */
function nextDateKey(dateKey: string): string {
	const [year, month, day] = dateKey.split("-").map(Number);
	const next = new Date(Date.UTC(year, month - 1, day + 1));
	return [next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()]
		.map((part) => String(part).padStart(2, "0"))
		.join("-");
}

/** Convert a local midnight date key to its corresponding UTC instant. */
function zonedDateKeyToUtc(dateKey: string, timezone: string): Date {
	const [year, month, day] = dateKey.split("-").map(Number);
	const guess = new Date(Date.UTC(year, month - 1, day));
	let result = guess;
	// Re-evaluate twice so DST transitions converge to the correct offset.
	for (let i = 0; i < 2; i++) {
		const parts = new Intl.DateTimeFormat("en-US", {
			timeZone: timezone || DEFAULT_SCHEDULER_TIMEZONE,
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		}).formatToParts(result);
		const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
		const localAsUtc = Date.UTC(
			Number(values.year),
			Number(values.month) - 1,
			Number(values.day),
			Number(values.hour),
			Number(values.minute),
			Number(values.second),
		);
		result = new Date(guess.getTime() - (localAsUtc - result.getTime()));
	}
	return result;
}

/**
 * Validate a cron expression. Returns { ok: true } if parseable,
 * otherwise { ok: false, error: string }.
 */
export function validateCron(cron: string, timezone = DEFAULT_SCHEDULER_TIMEZONE): { ok: true } | { ok: false; error: string } {
	const value = (cron ?? "").trim();
	if (!value) return { ok: false, error: "Cron expression is required" };
	const fields = value.split(/\s+/);
	if (fields.length !== 5) {
		return { ok: false, error: `Cron must have 5 fields (minute hour day month weekday), got ${fields.length}` };
	}
	try {
		CronExpressionParser.parse(value, { tz: timezone || DEFAULT_SCHEDULER_TIMEZONE });
		return { ok: true };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Detect a cron that can only fire once (minute, hour, day-of-month, month
 * all pinned to a single literal value). After firing, such a job's next run
 * would be a year later, which is almost never what the user intended for
 * one-shot reminders like "tomorrow at 14:30".
 */
export function isOneShotCron(cron: string): boolean {
	const fields = (cron ?? "").trim().split(/\s+/);
	if (fields.length !== 5) return false;
	const [m, h, dom, mon] = fields;
	const literal = /^\d+$/;
	return literal.test(m) && literal.test(h) && literal.test(dom) && literal.test(mon);
}
