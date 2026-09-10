import { chatStore } from "../../stores/chat-store.js";
import { jobsStore } from "../../stores/jobs-store.js";
import { sessionsStore } from "../../stores/sessions-store.js";
import { workspaceStore } from "../../stores/workspace-store.js";
import { getCheckInStatus } from "../../api/checkins.js";
import type { ScheduledJob } from "../../types/jobs.js";

type Translate = (key: string, vars?: Record<string, unknown>) => string;

/** True when today's plan already settled this slot (success or skipped). */
async function isSlotSettled(jobId: string, occurrenceId: string): Promise<boolean> {
	try {
		const status = await getCheckInStatus();
		const occurrence = status.jobs
			.find((job) => job.jobId === jobId)
			?.occurrences.find((candidate) => candidate.occurrenceId === occurrenceId);
		return !occurrence || occurrence.status === "success" || occurrence.status === "skipped";
	} catch {
		return false; // status unavailable — let the run proceed and rely on the server guard
	}
}

/** Resolve a job's full definition (prompt included), loading the list once if needed. */
export async function findJobById(jobId: string): Promise<ScheduledJob | undefined> {
	const known = jobsStore.jobs.find((candidate) => candidate.id === jobId);
	if (known) return known;
	await jobsStore.load();
	return jobsStore.jobs.find((candidate) => candidate.id === jobId);
}

/**
 * Shared "run now" flow for every manual scheduled-task run (jobs panel and
 * check-in card): each run creates its own conversation, streams the agent
 * run into it through the job-stream namespace, then settles the result —
 * keeping the finalized timeline and the composer unlocked the whole time.
 */
export async function runJobInConversation(job: ScheduledJob, t: Translate, occurrenceId?: string): Promise<void> {
	try {
		// Slot-bound run: if today's plan already settled this slot, do nothing
		// at all — no conversation, no bubble, no result message.
		if (occurrenceId) {
			const settled = await isSlotSettled(job.id, occurrenceId);
			if (settled) return;
		}
		const workspaceId = sessionsStore.preselectedWorkspaceId ?? workspaceStore.activeWorkspaceId;
		await sessionsStore.createSessionWith(workspaceId ? { workspaceId } : { newWorkspace: { isTemp: true } });
		const targetSessionId = sessionsStore.currentSessionId;
		if (!targetSessionId) throw new Error(t("jobs.errors.sessionCreateFailed"));
		// createSessionWith clears the chat but does not load an empty history,
		// so bind the new session before starting the streaming job view.
		chatStore.loadHistory([], targetSessionId);
		chatStore.beginJobStream(targetSessionId);
		// Show the job prompt as the user turn immediately, like a normal chat.
		chatStore.appendJobUserMessage(targetSessionId, job.prompt);
		if (!chatStore.jobStreaming) throw new Error(t("jobs.errors.sessionUnavailable"));
		// The server re-tags the session as scheduler-born right before the
		// stream starts; the sidebar snapshot still says "Web" from creation,
		// so refresh once the first event proves the tag has been written.
		let sessionTagRefreshed = false;
		const signal = chatStore.jobStreamSignal;
		const result = await jobsStore.runStreaming(job.id, targetSessionId, (event) => {
			chatStore.applyJobStreamEvent(event);
			if (!sessionTagRefreshed) {
				sessionTagRefreshed = true;
				void sessionsStore.refresh();
			}
		}, signal ?? undefined, occurrenceId).catch((err: unknown) => {
			if (signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
				return null; // user pressed stop — settled below
			}
			throw err;
		});
		if (result === null) {
			// Keep the process timeline (tool rows + partial answer) as the
			// visible record instead of collapsing it into plain text.
			chatStore.settleJobStreamStopped(job.id, t("jobs.chat.stopped"));
			void sessionsStore.refresh();
			return;
		}
		const content = result.success
			? t("jobs.chat.completed", {
				name: job.name,
				output: result.output?.trim() || t("jobs.chat.noOutput"),
			})
			: t("jobs.chat.failed", {
				name: job.name,
				error: result.error?.trim() || t("jobs.chat.unknownError"),
			});
		chatStore.settleJobStream(job.id, content);
		void sessionsStore.refresh();
	} catch (err) {
		const raw = err instanceof Error ? err.message : String(err);
		// Lost the race: the server settled the slot between our pre-check and
		// the stream start. Roll the optimistic bubble back silently.
		if (/no longer pending|no longer available|already being handled/i.test(raw)) {
			chatStore.discardJobStream();
			void sessionsStore.refresh();
			return;
		}
		chatStore.settleJobStream(job.id, t("jobs.chat.failed", { name: job.name, error: raw }));
		void sessionsStore.refresh();
	}
}
