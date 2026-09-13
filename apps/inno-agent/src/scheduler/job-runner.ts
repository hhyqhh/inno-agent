import type { ScheduledJob } from "./types.js";
import type { JobStore } from "./job-store.js";
import type { ChannelRegistry } from "../channels/channel.js";
import {
	appendAssistantNotification,
	appendAssistantNotificationInSession,
	getCurrentSessionChannelHint,
	runPromptInSession,
	runPromptStreamingInSession,
	runPromptSerialized,
	type StreamEventCallback,
} from "../agent/pi-runner.js";
import { computeNextRunAt, isOneShotCron } from "./cron-utils.js";
import { randomUUID } from "node:crypto";
import { logger } from "../logger.js";
import { occurrenceIdFor, type CheckInOccurrence, type CheckInStatus, type CheckInStore } from "../checkins/check-in-store.js";

export interface JobRunResult {
	jobId: string;
	success: boolean;
	output?: string;
	error?: string;
	pushedToChannel?: string;
	runId: string;
	checkInStatus?: CheckInStatus;
}

export type JobRunTrigger = "scheduled" | "manual" | "api";

export interface JobExecutionOptions {
	/** Explicit session target for a manual run initiated from the Web UI. */
	sessionPath?: string;
	/** Forward model events to a caller-owned stream for live UI updates. */
	onEvent?: StreamEventCallback;
	/** Explicit daily plan slot selected by the check-in UI. */
	occurrenceId?: string;
	/** Scheduled instant used to derive a daily plan slot. */
	scheduledAt?: string;
}

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
	checkInStore?: CheckInStore,
	options?: JobExecutionOptions,
): Promise<JobRunResult> {
	const runId = `run_${randomUUID().slice(0, 8)}`;
	const startedAt = new Date();
	const isCheckInReminder = job.taskType === "check_in_reminder";
	const isReminderJob = job.taskType === "push_reminder" || isCheckInReminder;
	const requestedOccurrenceId = options?.occurrenceId
		?? (options?.scheduledAt ? occurrenceIdFor(job.id, options.scheduledAt) : undefined);
	const requestedOccurrence = !isReminderJob && checkInStore && requestedOccurrenceId
		? checkInStore.getOccurrence(job.id, requestedOccurrenceId, startedAt)
		: undefined;
	const checkInOccurrence = !isReminderJob && checkInStore
		? checkInStore.resolveOccurrence(job.id, requestedOccurrenceId, startedAt)
		: undefined;
	// A selected slot must still belong to today's live plan. The route also
	// validates this before execution, but keeping the guard here prevents an
	// arbitrary client from attaching a run to a different job/date.
	if (!isReminderJob && checkInStore && requestedOccurrenceId && !checkInOccurrence) {
		if (trigger === "scheduled" && requestedOccurrence && (requestedOccurrence.status === "success" || requestedOccurrence.status === "skipped")) {
			return skipCompletedScheduledOccurrence(job, jobStore, runId, requestedOccurrence);
		}
		// A scheduled occurrence can be from the previous global day when the
		// process wakes up just after midnight. It still needs to run normally;
		// it simply cannot contribute to today's live check-in plan.
		if (trigger !== "scheduled" || requestedOccurrence) {
			return {
			jobId: job.id,
			runId,
			success: false,
			error: "Selected learning schedule slot is no longer available.",
			};
		}
		// Continue without attaching this run to a current-day occurrence.
	}

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
		if (isCheckInReminder && checkInStore?.isCheckedInToday()) {
			const finishedAt = new Date();
			const output = "今天已经完成学习打卡，跳过提醒。";
			jobStore.appendRun({
				id: runId,
				jobId: job.id,
				jobName: job.name,
				status: "skipped",
				startedAt: startedAt.toISOString(),
				finishedAt: finishedAt.toISOString(),
				durationMs: finishedAt.getTime() - startedAt.getTime(),
				outputPreview: output,
				trigger,
			});
			const oneShot = isOneShotCron(job.cron) && isReminderJob;
			if (options?.sessionPath) {
				await appendAssistantNotificationInSession(options.sessionPath, output);
			}
			await jobStore.mutate(job.id, (current) => ({
				lastRunAt: finishedAt.toISOString(),
				lastStatus: "skipped",
				lastError: undefined,
				enabled: oneShot ? false : current.enabled,
				runCount: current.runCount + 1,
			}));
		logger.info({ jobId: job.id, runId, trigger, occurrenceId: requestedOccurrenceId }, "Job run skipped: already checked in today");
		return { jobId: job.id, runId, success: true, output };
	}

	const output = job.taskType === "push_reminder"
			? formatReminderOutput(job.prompt)
			: isCheckInReminder
				? formatCheckInReminderOutput(job.prompt)
			: options?.sessionPath
				? options.onEvent
					? await runPromptStreamingInSession(options.sessionPath, job.prompt, options.onEvent)
					: await runPromptInSession(options.sessionPath, job.prompt)
				: await runPromptSerialized(job.prompt);
		if (isReminderJob) {
			if (options?.sessionPath) await appendAssistantNotificationInSession(options.sessionPath, output);
			else appendAssistantNotification(output);
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

		// Scheduled learning runs are headless — without a notice the user has
		// no signal at all that the task fired. Best-effort ping through the
		// first registered default channel; never fails the run.
		if (trigger === "scheduled" && !isReminderJob && !pushedToChannel) {
			const notified = await pushThroughDefaultChannel(
				channelRegistry,
				`✅ 定时任务「${job.name}」已完成\n\n${output.slice(0, 300)}`,
				{ jobId: job.id, runId },
			);
			if (notified) pushedToChannel = notified;
		}

		// For reminder jobs with an explicitly configured channel, delivery is
		// the entire point of the job —
		// if it could not be delivered, treat the run as a failure so the
		// user sees an alert in the UI instead of a silent skip.
		const reminderDeliveryFailed = isReminderJob && Boolean(job.channel) && !pushedToChannel;

		const finishedAt = new Date();
		const oneShot = isOneShotCron(job.cron) && isReminderJob;

		if (reminderDeliveryFailed) {
			const error = pushSkippedReason ?? "Reminder could not be delivered";
			logger.warn({ jobId: job.id, runId, trigger, channel: job.channel, pushSkippedReason }, "Reminder delivery failed");
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
			// mutate() re-reads fresh state inside a per-job chain — counters are
			// incremented from the latest persisted values, not this run's stale
			// `job` snapshot (overlapping runs would otherwise lose increments).
			// nextRunAt is intentionally omitted: mutate() recomputes it from
			// cron/timezone/enabled, so any value passed here would be dead code.
			await jobStore.mutate(job.id, (current) => ({
				lastRunAt: finishedAt.toISOString(),
				lastStatus: "error",
				lastError: error,
				enabled: oneShot ? false : current.enabled,
				runCount: current.runCount + 1,
				failureCount: current.failureCount + 1,
			}));
			return { jobId: job.id, runId, success: false, error };
		}

		jobStore.appendRun({
			id: runId,
			jobId: job.id,
			jobName: job.name,
			...checkInRunFields(checkInOccurrence),
			status: "success",
			startedAt: startedAt.toISOString(),
			finishedAt: finishedAt.toISOString(),
			durationMs: finishedAt.getTime() - startedAt.getTime(),
			outputPreview: output.slice(0, 1000),
			pushedToChannel,
			pushSkippedReason,
			trigger,
		});
		const checkInStatus = await reconcileCheckIn(
			checkInStore,
			checkInOccurrence,
			runId,
			"success",
			finishedAt,
			undefined,
		);
		// When a user completes a planned slot early, calculate the next run
		// after that slot rather than after the wall-clock completion time.
		// This keeps a daily 21:00 task from showing 21:00 today after an
		// early manual completion at (for example) 16:52.
		const nextRunAt = checkInOccurrence
			? computeNextRunAt(job.cron, job.timezone, new Date(checkInOccurrence.scheduledAt))
			: undefined;
		await jobStore.mutate(job.id, (current) => ({
			lastRunAt: finishedAt.toISOString(),
			lastStatus: "success",
			lastError: undefined,
			enabled: oneShot ? false : current.enabled,
			runCount: current.runCount + 1,
			...(nextRunAt ? { nextRunAt } : {}),
		}));

		logger.info({
			jobId: job.id,
			runId,
			trigger,
			taskType: job.taskType,
			durationMs: finishedAt.getTime() - startedAt.getTime(),
			pushedToChannel,
			checkInStatus,
		}, "Job run finished");
		return { jobId: job.id, runId, success: true, output, pushedToChannel, checkInStatus };
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		logger.error({ err, jobId: job.id, jobName: job.name, taskType: job.taskType, trigger }, "Job execution failed");
		if (trigger === "scheduled") {
			// A scheduled failure has no one watching — mirror the error to the
			// user's default channel so it does not pass unnoticed.
			await pushThroughDefaultChannel(
				channelRegistry,
				`❌ 定时任务「${job.name}」执行失败：${error}`,
				{ jobId: job.id, runId },
			);
		}
		const finishedAt = new Date();
		const oneShot = isOneShotCron(job.cron) && isReminderJob;
		jobStore.appendRun({
			id: runId,
			jobId: job.id,
			jobName: job.name,
			...checkInRunFields(checkInOccurrence),
			status: "error",
			startedAt: startedAt.toISOString(),
			finishedAt: finishedAt.toISOString(),
			durationMs: finishedAt.getTime() - startedAt.getTime(),
			error,
			trigger,
		});
		const checkInStatus = await reconcileCheckIn(
			checkInStore,
			checkInOccurrence,
			runId,
			"error",
			finishedAt,
			error,
		);
		await jobStore.mutate(job.id, (current) => ({
			lastRunAt: finishedAt.toISOString(),
			lastStatus: "error",
			lastError: error,
			enabled: oneShot ? false : current.enabled,
			runCount: current.runCount + 1,
			failureCount: current.failureCount + 1,
		}));
		return { jobId: job.id, runId, success: false, error, checkInStatus };
	}
}

