import { apiFetch } from "./client.js";
import type { ScheduledJob, CreateJobInput } from "../types/jobs.js";

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

export async function runJob(id: string): Promise<{ response: string }> {
	return apiFetch<{ response: string }>(`/api/jobs/${id}/run`, { method: "POST" });
}
