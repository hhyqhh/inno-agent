import { apiFetch } from "./client.js";
import type { CheckInStatus } from "../types/checkins.js";

export function getCheckInStatus(): Promise<CheckInStatus> {
	return apiFetch<CheckInStatus>("/api/checkins/today");
}

/** A fired-but-not-yet-started interactive scheduled slot. */
export interface PendingRun {
	jobId: string;
	jobName: string;
	occurrenceId: string;
	scheduledAt: string;
	/** ISO instant after which the server auto-executes the run. */
	deadline: string;
}

export function getPendingRuns(): Promise<PendingRun[]> {
	return apiFetch<PendingRun[]>("/api/checkins/pending-runs");
}

export async function skipOccurrence(occurrenceId: string): Promise<void> {
	await apiFetch("/api/checkins/skip", {
		method: "POST",
		body: JSON.stringify({ occurrenceId }),
	});
}

/** Take over a fired slot client-side: cancels the server timer so this
 *  browser can run the slot in a visible, streamed conversation. */
export async function claimOccurrence(occurrenceId: string): Promise<void> {
	await apiFetch("/api/checkins/claim", {
		method: "POST",
		body: JSON.stringify({ occurrenceId }),
	});
}
