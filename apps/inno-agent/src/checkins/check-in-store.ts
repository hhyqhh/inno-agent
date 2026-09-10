import { join } from "node:path";
import { readJson, writeJson, ensureDir } from "../storage/file-store.js";
import type { JobStore } from "../scheduler/job-store.js";
import type { JobRunStatus, ScheduledJob } from "../scheduler/types.js";
import {
	dateKeyForTimeZone,
	DEFAULT_SCHEDULER_TIMEZONE,
	getCronOccurrencesForDate,
} from "../scheduler/cron-utils.js";

const CHECKINS_FILE = "checkins.json";
const OCCURRENCES_FILE = "occurrences.json";
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const LEARNING_TASK_EXCLUSIONS = new Set(["check_in_reminder", "push_reminder"]);

export type CheckInDayStatus = "no_tasks" | "pending" | "completed";
export type CheckInOccurrenceStatus = "pending" | "success" | "error" | "skipped";

export interface CheckInRecord {
	date: string;
	checkedInAt: string;
	completedOccurrenceIds: string[];
}

export interface CheckInOccurrence {
	occurrenceId: string;
	jobId: string;
	jobName: string;
	taskType: ScheduledJob["taskType"];
	scheduledAt: string;
	status: CheckInOccurrenceStatus;
	error?: string;
}

export interface CheckInJobStatus {
	jobId: string;
	jobName: string;
	taskType: ScheduledJob["taskType"];
	occurrences: CheckInOccurrence[];
}

export interface TodayLearningPlan {
	today: string;
	timezone: string;
	jobs: CheckInJobStatus[];
}

export interface CheckInStatus {
	today: string;
	timezone: string;
	dayStatus: CheckInDayStatus;
	todayCheckedIn: boolean;
	checkedInAt?: string;
	requiredCount: number;
	completedCount: number;
	remainingCount: number;
	failedCount: number;
	skippedCount: number;
	currentStreak: number;
	longestStreak: number;
	totalCount: number;
	jobs: CheckInJobStatus[];
}

export interface CheckInOccurrenceResult {
	status: CheckInStatus;
	justCompleted: boolean;
}

export interface RecordCheckInOccurrenceInput {
	occurrenceId: string;
	jobId: string;
	scheduledAt: string;
	status: Extract<JobRunStatus, "success" | "error" | "skipped">;
	runId: string;
	finishedAt: string;
	error?: string;
}

interface OccurrenceRecord extends RecordCheckInOccurrenceInput {
	date: string;
	updatedAt: string;
}

/** Stable identity for one job's planned execution slot. */
export function occurrenceIdFor(jobId: string, scheduledAt: string): string {
	return `${jobId}:${scheduledAt}`;
}

/** Whether a scheduled job represents learning work rather than a reminder. */
export function isLearningJob(job: ScheduledJob): boolean {
	return !LEARNING_TASK_EXCLUSIONS.has(job.taskType);
}

/**
 * File-backed daily progress for the scheduler-driven learning check-in.
 * The check-in record is derived from today's live job configuration and the
 * occurrence ledger; a client cannot mark a day complete on its own.
 */
export class CheckInStore {
	private readonly filePath: string;
	private readonly occurrencesFilePath: string;
	readonly timezone: string;

	constructor(
		dataDir: string,
		timezone: string = DEFAULT_SCHEDULER_TIMEZONE,
		private readonly jobStore: JobStore,
	) {
		const checkinsDir = join(dataDir, "checkins");
		ensureDir(checkinsDir);
		this.filePath = join(checkinsDir, CHECKINS_FILE);
		this.occurrencesFilePath = join(checkinsDir, OCCURRENCES_FILE);
		this.timezone = timezone || DEFAULT_SCHEDULER_TIMEZONE;
	}

	list(): CheckInRecord[] {
		const records = readJson<unknown>(this.filePath, []);
		if (!Array.isArray(records)) return [];
		return records
			.map(parseCheckInRecord)
			.filter((record): record is CheckInRecord => record !== undefined);
	}

