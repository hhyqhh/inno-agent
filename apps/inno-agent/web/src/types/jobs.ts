export type TaskType =
	| "daily_review"
	| "weekly_summary"
	| "graphify_update"
	| "learner_profile_reflection"
	| "spaced_review"
	| "push_reminder"
	| "custom_prompt";

export interface ScheduledJob {
	id: string;
	name: string;
	cron: string;
	timezone: string;
	enabled: boolean;
	channel?: string;
	target?: unknown;
	taskType: TaskType;
	prompt: string;
	lastRunAt?: string;
	nextRunAt?: string;
	createdAt: string;
	updatedAt: string;
}

export type CreateJobInput = Omit<ScheduledJob, "id" | "createdAt" | "updatedAt" | "lastRunAt" | "nextRunAt">;

export const TASK_TYPE_LABELS: Record<TaskType, string> = {
	daily_review: "Daily Review",
	weekly_summary: "Weekly Summary",
	graphify_update: "Graph Update",
	learner_profile_reflection: "Profile Reflection",
	spaced_review: "Spaced Review",
	push_reminder: "Push Reminder",
	custom_prompt: "Custom Prompt",
};