function checkInRunFields(occurrence: CheckInOccurrence | undefined): Pick<JobRunResult, never> & { occurrenceId?: string; scheduledAt?: string } {
	return occurrence
		? { occurrenceId: occurrence.occurrenceId, scheduledAt: occurrence.scheduledAt }
		: {};
}

async function skipCompletedScheduledOccurrence(
	job: ScheduledJob,
	jobStore: JobStore,
	runId: string,
	occurrence: CheckInOccurrence,
): Promise<JobRunResult> {
	const startedAt = new Date();
	const finishedAt = new Date();
	const output = "计划时段已完成，跳过重复执行。";
	const nextRunAt = computeNextRunAt(job.cron, job.timezone, new Date(occurrence.scheduledAt));
	jobStore.appendRun({
		id: runId,
		jobId: job.id,
		jobName: job.name,
		...checkInRunFields(occurrence),
		status: "skipped",
		startedAt: startedAt.toISOString(),
		finishedAt: finishedAt.toISOString(),
		durationMs: 0,
		outputPreview: output,
		trigger: "scheduled",
	});
	await jobStore.mutate(job.id, (current) => ({
		lastRunAt: finishedAt.toISOString(),
		lastStatus: "skipped",
		lastError: undefined,
		runCount: current.runCount + 1,
		...(nextRunAt ? { nextRunAt } : {}),
	}));
	logger.info({ jobId: job.id, runId, occurrenceId: occurrence.occurrenceId }, "Job run skipped: planned slot already completed");
	return {
		jobId: job.id,
		runId,
		success: true,
		output,
	};
}

