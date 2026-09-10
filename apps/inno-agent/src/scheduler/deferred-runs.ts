import type { ChannelRegistry } from "../channels/channel.js";
import type { CheckInStore } from "../checkins/check-in-store.js";
import { logger } from "../logger.js";
import { executeJob, pushThroughDefaultChannel } from "./job-runner.js";
import type { JobStore } from "./job-store.js";
import type { ScheduledJob } from "./types.js";

/** Grace period between the scheduled fire time and auto-execution. */
const AUTO_EXECUTE_DELAY_MS = 15_000;

export interface DeferredRun {
	jobId: string;
	jobName: string;
	occurrenceId: string;
	scheduledAt: string;
	/** ISO instant after which the run auto-executes in a new conversation. */
	deadline: string;
}

export interface DeferredRunWiring {
	jobStore: JobStore;
	channelRegistry: ChannelRegistry;
	checkInStore?: CheckInStore;
	/** Create the conversation the auto-executed run will live in. */
	createSession: () => Promise<string | null>;
}

const wiring: { current: DeferredRunWiring | null } = { current: null };
const pending = new Map<string, DeferredRun & { timer: ReturnType<typeof setTimeout> }>();
const executing = new Set<string>();

export function configureDeferredRuns(next: DeferredRunWiring): void {
	wiring.current = next;
}

export function listDeferredRuns(): DeferredRun[] {
	return [...pending.values()].map(({ timer: _timer, ...run }) => run);
}

/** True while the auto-execution for this slot is already running. */
export function isDeferredExecuting(occurrenceId: string): boolean {
	return executing.has(occurrenceId);
}

export function cancelDeferredRun(occurrenceId: string): DeferredRun | undefined {
	const run = pending.get(occurrenceId);
	if (!run) return undefined;
	pending.delete(occurrenceId);
	clearTimeout(run.timer);
	logger.info({ jobId: run.jobId, occurrenceId }, "Deferred scheduled run cancelled");
	return run;
}

/**
 * Interactive scheduled learning jobs do not execute headless: firing arms a
 * short grace period (notify + in-app banner), then auto-executes in a fresh
 * conversation unless the user started it early or skipped the slot.
 */
export function deferScheduledRun(job: ScheduledJob, scheduledAt: string, occurrenceId: string): void {
	const cfg = wiring.current;
	if (!cfg) return;
	// A client takeover claims the slot for its streamed run — never re-arm
	// while it is being handled or already fulfilled.
	if (cfg.checkInStore?.isOccurrenceClaimed(occurrenceId)) return;
	if (pending.has(occurrenceId) || executing.has(occurrenceId)) return;
	void pushThroughDefaultChannel(
		cfg.channelRegistry,
		`🔔 定时任务「${job.name}」已就绪，${AUTO_EXECUTE_DELAY_MS / 1000} 秒后自动开始（打开应用可立即执行或跳过）`,
		{ jobId: job.id, runId: occurrenceId },
	);
	const timer = setTimeout(() => {
		pending.delete(occurrenceId);
		void autoExecute(job, scheduledAt, occurrenceId);
	}, AUTO_EXECUTE_DELAY_MS);
	pending.set(occurrenceId, {
		jobId: job.id,
		jobName: job.name,
		occurrenceId,
		scheduledAt,
		deadline: new Date(Date.now() + AUTO_EXECUTE_DELAY_MS).toISOString(),
		timer,
	});
	logger.info({ jobId: job.id, occurrenceId, deadline: new Date(Date.now() + AUTO_EXECUTE_DELAY_MS).toISOString() }, "Deferred scheduled run armed");
}

async function autoExecute(job: ScheduledJob, scheduledAt: string, occurrenceId: string): Promise<void> {
	const cfg = wiring.current;
	if (!cfg) return;
	// The user may have settled the slot manually while the timer ran.
	if (cfg.checkInStore) {
		const occurrence = cfg.checkInStore.getOccurrence(job.id, occurrenceId);
		if (occurrence && (occurrence.status === "success" || occurrence.status === "skipped")) {
			logger.info({ jobId: job.id, occurrenceId, status: occurrence.status }, "Deferred run obsolete: slot already settled");
			return;
		}
	}
	executing.add(occurrenceId);
	try {
		const sessionPath = await cfg.createSession();
		if (!sessionPath) {
			logger.error({ jobId: job.id, occurrenceId }, "Deferred run aborted: could not create session");
			return;
		}
		const result = await executeJob(job, cfg.jobStore, cfg.channelRegistry, "scheduled", cfg.checkInStore, {
			sessionPath,
			scheduledAt,
			occurrenceId,
		});
		logger.info({ jobId: job.id, occurrenceId, runId: result.runId, success: result.success }, "Deferred scheduled run auto-executed");
		// A fulfilled slot stays claimed; a failed one is released so the
		// check-in card can retry it.
		if (!result.success) cfg.checkInStore?.releaseOccurrenceClaim(occurrenceId);
	} catch (err) {
		logger.error({ err, jobId: job.id, occurrenceId }, "Deferred scheduled run failed");
		cfg.checkInStore?.releaseOccurrenceClaim(occurrenceId);
	} finally {
		executing.delete(occurrenceId);
	}
}
