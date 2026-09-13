export type CheckInDayStatus = "no_tasks" | "pending" | "completed";
export type CheckInOccurrenceStatus = "pending" | "success" | "error" | "skipped";

export interface CheckInOccurrence {
	occurrenceId: string;
	jobId: string;
	jobName: string;
	taskType: string;
	scheduledAt: string;
	status: CheckInOccurrenceStatus;
	error?: string;
}

export interface CheckInJobStatus {
	jobId: string;
	jobName: string;
	taskType: string;
	occurrences: CheckInOccurrence[];
}

export interface CheckInStatus {
	today: string;
	timezone: string;
	dayStatus: CheckInDayStatus;
	todayCheckedIn: boolean;
	checkedInAt?: string;
	requiredCount: number;
	completedCount: number;
	remainingCount: number;
	failedCount: number;
	skippedCount: number;
	currentStreak: number;
	longestStreak: number;
	totalCount: number;
	jobs: CheckInJobStatus[];
}
