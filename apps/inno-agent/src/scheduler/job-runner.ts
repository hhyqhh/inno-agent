import type { ScheduledJob } from "./types.js";
import type { JobStore } from "./job-store.js";
import type { ChannelRegistry } from "../channels/channel.js";
import { appendAssistantNotification, getCurrentSessionChannelHint, runPromptSerialized } from "../agent/pi-runner.js";
import { computeNextRunAt, isOneShotCron } from "./cron-utils.js";
import { randomUUID } from "node:crypto";

export interface JobRunResult {
	jobId: string;
	success: boolean;
	output?: string;
	error?: string;
	pushedToChannel?: string;
	runId: string;
}

export type JobRunTrigger = "scheduled" | "manual" | "api";

/**
 * Execute a scheduled job:
 * 1. Run the job's prompt through the agent session
 * 2. If channel + target configured, push result to channel
 * 3. Update lastRunAt
 */
export async function executeJob(
	job: ScheduledJob,
	jobStore: JobStore,
	channelRegistry: ChannelRegistry,
	trigger: JobRunTrigger = "manual",
): Promise<JobRunResult> {
	const runId = `run_${randomUUID().slice(0, 8)}`;
	const startedAt = new Date();

	const inferredChannel = inferChannel(job, channelRegistry);
	if (!job.channel && inferredChannel) {
		job.channel = inferredChannel;
		jobStore.update(job.id, { channel: inferredChannel });
	}

	jobStore.update(job.id, {
		lastStatus: "running",
		lastError: undefined,
	});

	try {
		const output = job.taskType === "push_reminder"
			? formatReminderOutput(job.prompt)
			: await runPromptSerialized(job.prompt);
		if (job.taskType === "push_reminder") {
			appendAssistantNotification(output);
		}

		let pushedToChannel: string | undefined;
		let pushSkippedReason: string | undefined;
		const target = job.channel ? (job.target ?? channelRegistry.getDefaultTarget(job.channel)) : undefined;
		if (job.channel && target) {
			const channel = channelRegistry.get(job.channel);
			if (channel) {
				await channel.push(target, output);
				pushedToChannel = job.channel;
				if (!job.target) {
					jobStore.update(job.id, { target });
				}
			} else {
				pushSkippedReason = `Channel not registered: ${job.channel}`;
			}
		} else if (job.channel && !target) {
			pushSkippedReason = `No push target for channel: ${job.channel}`;
		} else if (!job.channel) {
			pushSkippedReason = "No channel configured";
		}

		// For push_reminder, the channel is the entire point of the job —
		// if it could not be delivered, treat the run as a failure so the
		// user sees an alert in the UI instead of a silent skip.
		const reminderDeliveryFailed =
			job.taskType === "push_reminder" && Boolean(job.channel) && !pushedToChannel;

		const finishedAt = new Date();
		const oneShot = isOneShotCron(job.cron);

		if (reminderDeliveryFailed) {
			const error = pushSkippedReason ?? "Reminder could not be delivered";
			jobStore.appendRun({
				id: runId,
				jobId: job.id,
				jobName: job.name,
				status: "error",
				startedAt: startedAt.toISOString(),
				finishedAt: finishedAt.toISOString(),
				durationMs: finishedAt.getTime() - startedAt.getTime(),
				outputPreview: output.slice(0, 1000),
				error,
				pushSkippedReason,
				trigger,
			});
			jobStore.update(job.id, {
				lastRunAt: finishedAt.toISOString(),
				nextRunAt: oneShot ? undefined : computeNextRunAt(job.cron, job.timezone, finishedAt),
				lastStatus: "error",
				lastError: error,
				enabled: oneShot ? false : job.enabled,
				runCount: job.runCount + 1,
				failureCount: job.failureCount + 1,
			});
			return { jobId: job.id, runId, success: false, error };
		}

		jobStore.appendRun({
			id: runId,
			jobId: job.id,
			jobName: job.name,
			status: "success",
			startedAt: startedAt.toISOString(),
			finishedAt: finishedAt.toISOString(),
			durationMs: finishedAt.getTime() - startedAt.getTime(),
			outputPreview: output.slice(0, 1000),
			pushedToChannel,
			pushSkippedReason,
			trigger,
		});
		jobStore.update(job.id, {
			lastRunAt: finishedAt.toISOString(),
			nextRunAt: oneShot ? undefined : computeNextRunAt(job.cron, job.timezone, finishedAt),
			lastStatus: "success",
			lastError: undefined,
			enabled: oneShot ? false : job.enabled,
			runCount: job.runCount + 1,
		});

		return { jobId: job.id, runId, success: true, output, pushedToChannel };
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		const finishedAt = new Date();
		const oneShot = isOneShotCron(job.cron);
		jobStore.appendRun({
			id: runId,
			jobId: job.id,
			jobName: job.name,
			status: "error",
			startedAt: startedAt.toISOString(),
			finishedAt: finishedAt.toISOString(),
			durationMs: finishedAt.getTime() - startedAt.getTime(),
			error,
			trigger,
		});
		jobStore.update(job.id, {
			lastRunAt: finishedAt.toISOString(),
			nextRunAt: oneShot ? undefined : computeNextRunAt(job.cron, job.timezone, finishedAt),
			lastStatus: "error",
			lastError: error,
			enabled: oneShot ? false : job.enabled,
			runCount: job.runCount + 1,
			failureCount: job.failureCount + 1,
		});
		return { jobId: job.id, runId, success: false, error };
	}
}

function formatReminderOutput(prompt: string): string {
	const trimmed = prompt.trim();
	if (!trimmed) return "提醒时间到了。";
	return trimmed
		.replace(/^提醒学习者[：:]\s*/, "")
		.replace(/^提醒我[：:]\s*/, "")
		.trim() || trimmed;
}

function inferChannel(job: ScheduledJob, channelRegistry: ChannelRegistry): ScheduledJob["channel"] | undefined {
	if (job.channel) return job.channel;
	if (job.taskType === "push_reminder") {
		const hinted = getCurrentSessionChannelHint();
		if (hinted !== "unknown" && hinted !== "web" && hinted !== "cli" && hinted !== "scheduler") {
			const ch = hinted as ScheduledJob["channel"];
			if (ch && channelRegistry.get(ch)) return ch;
		}
		// Fallback: any channel with a default target
		for (const name of ["feishu", "wechat", "qq"] as const) {
			if (channelRegistry.getDefaultTarget(name)) return name;
		}
	}
	return undefined;
}
