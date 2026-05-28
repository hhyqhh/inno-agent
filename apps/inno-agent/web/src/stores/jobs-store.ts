import { EventEmitter } from "./event-emitter.js";
import { listJobs, createJob, updateJob, deleteJob, runJob } from "../api/jobs.js";
import type { ScheduledJob, CreateJobInput } from "../types/jobs.js";

interface JobsStoreEvents {
	change: void;
}

class JobsStoreImpl extends EventEmitter<JobsStoreEvents> {
	jobs: ScheduledJob[] = [];
	isLoading = false;
	runningJobId: string | null = null;
	lastRunResult: string | null = null;

	async load(): Promise<void> {
		this.isLoading = true;
		this.emit("change", undefined);
		try {
			this.jobs = await listJobs();
		} catch {
			this.jobs = [];
		} finally {
			this.isLoading = false;
			this.emit("change", undefined);
		}
	}

	async create(input: CreateJobInput): Promise<ScheduledJob> {
		const job = await createJob(input);
		this.jobs = [...this.jobs, job];
		this.emit("change", undefined);
		return job;
	}

	async update(id: string, patch: Partial<ScheduledJob>): Promise<void> {
		const updated = await updateJob(id, patch);
		this.jobs = this.jobs.map((j) => (j.id === id ? updated : j));
		this.emit("change", undefined);
	}

	async remove(id: string): Promise<void> {
		await deleteJob(id);
		this.jobs = this.jobs.filter((j) => j.id !== id);
		this.emit("change", undefined);
	}

	async run(id: string): Promise<string> {
		this.runningJobId = id;
		this.lastRunResult = null;
		this.emit("change", undefined);
		try {
			const result = await runJob(id);
			this.lastRunResult = result.response;
			// Refresh list to get updated lastRunAt
			await this.load();
			return result.response;
		} finally {
			this.runningJobId = null;
			this.emit("change", undefined);
		}
	}
}

export const jobsStore = new JobsStoreImpl();
