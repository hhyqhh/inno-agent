import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { appendJsonl, readJson, readJsonlTail, writeJson, ensureDir } from "../storage/file-store.js";
import type { JobRunRecord, ScheduledJob } from "./types.js";
import { computeNextRunAt, DEFAULT_SCHEDULER_TIMEZONE } from "./cron-utils.js";

const JOBS_FILE = "jobs.json";
const RUNS_FILE = "runs.jsonl";

/** runs.jsonl is rolled to a timestamped archive once it exceeds this size. */
const RUNS_MAX_BYTES = 10 * 1024 * 1024;
/** listRuns only needs recent history, so it reads just the tail of the file. */
const LIST_RUNS_TAIL_BYTES = 1024 * 1024;

export type ScheduledJobCreateInput =
	Omit<ScheduledJob, "id" | "createdAt" | "updatedAt" | "runCount" | "failureCount" | "lastStatus" | "lastError">
	& Partial<Pick<ScheduledJob, "runCount" | "failureCount" | "lastStatus" | "lastError">>;

export class JobStore {
	private filePath: string;
	private runsFilePath: string;
	/** Fallback timezone for jobs that don't pin their own. */
	readonly defaultTimezone: string;
	/**
	 * Per-job serialization chains for `mutate`: each mutation re-reads the
	 * current state inside the chain, so concurrent runs (cron + manual + the
	 * agent's run_scheduled_job tool) can't lose counter increments by writing
	 * back values computed from a stale snapshot.
	 */
	private mutationChains = new Map<string, Promise<void>>();

	constructor(jobsDir: string, defaultTimezone: string = DEFAULT_SCHEDULER_TIMEZONE) {
		ensureDir(jobsDir);
		this.filePath = join(jobsDir, JOBS_FILE);
		this.runsFilePath = join(jobsDir, RUNS_FILE);
		this.defaultTimezone = defaultTimezone;
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
		const timezone = input.timezone || this.defaultTimezone;
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

	/**
	 * Serialized read-modify-write for one job. The mutator receives the job's
	 * *fresh* state (re-read inside the per-job promise chain), so increments
	 * like `runCount + 1` are computed from the latest persisted values instead
	 * of a snapshot captured before a possibly minutes-long run. Semantics
	 * (updatedAt bump, nextRunAt recompute) mirror `update()`.
	 */
	mutate(id: string, mutator: (current: ScheduledJob) => Partial<ScheduledJob>): Promise<ScheduledJob | undefined> {
		const prev = this.mutationChains.get(id) ?? Promise.resolve();
		const next = prev.then((): ScheduledJob | undefined => {
			const jobs = this.list();
			const idx = jobs.findIndex((j) => j.id === id);
			if (idx < 0) return undefined;
			const current = jobs[idx];
			const patch = mutator(current);
			const merged = { ...current, ...patch, updatedAt: new Date().toISOString() };
			if (patch.enabled === false) {
				merged.nextRunAt = undefined;
			} else if ("nextRunAt" in patch) {
				// A run tied to a concrete planned slot may provide the next slot
				// explicitly. Preserve it even though lastRunAt also changes.
				merged.nextRunAt = patch.nextRunAt;
			} else if (patch.cron || patch.timezone || patch.lastRunAt || patch.enabled !== undefined) {
				merged.nextRunAt = merged.enabled ? computeNextRunAt(merged.cron, merged.timezone) : undefined;
			}
			jobs[idx] = merged;
			writeJson(this.filePath, jobs);
			return merged;
		});
		// Keep the chain alive even if this mutation rejects; swallow in the
		// stored link so later mutations still run. The caller gets the real
		// promise (with its rejection) as the return value.
		this.mutationChains.set(id, next.then(() => undefined, () => undefined));
		return next;
	}

	delete(id: string): boolean {
		const jobs = this.list();
		const filtered = jobs.filter((j) => j.id !== id);
		if (filtered.length === jobs.length) return false;
		writeJson(this.filePath, filtered);
		return true;
	}

	appendRun(record: JobRunRecord): void {
		appendJsonl(this.runsFilePath, record, { maxBytes: RUNS_MAX_BYTES });
	}

	listRuns(jobId?: string, limit = 50): JobRunRecord[] {
		const runs = readJsonlTail<JobRunRecord>(this.runsFilePath, LIST_RUNS_TAIL_BYTES);
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
		const timezone = job.timezone || this.defaultTimezone;
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
