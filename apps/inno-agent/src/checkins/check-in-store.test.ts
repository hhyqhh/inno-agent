import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CheckInStore, occurrenceIdFor } from "./check-in-store.js";
import { dateKeyForTimeZone } from "../scheduler/cron-utils.js";
import { JobStore } from "../scheduler/job-store.js";
import { writeJson } from "../storage/file-store.js";

let dir: string;
let jobStore: JobStore;
let checkInStore: CheckInStore;

const TODAY = new Date("2026-09-10T02:00:00.000Z"); // 10:00 Asia/Shanghai

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "inno-checkins-"));
	jobStore = new JobStore(join(dir, "jobs"), "Asia/Shanghai");
	checkInStore = new CheckInStore(join(dir, "data"), "Asia/Shanghai", jobStore);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function createJob(overrides: Partial<Parameters<JobStore["create"]>[0]> = {}) {
	return jobStore.create({
		name: "daily review",
		cron: "0 9 * * *",
		timezone: "Asia/Shanghai",
		enabled: true,
		taskType: "daily_review",
		prompt: "review my notes",
		...overrides,
	});
}

function completeOccurrence(occurrence: { occurrenceId: string; jobId: string; scheduledAt: string }, runId = "run-success") {
	return checkInStore.recordOccurrence({
		occurrenceId: occurrence.occurrenceId,
		jobId: occurrence.jobId,
		scheduledAt: occurrence.scheduledAt,
		status: "success",
		runId,
		finishedAt: TODAY.toISOString(),
	});
}

