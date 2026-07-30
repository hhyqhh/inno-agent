export interface ChatMessage {
	role: "user" | "assistant";
	content: string;
	timestamp: number;
	thinking?: string;
	tools?: ChatToolRecord[];
	channel?: string;
	images?: Array<{ previewUrl: string; mimeType: string }>;
	/** Backend/model error surfaced for this turn (e.g. HTTP 413 over-long context). */
	error?: string;
	turnId?: string;
	transient?: boolean;
	complete?: boolean;
}

export interface ChatToolRecord {
	toolCallId: string;
	toolName: string;
	args: unknown;
	result?: unknown;
	isError?: boolean;
}

export interface WorkspaceFileChange {
	path: string;
	change: "created" | "modified" | "deleted";
}

// --- Question types ---

export interface QuestionOption {
	label: string;
	description: string;
	preview?: string;
}

export interface QuestionData {
	question: string;
	header: string;
	options: QuestionOption[];
	multiSelect?: boolean;
}

export interface PendingQuestion {
	questionId: string;
	params: { questions: QuestionData[] };
	/** Scope of the turn that asked the question. Present on restored cards so
	 *  the answer can still be submitted after a restart (the backend consumes
	 *  the persisted card and asks the client to resend it as a fresh turn). */
	sessionId?: string;
	turnId?: string;
	/** True when the card was restored from server-side persistence rather
	 *  than received from a live stream. */
	restored?: boolean;
}

export interface QuestionAnswer {
	questionIndex: number;
	question: string;
	kind: "option" | "custom" | "chat" | "multi";
	answer: string | null;
	selected?: string[];
	notes?: string;
	preview?: string;
}

export interface QuestionnaireResult {
	answers: QuestionAnswer[];
	cancelled: boolean;
	error?: string;
}

export type StreamStatus = "queued" | "running" | "completed" | "error" | "aborted";

export interface StreamInputSnapshot {
	prompt: string;
	submittedAt: string;
	images: Array<{ mimeType: string; workspacePath: string; previewUrl?: string }>;
}

export interface StreamSnapshot {
	sessionId: string;
	turnId: string;
	clientRequestId: string;
	workspaceId: string;
	status: StreamStatus;
	createdAt: string;
	startedAt?: string;
	finishedAt?: string;
	inputSnapshot: StreamInputSnapshot;
	activeTools: ChatToolRecord[];
	pendingQuestion?: PendingQuestion;
	lastEventId: number;
	cancelRequested: boolean;
	baselineMessageCount: number;
	baselineSessionRevision: string;
	persisted: boolean;
	finalMessageCount?: number;
	finalSessionRevision?: string;
}

export interface StreamEventEnvelope {
	eventId: number;
	sessionId: string;
	turnId: string;
	clientRequestId: string;
	event: ChatStreamEvent;
}

// Turn-scoped SSE event types
export type ChatStreamEvent =
	| { type: "stream_state"; status: "queued" | "running" }
	| { type: "text_delta"; delta: string }
	| { type: "thinking_delta"; delta: string }
	| { type: "tool_call_delta"; toolCallId: string; toolName: string; args?: unknown; argsDelta?: string }
	| { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
	| { type: "tool_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
	| { type: "workspace_change"; changes: WorkspaceFileChange[]; toolCallId?: string; toolName?: string; workspaceId?: string; truncated?: boolean }
	| { type: "question"; questionId: string; params: { questions: QuestionData[] } }
	| { type: "question_resolved"; questionId: string; cancelled?: boolean; error?: string }
	| { type: "done"; fullText: string; persisted: true; finalMessageCount: number; finalSessionRevision: string }
	| { type: "error"; message: string; code?: string; persisted: boolean; finalMessageCount?: number; finalSessionRevision?: string }
	| { type: "aborted"; message?: string; persisted: boolean; finalMessageCount?: number; finalSessionRevision?: string };
