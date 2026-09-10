import { apiFetch, streamSSE } from "./client.js";
import type { CreateJobInput, JobRunResult, JobRunStreamEvent, ScheduledJob } from "../types/jobs.js";

export async function listJobs(): Promise<ScheduledJob[]> {
	return apiFetch<ScheduledJob[]>("/api/jobs");
}

export async function createJob(data: CreateJobInput): Promise<ScheduledJob> {
	return apiFetch<ScheduledJob>("/api/jobs", {
		method: "POST",
		body: JSON.stringify(data),
	});
}

export async function updateJob(id: string, patch: Partial<ScheduledJob>): Promise<ScheduledJob> {
	return apiFetch<ScheduledJob>(`/api/jobs/${id}`, {
		method: "PATCH",
		body: JSON.stringify(patch),
	});
}

export async function deleteJob(id: string): Promise<void> {
	await apiFetch(`/api/jobs/${id}`, { method: "DELETE" });
}

export function streamJobRun(id: string, sessionId: string, signal?: AbortSignal, occurrenceId?: string): AsyncGenerator<JobRunStreamEvent> {
	return streamSSE<JobRunStreamEvent>(
		`/api/jobs/${encodeURIComponent(id)}/run/stream`,
		{ sessionId, occurrenceId: occurrenceId || undefined },
		signal,
	);
}

/** Ask the server to abort the in-flight manual job run for a session. */
export async function stopJobRun(sessionId: string): Promise<void> {
	await apiFetch(`/api/jobs/run/stop`, {
		method: "POST",
		body: JSON.stringify({ sessionId }),
	});
}
