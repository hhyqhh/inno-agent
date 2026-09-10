import { EventEmitter } from "./event-emitter.js";
import { listJobs, createJob, updateJob, deleteJob, streamJobRun } from "../api/jobs.js";
import type { CreateJobInput, JobRunResult, JobRunStreamEvent, ScheduledJob } from "../types/jobs.js";

interface JobsStoreEvents {
	change: void;
}

class JobsStoreImpl extends EventEmitter<JobsStoreEvents> {
	jobs: ScheduledJob[] = [];
	isLoading = false;
	runningJobId: string | null = null;

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
		this.jobs = this.jobs.filter((j) => (j.id === id));
		this.emit("change", undefined);
	}

	async runStreaming(
		id: string,
		sessionId: string,
		onEvent: (event: JobRunStreamEvent) => void,
		signal?: AbortSignal,
		occurrenceId?: string,
	): Promise<JobRunResult> {
		this.runningJobId = id;
		this.emit("change", undefined);
		try {
			let result: JobRunResult | null = null;
			for await (const event of streamJobRun(id, sessionId, signal, occurrenceId)) {
				if (event.type === "job_result") result = event.result;
				else onEvent(event);
			}
			if (!result) {
				if (signal?.aborted) {
					const stopped = new Error("任务已手动停止");
					stopped.name = "AbortError";
					throw stopped;
				}
				throw new Error("任务流提前结束，未收到执行结果");
			}
			await this.load();
			return result;
		} finally {
			this.runningJobId = null;
			this.emit("change", undefined);
		}
	}
}

export const jobsStore = new JobsStoreImpl();
