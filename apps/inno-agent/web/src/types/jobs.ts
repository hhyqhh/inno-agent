export type TaskType =
	| "daily_review"
	| "weekly_summary"
	| "graphify_update"
	| "learner_profile_reflection"
	| "spaced_review"
	| "check_in_reminder"
	| "push_reminder"
	| "custom_prompt";

/** Keep the UI grouping aligned with the server-side learning plan. */
export function requiresCheckIn(taskType: TaskType): boolean {
	return taskType !== "push_reminder" && taskType !== "check_in_reminder";
}

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

export interface JobRunResult {
	jobId: string;
	success: boolean;
	output?: string;
	error?: string;
	pushedToChannel?: string;
	runId: string;
	checkInStatus?: import("./checkins.js").CheckInStatus;
}

/** Normalized events emitted while a manual job run is streaming to chat. */
export type JobRunStreamEvent =
	| { type: "job_state"; status: "queued" | "running" }
	| { type: "text_start"; contentIndex?: number }
	| { type: "text_delta"; delta: string; contentIndex?: number }
	| { type: "text_end"; contentIndex?: number }
	| { type: "thinking_start"; contentIndex?: number }
	| { type: "thinking_delta"; delta: string; contentIndex?: number }
	| { type: "thinking_end"; contentIndex?: number }
	| { type: "tool_start"; toolCallId: string; toolName: string; args?: unknown }
	| { type: "tool_update"; toolCallId: string; toolName: string; args?: unknown; partialResult?: unknown }
	| { type: "tool_end"; toolCallId: string; toolName: string; result?: unknown; isError?: boolean }
	| { type: "question"; questionId: string; params: { questions: import("./chat.js").QuestionData[] }; turnId?: string; toolCallId?: string }
	| { type: "question_resolved"; questionId: string; cancelled?: boolean; error?: string }
	| { type: "permission_request"; requestId: string; source?: string; surface?: string | null; value?: string | null; toolName?: string | null; command?: string | null; path?: string | null; agentName?: string | null; forwardedFrom?: string | null; preview?: string | null; turnId?: string }
	| { type: "permission_resolved"; requestId: string; decision?: string; allowed?: boolean }
	| { type: "job_result"; result: JobRunResult }
	| { type: "error"; message: string };

export type CreateJobInput = Omit<ScheduledJob, "id" | "createdAt" | "updatedAt" | "lastRunAt" | "nextRunAt">;

export const TASK_TYPE_LABELS: Record<TaskType, string> = {
	daily_review: "Daily Review",
	weekly_summary: "Weekly Summary",
	graphify_update: "Graph Update",
	learner_profile_reflection: "Profile Reflection",
	spaced_review: "Spaced Review",
	check_in_reminder: "Check-in Reminder",
	push_reminder: "Push Reminder",
	custom_prompt: "Custom Prompt",
};
