import { appendJsonl, readJsonl } from "../storage/file-store.js";

export interface ChannelRun {
	runId: string;
	channel: string;
	messageId: string;
	status: "success" | "error";
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	error?: string;
}

let runCounter = 0;

export function generateRunId(): string {
	return `chrun_${Date.now()}_${++runCounter}`;
}

export class ChannelRunLog {
	constructor(private filePath: string) {}

	append(run: ChannelRun): void {
		appendJsonl(this.filePath, run);
	}

	list(limit = 100): ChannelRun[] {
		const all = readJsonl<ChannelRun>(this.filePath);
		return all.slice(-limit);
	}
}