async function reconcileCheckIn(
	checkInStore: CheckInStore | undefined,
	occurrence: CheckInOccurrence | undefined,
	runId: string,
	status: "success" | "error" | "skipped",
	finishedAt: Date,
	error: string | undefined,
): Promise<CheckInStatus | undefined> {
	if (!checkInStore || !occurrence) return undefined;
	const result = checkInStore.recordOccurrence({
		occurrenceId: occurrence.occurrenceId,
		jobId: occurrence.jobId,
		scheduledAt: occurrence.scheduledAt,
		status,
		runId,
		finishedAt: finishedAt.toISOString(),
		error,
	});
	return result.status;
}

function formatReminderOutput(prompt: string): string {
	const trimmed = prompt.trim();
	if (!trimmed) return "提醒时间到了。";
	return trimmed
		.replace(/^提醒学习者[：:]\s*/, "")
		.replace(/^提醒我[：:]\s*/, "")
		.trim() || trimmed;
}

function formatCheckInReminderOutput(prompt: string): string {
	const trimmed = prompt.trim();
	return trimmed || "今天还有学习任务未完成。完成今日计划后，学习打卡会自动完成。";
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


/**
 * Best-effort delivery of a short notice through the first registered channel
 * that has a default target (same preference order as reminder pushes). Used
 * so scheduled runs leave a visible trace for the user; failures are logged
 * and swallowed — a notification problem must never fail the job.
 */
export async function pushThroughDefaultChannel(
	channelRegistry: ChannelRegistry,
	text: string,
	scope: { jobId: string; runId: string },
): Promise<string | undefined> {
	for (const name of ["feishu", "wechat", "qq"] as const) {
		const channel = channelRegistry.get(name);
		const target = channelRegistry.getDefaultTarget(name);
		if (!channel || !target) continue;
		try {
			await channel.push(target, text);
			logger.info({ jobId: scope.jobId, runId: scope.runId, channel: name }, "Scheduled run notice pushed");
			return name;
		} catch (err) {
			logger.warn({ err, jobId: scope.jobId, runId: scope.runId, channel: name }, "Scheduled run notice push failed");
			return undefined;
		}
	}
	return undefined;
}