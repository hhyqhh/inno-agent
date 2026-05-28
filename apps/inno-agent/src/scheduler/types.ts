import type { ChannelName, PushTarget } from "../channels/types.js";

export type TaskType =
	| "daily_review"
	| "weekly_summary"
	| "graphify_update"
	| "learner_profile_reflection"
	| "spaced_review"
	| "push_reminder"
	| "custom_prompt";

export type JobRunStatus = "running" | "success" | "error" | "skipped";

export interface ScheduledJob {
	id: string;
	name: string;
	cron: string;
	timezone: string;
	enabled: boolean;
	channel?: ChannelName;
	target?: PushTarget;
	taskType: TaskType;
	prompt: string;
	lastRunAt?: string;
	nextRunAt?: string;
	lastStatus?: JobRunStatus;
	lastError?: string;
	runCount: number;
	failureCount: number;
	createdAt: string;
	updatedAt: string;
}

export interface JobRunRecord {
	id: string;
	jobId: string;
	jobName: string;
	status: JobRunStatus;
	startedAt: string;
	finishedAt?: string;
	durationMs?: number;
	outputPreview?: string;
	error?: string;
	pushedToChannel?: string;
	pushSkippedReason?: string;
	trigger: "scheduled" | "manual" | "api";
}
