import type { JobStore } from "./job-store.js";
import type { ChannelRegistry } from "../channels/channel.js";
import { executeJob } from "./job-runner.js";
import { getCronDueAt } from "./cron-utils.js";
import { deferScheduledRun } from "./deferred-runs.js";
import { isLearningJob, occurrenceIdFor, type CheckInStore } from "../checkins/check-in-store.js";
import { logger } from "../logger.js";

/**
 * In-process cron scheduler.
 * Checks all enabled jobs every 5 seconds and executes any that are due —
 * the cadence bounds how late a reminder can appear after the fire time.
 */
export class CronScheduler {
	private interval: ReturnType<typeof setInterval> | null = null;
	private running = new Set<string>(); // prevent overlapping runs

	constructor(
	private jobStore: JobStore,
	private channelRegistry: ChannelRegistry,
	private checkInStore?: CheckInStore,
	) {}

	/**
	 * Start the scheduler. Checks every 60 seconds.
	 */
	start(): void {
		// Run an initial check after a short delay
		setTimeout(() => this.tick(), 2_000);

		// Then check every 5 seconds
		this.interval = setInterval(() => this.tick(), 5_000);
		logger.info("[scheduler] started, checking jobs every 5s");
	}

	stop(): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}
	}

	private async tick(): Promise<void> {
		const jobs = this.jobStore.list();
		const now = new Date();

		for (const job of jobs) {
			if (!job.enabled) continue;
			if (this.running.has(job.id)) continue; // already running

			const scheduledAt = getCronDueAt(job.cron, job.timezone, job.lastRunAt, now);
			if (scheduledAt) {
				// Interactive (learning) jobs never run headless: notify + arm the
				// short grace period, then auto-execute in a fresh conversation.
				// The defer bookkeeping also suppresses re-firing every tick.
				if (this.checkInStore && isLearningJob(job)) {
					const occurrenceId = occurrenceIdFor(job.id, scheduledAt);
					// Slot already settled today (e.g. completed manually)? Just
					// advance the schedule bookkeeping — never remind again.
					const slot = this.checkInStore.getOccurrence(job.id, occurrenceId, now);
					if (slot && (slot.status === "success" || slot.status === "skipped")) {
						await executeJob(job, this.jobStore, this.channelRegistry, "scheduled", this.checkInStore, {
							scheduledAt,
							occurrenceId,
						});
						continue;
					}
					logger.info({ jobId: job.id, jobName: job.name }, "scheduler deferring learning job for user start");
					deferScheduledRun(job, scheduledAt, occurrenceId);
					continue;
				}
				this.running.add(job.id);
				logger.info({ jobId: job.id, jobName: job.name }, "scheduler executing job");

				executeJob(job, this.jobStore, this.channelRegistry, "scheduled", this.checkInStore, {
					scheduledAt,
					occurrenceId: this.checkInStore ? occurrenceIdFor(job.id, scheduledAt) : undefined,
				})
					.then((result) => {
						if (result.success) {
							logger.info({ jobId: job.id, pushedToChannel: result.pushedToChannel }, "scheduler job completed");
						} else {
							logger.error({ jobId: job.id, error: result.error }, "scheduler job failed");
						}
					})
					.catch((err) => {
						logger.error({ err, jobId: job.id }, "scheduler job error");
					})
					.finally(() => {
						this.running.delete(job.id);
					});
			}
		}
	}
}
