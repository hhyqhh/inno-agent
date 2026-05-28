import type { JobStore } from "./job-store.js";
import type { ChannelRegistry } from "../channels/channel.js";
import { executeJob } from "./job-runner.js";
import { isCronDue } from "./cron-utils.js";

/**
 * In-process cron scheduler.
 * Checks all enabled jobs every 60 seconds and executes any that are due.
 */
export class CronScheduler {
	private interval: ReturnType<typeof setInterval> | null = null;
	private running = new Set<string>(); // prevent overlapping runs

	constructor(
		private jobStore: JobStore,
		private channelRegistry: ChannelRegistry,
	) {}

	/**
	 * Start the scheduler. Checks every 60 seconds.
	 */
	start(): void {
		// Run an initial check after a short delay
		setTimeout(() => this.tick(), 5_000);

		// Then check every 60 seconds
		this.interval = setInterval(() => this.tick(), 60_000);
		console.log("[scheduler] started, checking jobs every 60s");
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

			if (isCronDue(job.cron, job.timezone, job.lastRunAt, now)) {
				this.running.add(job.id);
				console.log(`[scheduler] executing job: ${job.name} (${job.id})`);

				executeJob(job, this.jobStore, this.channelRegistry, "scheduled")
					.then((result) => {
						if (result.success) {
							console.log(`[scheduler] job ${job.id} completed${result.pushedToChannel ? `, pushed to ${result.pushedToChannel}` : ""}`);
						} else {
							console.error(`[scheduler] job ${job.id} failed: ${result.error}`);
						}
					})
					.catch((err) => {
						console.error(`[scheduler] job ${job.id} error:`, err);
					})
					.finally(() => {
						this.running.delete(job.id);
					});
			}
		}
	}
}