	getTodayPlan(now: Date = new Date()): TodayLearningPlan {
		const today = dateKeyForTimeZone(now, this.timezone);
		const occurrenceRecords = new Map(this.listOccurrenceRecords().map((record) => [record.occurrenceId, record]));
		const jobs = this.jobStore.list()
			.filter((job) => job.enabled && isLearningJob(job))
			.map((job): CheckInJobStatus | null => {
				const scheduledAt = getCronOccurrencesForDate(job.cron, job.timezone, today, this.timezone);
				if (scheduledAt.length === 0) return null;
				return {
					jobId: job.id,
					jobName: job.name,
					taskType: job.taskType,
					occurrences: scheduledAt.map((at) => {
						const occurrenceId = occurrenceIdFor(job.id, at);
						const record = occurrenceRecords.get(occurrenceId);
						return {
							occurrenceId,
							jobId: job.id,
							jobName: job.name,
							taskType: job.taskType,
							scheduledAt: at,
							status: record?.status ?? "pending",
							error: record?.error,
						};
					}),
				};
			})
			.filter((job): job is CheckInJobStatus => job !== null);

		return { today, timezone: this.timezone, jobs };
	}

	status(now: Date = new Date()): CheckInStatus {
		const plan = this.getTodayPlan(now);
		const occurrences = plan.jobs.flatMap((job) => job.occurrences);
		const completedCount = occurrences.filter((occurrence) => occurrence.status === "success").length;
		const skippedCount = occurrences.filter((occurrence) => occurrence.status === "skipped").length;
		const failedCount = occurrences.filter((occurrence) => occurrence.status === "error").length;
		const remainingCount = occurrences.length - completedCount - skippedCount;
		const dayStatus: CheckInDayStatus = occurrences.length === 0
			? "no_tasks"
			: remainingCount === 0
				? "completed"
				: "pending";

		let records = this.list();
		let todayRecord = records.find((record) => record.date === plan.today);
		if (dayStatus === "completed") {
			const completedOccurrenceIds = occurrences
				.filter((occurrence) => occurrence.status === "success")
				.map((occurrence) => occurrence.occurrenceId)
				.sort();
			const sameCompletionSet = todayRecord
				? areSameStrings(todayRecord.completedOccurrenceIds, completedOccurrenceIds)
				: false;
			if (!todayRecord || !sameCompletionSet) {
				todayRecord = {
					date: plan.today,
					checkedInAt: sameCompletionSet ? todayRecord!.checkedInAt : now.toISOString(),
					completedOccurrenceIds,
				};
				records = [...records.filter((record) => record.date !== plan.today), todayRecord];
				writeJson(this.filePath, records);
			}
		}

		const validDates = records
			.filter((record) => record.date <= plan.today)
			.filter((record) => record.date !== plan.today || dayStatus === "completed")
			.map((record) => record.date)
			.sort()
			.reverse();

		return {
			today: plan.today,
			timezone: plan.timezone,
			dayStatus,
			todayCheckedIn: dayStatus === "completed",
			checkedInAt: dayStatus === "completed" ? todayRecord?.checkedInAt : undefined,
			requiredCount: occurrences.length - skippedCount,
			completedCount,
			remainingCount,
			failedCount,
			skippedCount,
			currentStreak: calculateCurrentStreak(validDates, plan.today),
			longestStreak: calculateLongestStreak(validDates),
			totalCount: validDates.length,
			jobs: plan.jobs,
		};
	}

	isCheckedInToday(now: Date = new Date()): boolean {
		return this.status(now).todayCheckedIn;
	}

	private claimedOccurrences = new Set<string>();

	/**
	 * Reserve a slot for execution so cron re-fires, the deferred
	 * auto-execution and manual starts cannot double-run the same slot.
	 * The claim is held while the run is in flight (and after it succeeded —
	 * a fulfilled slot never re-runs); a failed attempt releases it so the
	 * user can retry from the check-in card.
	 */
	claimOccurrence(occurrenceId: string): boolean {
		if (this.claimedOccurrences.has(occurrenceId)) return false;
		this.claimedOccurrences.add(occurrenceId);
		return true;
	}

	releaseOccurrenceClaim(occurrenceId: string): void {
		this.claimedOccurrences.delete(occurrenceId);
	}

	isOccurrenceClaimed(occurrenceId: string): boolean {
		return this.claimedOccurrences.has(occurrenceId);
	}

	/**
	 * Find a user-selected occurrence, or the first pending/failed occurrence
	 * for the legacy generic "Run now" action. Skipped and successful slots are
	 * never selected again.
	 */
	resolveOccurrence(jobId: string, occurrenceId?: string, now: Date = new Date()): CheckInOccurrence | undefined {
		const candidates = this.getTodayPlan(now).jobs
			.find((job) => job.jobId === jobId)
			?.occurrences ?? [];
		if (occurrenceId) {
			const selected = candidates.find((occurrence) => occurrence.occurrenceId === occurrenceId);
			return selected && selected.status !== "success" && selected.status !== "skipped" ? selected : undefined;
		}
		return candidates.find((occurrence) => occurrence.status === "pending" || occurrence.status === "error");
	}

