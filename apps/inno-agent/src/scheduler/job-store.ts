import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { appendJsonl, readJson, readJsonl, writeJson, ensureDir } from "../storage/file-store.js";
import type { JobRunRecord, ScheduledJob } from "./types.js";
import { computeNextRunAt } from "./cron-utils.js";

const JOBS_FILE = "jobs.json";
const RUNS_FILE = "runs.jsonl";

export type ScheduledJobCreateInput =
	Omit<ScheduledJob, "id" | "createdAt" | "updatedAt" | "runCount" | "failureCount" | "lastStatus" | "lastError">
	& Partial<Pick<ScheduledJob, "runCount" | "failureCount" | "lastStatus" | "lastError">>;

export class JobStore {
	private filePath: string;
	private runsFilePath: string;

	constructor(jobsDir: string) {
		ensureDir(jobsDir);
		this.filePath = join(jobsDir, JOBS_FILE);
		this.runsFilePath = join(jobsDir, RUNS_FILE);
	}

	list(): ScheduledJob[] {
		return readJson<Partial<ScheduledJob>[]>(this.filePath, []).map((job) => this.normalizeJob(job));
	}

	normalizePersistedJobs(): ScheduledJob[] {
		const jobs = this.list();
		writeJson(this.filePath, jobs);
		return jobs;
	}

	get(id: string): ScheduledJob | undefined {
		return this.list().find((j) => j.id === id);
	}

	create(input: ScheduledJobCreateInput): ScheduledJob {
		const jobs = this.list();
		const now = new Date().toISOString();
		const timezone = input.timezone || "Asia/Shanghai";
		const job: ScheduledJob = {
			...input,
			id: `job_${randomUUID().slice(0, 8)}`,
			timezone,
			runCount: input.runCount ?? 0,
			failureCount: input.failureCount ?? 0,
			nextRunAt: input.nextRunAt ?? computeNextRunAt(input.cron, timezone),
			createdAt: now,
			updatedAt: now,
		};
		jobs.push(job);
		writeJson(this.filePath, jobs);
		return job;
	}

	update(id: string, patch: Partial<ScheduledJob>): ScheduledJob | undefined {
		const jobs = this.list();
		const idx = jobs.findIndex((j) => j.id === id);
		if (idx < 0) return undefined;
		const current = jobs[idx];
		const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
		if (patch.cron || patch.timezone || patch.lastRunAt || patch.enabled !== undefined) {
			next.nextRunAt = next.enabled ? computeNextRunAt(next.cron, next.timezone) : undefined;
		}
		jobs[idx] = next;
		writeJson(this.filePath, jobs);
		return jobs[idx];
	}

	delete(id: string): boolean {
		const jobs = this.list();
		const filtered = jobs.filter((j) => j.id !== id);
		if (filtered.length === jobs.length) return false;
		writeJson(this.filePath, filtered);
		return true;
	}

	appendRun(record: JobRunRecord): void {
		appendJsonl(this.runsFilePath, record);
	}

	listRuns(jobId?: string, limit = 50): JobRunRecord[] {
		const runs = readJsonl<JobRunRecord>(this.runsFilePath);
		const filtered = jobId ? runs.filter((run) => run.jobId === jobId) : runs;
		return filtered.slice(-limit).reverse();
	}

	getStatus(): {
		total: number;
		enabled: number;
		disabled: number;
		running: number;
		failed: number;
		nextRunAt?: string;
	} {
		const jobs = this.list();
		const enabledJobs = jobs.filter((job) => job.enabled);
		const nextRunAt = enabledJobs
			.map((job) => job.nextRunAt)
			.filter((value): value is string => Boolean(value))
			.sort()[0];
		return {
			total: jobs.length,
			enabled: enabledJobs.length,
			disabled: jobs.length - enabledJobs.length,
			running: jobs.filter((job) => job.lastStatus === "running").length,
			failed: jobs.filter((job) => job.lastStatus === "error").length,
			nextRunAt,
		};
	}

	private normalizeJob(job: Partial<ScheduledJob>): ScheduledJob {
		const now = new Date().toISOString();
		const timezone = job.timezone || "Asia/Shanghai";
		const enabled = job.enabled ?? true;
		return {
			id: job.id ?? `job_${randomUUID().slice(0, 8)}`,
			name: job.name ?? "Untitled job",
			cron: job.cron ?? "0 9 * * *",
			timezone,
			enabled,
			channel: job.channel,
			target: job.target,
			taskType: job.taskType ?? "custom_prompt",
			prompt: job.prompt ?? "",
			lastRunAt: job.lastRunAt,
			nextRunAt: enabled ? (job.nextRunAt ?? computeNextRunAt(job.cron ?? "0 9 * * *", timezone)) : undefined,
			lastStatus: job.lastStatus,
			lastError: job.lastError,
			runCount: job.runCount ?? 0,
			failureCount: job.failureCount ?? 0,
			createdAt: job.createdAt ?? now,
			updatedAt: job.updatedAt ?? now,
		};
	}
}