describe("CheckInStore daily plan", () => {
	it("counts today's learning slots and ignores reminder jobs", () => {
		const learning = createJob();
		createJob({ name: "push", taskType: "push_reminder", cron: "0 10 * * *" });
		createJob({ name: "check-in reminder", taskType: "check_in_reminder", cron: "0 11 * * *" });

		const status = checkInStore.status(TODAY);
		expect(status.dayStatus).toBe("pending");
		expect(status.requiredCount).toBe(1);
		expect(status.requiredCount).toBe(1);
		expect(status.completedCount).toBe(0);
		expect(status.jobs.map((job) => job.jobId)).toEqual([learning.id]);
		expect(status.jobs[0].occurrences[0].scheduledAt).toBe("2026-09-10T01:00:00.000Z");
	});

	it("requires every planned occurrence when a job runs multiple times", () => {
		const job = createJob({ cron: "0 9,18 * * *" });
		const plan = checkInStore.getTodayPlan(TODAY);
		expect(plan.jobs.map((entry) => entry.jobId)).toContain(job.id);
		const occurrences = plan.jobs[0].occurrences;
		expect(occurrences).toHaveLength(2);

		completeOccurrence(occurrences[0], "run-morning");
		let status = checkInStore.status(TODAY);
		expect(status.completedCount).toBe(1);
		expect(status.remainingCount).toBe(1);
		expect(status.todayCheckedIn).toBe(false);

		const result = completeOccurrence(occurrences[1], "run-evening");
		expect(result.justCompleted).toBe(true);
		status = checkInStore.status(TODAY);
		expect(status.dayStatus).toBe("completed");
		expect(status.todayCheckedIn).toBe(true);
		expect(status.currentStreak).toBe(1);
	});

	it("supports weekly, monthly, and one-time schedules on their matching date", () => {
		createJob({ name: "weekly", cron: "0 10 * * 4" });
		createJob({ name: "monthly", cron: "0 11 10 * *" });
		createJob({ name: "once", cron: "0 12 10 9 *" });
		createJob({ name: "not today", cron: "0 12 * * 5" });

		const status = checkInStore.status(TODAY);
		expect(status.requiredCount).toBe(3);
		expect(status.jobs.map((job) => job.jobName)).toEqual(["weekly", "monthly", "once"]);
	});

	it("blocks on errors, but skipped slots do not block", () => {
		const first = createJob({ name: "first" });
		const second = createJob({ name: "second", cron: "0 10 * * *" });
		const [firstOccurrence] = checkInStore.getTodayPlan(TODAY).jobs.find((job) => job.jobId === first.id)!.occurrences;
		const [secondOccurrence] = checkInStore.getTodayPlan(TODAY).jobs.find((job) => job.jobId === second.id)!.occurrences;

		checkInStore.recordOccurrence({
			...firstOccurrence,
			status: "error",
			runId: "run-error",
			finishedAt: TODAY.toISOString(),
		});
		checkInStore.recordOccurrence({
			...secondOccurrence,
			status: "skipped",
			runId: "run-skipped",
			finishedAt: TODAY.toISOString(),
		});

		let status = checkInStore.status(TODAY);
		expect(status.failedCount).toBe(1);
		expect(status.skippedCount).toBe(1);
		expect(status.requiredCount).toBe(1);
		expect(status.remainingCount).toBe(1);
		expect(status.todayCheckedIn).toBe(false);

		checkInStore.recordOccurrence({
			...firstOccurrence,
			status: "success",
			runId: "run-retry",
			finishedAt: TODAY.toISOString(),
		});
		status = checkInStore.status(TODAY);
		expect(status.todayCheckedIn).toBe(true);
		expect(status.completedCount).toBe(1);
	});

	it("resolves a selected pending or failed slot and fills only that slot", () => {
		const job = createJob({ cron: "0 9,18 * * *" });
		const occurrences = checkInStore.getTodayPlan(TODAY).jobs[0].occurrences;

		expect(checkInStore.resolveOccurrence(job.id, occurrences[1].occurrenceId, TODAY)?.occurrenceId)
			.toBe(occurrences[1].occurrenceId);
		completeOccurrence(occurrences[1], "run-evening");
		expect(checkInStore.resolveOccurrence(job.id, occurrences[1].occurrenceId, TODAY)).toBeUndefined();
		expect(checkInStore.resolveOccurrence(job.id, undefined, TODAY)?.occurrenceId)
			.toBe(occurrences[0].occurrenceId);
	});

	it("reacts to current-day task changes", () => {
		const first = createJob({ name: "first" });
		completeOccurrence(checkInStore.getTodayPlan(TODAY).jobs[0].occurrences[0]);
		expect(checkInStore.status(TODAY).todayCheckedIn).toBe(true);

		const added = createJob({ name: "added", cron: "0 10 * * *" });
		expect(checkInStore.status(TODAY).todayCheckedIn).toBe(false);
		expect(checkInStore.status(TODAY).remainingCount).toBe(1);

		jobStore.update(added.id, { enabled: false });
		expect(checkInStore.status(TODAY).todayCheckedIn).toBe(true);
		jobStore.update(first.id, { enabled: false });
		expect(checkInStore.status(TODAY).dayStatus).toBe("no_tasks");
		expect(checkInStore.status(TODAY).totalCount).toBe(0);
	});

	it("does not create a check-in on a day with no learning tasks", () => {
		createJob({ cron: "0 9 * * 4" });
		const friday = new Date("2026-09-11T02:00:00.000Z");
		const status = checkInStore.status(friday);
		expect(status.dayStatus).toBe("no_tasks");
		expect(status.todayCheckedIn).toBe(false);
		expect(status.totalCount).toBe(0);
		expect(checkInStore.list()).toHaveLength(0);
	});

	it("preserves legacy history without allowing it to bypass today's plan", () => {
		createJob();
		writeJson(join(dir, "data", "checkins", "checkins.json"), [
			{ date: "2026-09-09", checkedInAt: "2026-09-09T12:00:00.000Z" },
			{ date: "2026-09-10", checkedInAt: "2026-09-10T01:30:00.000Z" },
		]);

		let status = checkInStore.status(TODAY);
		expect(status.todayCheckedIn).toBe(false);
		expect(status.totalCount).toBe(1);
		expect(status.currentStreak).toBe(1);

		const occurrence = checkInStore.getTodayPlan(TODAY).jobs[0].occurrences[0];
		completeOccurrence(occurrence);
		status = checkInStore.status(TODAY);
		expect(status.todayCheckedIn).toBe(true);
		expect(status.totalCount).toBe(2);
	});

	it("uses the global timezone for the day key and occurrence identity", () => {
		const atUtcBoundary = new Date("2026-09-09T16:00:00.000Z");
		expect(dateKeyForTimeZone(atUtcBoundary, "Asia/Shanghai")).toBe("2026-09-10");
		const job = createJob();
		const occurrence = checkInStore.getTodayPlan(TODAY).jobs[0].occurrences[0];
		expect(occurrence.occurrenceId).toBe(occurrenceIdFor(job.id, occurrence.scheduledAt));
	});
});
