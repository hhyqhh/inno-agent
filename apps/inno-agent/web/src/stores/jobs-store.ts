import { EventEmitter } from "./event-emitter.js";
import { listJobs, createJob, updateJob, deleteJob, streamJobRun } from "../api/jobs.js";
import type { CreateJobInput, JobRunResult, JobRunStreamEvent, ScheduledJob, UpdateJobInput } from "../types/jobs.js";

interface JobsStoreEvents {
	change: void;
}

class JobsStoreImpl extends EventEmitter<JobsStoreEvents> {
	jobs: ScheduledJob[] = [];
	isLoading = false;
	hasLoaded = false;
	runningJobId: string | null = null;

	private reminderEditor: { id: string | null } | undefined;

	requestReminderEditor(id?: string | null) {
		this.reminderEditor = id === undefined ? undefined : { id };
	}

	takeReminderEditor() {
		const intent = this.reminderEditor;
		this.reminderEditor = undefined;
		return intent;
	}

	async load(): Promise<void> {
		if (this.isLoading) return;
		this.isLoading = true;
		this.emit("change", undefined);
		try {
			this.jobs = await listJobs();
		} catch {
			// Retain the last successful list during transient failures.
		} finally {
			this.isLoading = false;
			this.hasLoaded = true;
			this.emit("change", undefined);
		}
	}

	async create(input: CreateJobInput): Promise<ScheduledJob> {
		const job = await createJob(input);
		this.jobs = [...this.jobs, job];
		this.emit("change", undefined);
		return job;
	}

	async update(id: string, patch: UpdateJobInput): Promise<void> {
		const updated = await updateJob(id, patch);
		this.jobs = this.jobs.map((j) => (j.id === id ? updated : j));
		this.emit("change", undefined);
	}

	async remove(id: string): Promise<void> {
		await deleteJob(id);
		this.jobs = this.jobs.filter((j) => (j.id !== id));
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
