import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JobStore } from "./job-store.js";
import type { ScheduledJob } from "./types.js";

let dir: string;
let store: JobStore;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "inno-jobstore-"));
	store = new JobStore(dir);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function createJob(overrides: Partial<Parameters<JobStore["create"]>[0]> = {}) {
	return store.create({
		name: "daily review",
		cron: "0 9 * * *",
		timezone: "",
		enabled: true,
		taskType: "daily_review",
		prompt: "review my notes",
		...overrides,
	});
}

describe("JobStore.create", () => {
	it("applies defaults: Asia/Shanghai timezone, counters, computed nextRunAt", () => {
		const job = createJob();
		expect(job.id).toMatch(/^job_/);
		expect(job.timezone).toBe("Asia/Shanghai");
		expect(job.runCount).toBe(0);
		expect(job.failureCount).toBe(0);
		expect(job.nextRunAt).toBeDefined();
		expect(new Date(job.nextRunAt!).getTime()).toBeGreaterThan(Date.now() - 60_000);
	});

	it("uses the constructor defaultTimezone when the job doesn't pin one", () => {
		const utcStore = new JobStore(dir, "UTC");
		expect(utcStore.defaultTimezone).toBe("UTC");
		const job = utcStore.create({
			name: "utc job",
			cron: "0 9 * * *",
			timezone: "",
			enabled: true,
			taskType: "custom_prompt",
			prompt: "hi",
		});
		expect(job.timezone).toBe("UTC");
	});

	it("an explicit job timezone always wins over the store default", () => {
		const utcStore = new JobStore(dir, "UTC");
		const job = utcStore.create({
			name: "pinned",
			cron: "0 9 * * *",
			timezone: "America/New_York",
			enabled: true,
			taskType: "custom_prompt",
			prompt: "hi",
		});
		expect(job.timezone).toBe("America/New_York");
	});

	it("persists jobs to jobs.json so a fresh store sees them", () => {
		const job = createJob();
		const reloaded = new JobStore(dir);
		expect(reloaded.get(job.id)?.name).toBe("daily review");
	});
});

describe("JobStore.update", () => {
	it("clears nextRunAt when the job is disabled", () => {
		const job = createJob();
		const updated = store.update(job.id, { enabled: false });
		expect(updated?.enabled).toBe(false);
		expect(updated?.nextRunAt).toBeUndefined();
	});

	it("recomputes nextRunAt when the cron changes on an enabled job", () => {
		const job = createJob();
		const updated = store.update(job.id, { cron: "*/5 * * * *" });
		expect(updated?.nextRunAt).toBeDefined();
	});

	it("returns undefined for an unknown id", () => {
		expect(store.update("job_missing", { name: "x" })).toBeUndefined();
	});
});

describe("JobStore.mutate", () => {
	it("serializes concurrent counter increments against fresh state", async () => {
		const job = createJob();
		// Simulate overlapping runs finishing at the same time: each increment
		// must observe the previous one, so all 5 land.
		await Promise.all(
			Array.from({ length: 5 }, () =>
				store.mutate(job.id, (current) => ({ runCount: current.runCount + 1 })),
			),
		);
		expect(store.get(job.id)?.runCount).toBe(5);
	});

	it("replicates update() semantics: clears nextRunAt when disabled", async () => {
		const job = createJob();
		const updated = await store.mutate(job.id, () => ({ enabled: false }));
		expect(updated?.enabled).toBe(false);
		expect(updated?.nextRunAt).toBeUndefined();
	});

	it("replicates update() semantics: recomputes nextRunAt on cron change", async () => {
		const job = createJob();
		const updated = await store.mutate(job.id, () => ({ cron: "*/5 * * * *" }));
		expect(updated?.nextRunAt).toBeDefined();
	});

	it("honors an explicit nextRunAt when lastRunAt also changes", async () => {
		const job = createJob();
		const explicit = "2099-01-01T09:00:00.000Z";
		const updated = await store.mutate(job.id, () => ({
			lastRunAt: "2026-09-10T16:52:00.000Z",
			nextRunAt: explicit,
		}));
		expect(updated?.nextRunAt).toBe(explicit);
	});

	it("keeps the chain alive after a mutator throws", async () => {
		const job = createJob();
		await expect(
			store.mutate(job.id, () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		// A later mutation still runs and sees the un-modified state.
		const updated = await store.mutate(job.id, (current) => ({ runCount: current.runCount + 1 }));
		expect(updated?.runCount).toBe(1);
	});

	it("returns undefined for an unknown id", async () => {
		await expect(store.mutate("job_missing", () => ({}))).resolves.toBeUndefined();
	});
});

describe("JobStore.normalizePersistedJobs", () => {
	it("backfills missing fields on legacy partial jobs", () => {
		// Simulate a jobs.json written by an older version: bare minimum fields,
		// no runCount/nextRunAt/createdAt.
		const legacy = [{ id: "job_legacy1", name: "old job", cron: "0 9 * * *", taskType: "custom_prompt", prompt: "hi" }];
		writeFileSync(join(dir, "jobs.json"), JSON.stringify(legacy), "utf-8");

		const jobs = store.normalizePersistedJobs();
		expect(jobs).toHaveLength(1);
		const job = jobs[0];
		expect(job.id).toBe("job_legacy1");
		expect(job.timezone).toBe("Asia/Shanghai");
		expect(job.runCount).toBe(0);
		expect(job.nextRunAt).toBeDefined();
		expect(job.createdAt).toBeDefined();

		// The normalized shape must be written back to disk.
		const onDisk = JSON.parse(readFileSync(join(dir, "jobs.json"), "utf-8")) as ScheduledJob[];
		expect(onDisk[0].runCount).toBe(0);
		expect(onDisk[0].nextRunAt).toBeDefined();
	});

	it("keeps nextRunAt undefined for disabled legacy jobs", () => {
		const legacy = [{ id: "job_off", name: "disabled", cron: "0 9 * * *", enabled: false }];
		writeFileSync(join(dir, "jobs.json"), JSON.stringify(legacy), "utf-8");
		const jobs = store.normalizePersistedJobs();
		expect(jobs[0].nextRunAt).toBeUndefined();
	});
});

describe("JobStore runs", () => {
	it("appends run records and lists newest first, filtered by jobId", () => {
		const a = createJob({ name: "a" });
		const b = createJob({ name: "b" });
		store.appendRun({ id: "r1", jobId: a.id, jobName: "a", status: "success", startedAt: "2026-08-09T01:00:00Z", trigger: "scheduled" });
		store.appendRun({ id: "r2", jobId: b.id, jobName: "b", status: "error", startedAt: "2026-08-09T02:00:00Z", trigger: "manual" });

		expect(store.listRuns(a.id).map((r) => r.id)).toEqual(["r1"]);
		expect(store.listRuns().map((r) => r.id)).toEqual(["r2", "r1"]);
	});
});

describe("JobStore.getStatus", () => {
	it("counts totals and picks the earliest upcoming run", () => {
		createJob({ name: "enabled" });
		createJob({ name: "disabled", enabled: false });
		const status = store.getStatus();
		expect(status.total).toBe(2);
		expect(status.enabled).toBe(1);
		expect(status.disabled).toBe(1);
		expect(status.nextRunAt).toBeDefined();
	});
});