	/** Find any live occurrence, including one that was already completed. */
	getOccurrence(jobId: string, occurrenceId: string, now: Date = new Date()): CheckInOccurrence | undefined {
		return this.getTodayPlan(now).jobs
			.find((job) => job.jobId === jobId)
			?.occurrences.find((occurrence) => occurrence.occurrenceId === occurrenceId);
	}

	/**
	 * Persist the result for one planned slot and reconcile today's check-in.
	 * A successful attempt is sticky: a later failed retry cannot undo a slot
	 * that already succeeded.
	 */
	recordOccurrence(input: RecordCheckInOccurrenceInput): CheckInOccurrenceResult {
		const finishedAt = new Date(input.finishedAt);
		const before = this.status(finishedAt);
		const records = this.listOccurrenceRecords();
		const index = records.findIndex((record) => record.occurrenceId === input.occurrenceId);
		const current = index >= 0 ? records[index] : undefined;
		const status = current?.status === "success" || input.status === "success"
			? "success"
			: input.status;
		const next: OccurrenceRecord = {
			...input,
			status,
			date: dateKeyForTimeZone(new Date(input.scheduledAt), this.timezone),
			updatedAt: finishedAt.toISOString(),
		};
		if (index >= 0) records[index] = next;
		else records.push(next);
		writeJson(this.occurrencesFilePath, records);

		const after = this.status(finishedAt);
		return {
			status: after,
			justCompleted: !before.todayCheckedIn && after.todayCheckedIn,
		};
	}

	private listOccurrenceRecords(): OccurrenceRecord[] {
		const records = readJson<unknown>(this.occurrencesFilePath, []);
		if (!Array.isArray(records)) return [];
		return records.filter(isOccurrenceRecord);
	}
}

function parseCheckInRecord(value: unknown): CheckInRecord | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Partial<CheckInRecord>;
	if (typeof record.date !== "string" || !DATE_KEY_RE.test(record.date)
		|| typeof record.checkedInAt !== "string") return undefined;
	return {
		date: record.date,
		checkedInAt: record.checkedInAt,
		// Records written before task-driven check-ins have no occurrence IDs.
		// They remain useful for historical streaks but cannot satisfy today's plan.
		completedOccurrenceIds: Array.isArray(record.completedOccurrenceIds)
			? record.completedOccurrenceIds.filter((id): id is string => typeof id === "string")
			: [],
	};
}

function isOccurrenceRecord(value: unknown): value is OccurrenceRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<OccurrenceRecord>;
	return typeof record.occurrenceId === "string"
		&& typeof record.jobId === "string"
		&& typeof record.scheduledAt === "string"
		&& (record.status === "success" || record.status === "error" || record.status === "skipped")
		&& typeof record.runId === "string"
		&& typeof record.finishedAt === "string"
		&& typeof record.date === "string"
		&& DATE_KEY_RE.test(record.date)
		&& typeof record.updatedAt === "string";
}

function areSameStrings(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	const left = [...a].sort();
	const right = [...b].sort();
	return left.every((value, index) => value === right[index]);
}

function previousDateKey(date: string): string {
	const [year, month, day] = date.split("-").map(Number);
	const previous = new Date(Date.UTC(year, month - 1, day - 1));
	return [previous.getUTCFullYear(), previous.getUTCMonth() + 1, previous.getUTCDate()]
		.map((part) => String(part).padStart(2, "0"))
		.join("-");
}

function calculateCurrentStreak(dates: string[], today: string): number {
	if (dates.length === 0) return 0;
	const start = dates[0] === today || dates[0] === previousDateKey(today) ? dates[0] : "";
	if (!start) return 0;

	let streak = 1;
	let expectedPrevious = previousDateKey(start);
	for (const date of dates.slice(1)) {
		if (date !== expectedPrevious) break;
		streak++;
		expectedPrevious = previousDateKey(date);
	}
	return streak;
}

function calculateLongestStreak(datesDescending: string[]): number {
	if (datesDescending.length === 0) return 0;
	const dates = [...datesDescending].reverse();
	let longest = 1;
	let current = 1;
	for (let i = 1; i < dates.length; i++) {
		if (dates[i - 1] === previousDateKey(dates[i])) {
			current++;
			longest = Math.max(longest, current);
		} else {
			current = 1;
		}
	}
	return longest;
}
