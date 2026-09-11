export interface ChatMessage {
	role: "user" | "assistant";
	content: string;
	timestamp: number;
	/** PI session-tree entry backing a persisted message. Used to branch the
	 * active conversation immediately before an edited user turn. */
	entryId?: string;
	parentEntryId?: string | null;
	thinking?: string;
	/** PI's persisted assistant termination reason, used for legacy trace replay. */
	stopReason?: string;
	tools?: ChatToolRecord[];
	/** Ordered PI-derived process records. Older messages may only have the
	 * aggregate thinking/tools fields above. */
	trace?: ChatTraceStep[];
	/** Raw normalized stream records persisted in the UI sidecar. Kept separate
	 * from `trace` so the same reducer can rebuild live and historical rows. */
	traceEvents?: ChatTraceEventRecord[];
	traceStartedAt?: string;
	traceFinishedAt?: string;
	channel?: string;
	images?: Array<{ previewUrl: string; mimeType: string }>;
	/** Structured attachments sent with this user turn (keyword-bubble
	 * bindings + loosely attached files). Renders as inline ref-chips. */
	attachments?: ChatAttachments;
	/** Backend/model error surfaced for this turn (e.g. HTTP 413 over-long context). */
	error?: string;
	turnId?: string;
	transient?: boolean;
	complete?: boolean;
}

// --- Structured chat attachments (便捷输入 / plain attachments) ---

export type AttachmentFileKind = "pdf" | "doc" | "xls" | "ppt" | "image" | "file";

export interface AttachmentRef {
	/** Session-workspace-relative path (forward slashes). */
	path: string;
	kind: AttachmentFileKind;
	source: "workspace" | "upload";
}

export interface AttachmentBinding {
	/** The literal keyword the user converted into a bubble. */
	word: string;
	/** Occurrence index of `word` in the visible message text (0-based). */
	wordIndex: number;
	files: AttachmentRef[];
}

export interface ChatAttachments {
	bindings: AttachmentBinding[];
	loose: AttachmentRef[];
}

export interface ChatToolRecord {
	toolCallId: string;
	toolName: string;
	args: unknown;
	/** Character offset in the assistant text at which the tool was called. */
	contentOffset?: number;
	/** Latest partial result while the tool is still running. */
	partialResult?: unknown;
	result?: unknown;
	isError?: boolean;
}

export interface WorkspaceFileChange {
	path: string;
	change: "created" | "modified" | "deleted";
}

export type ChatTraceStepKind = "thinking" | "progress" | "answer" | "tool" | "skill" | "system" | "error";
export type ChatTraceStepStatus = "active" | "preparing" | "running" | "waiting" | "completed" | "error";

/** One visible, expandable row in the PI process timeline. */
export interface ChatTraceStep {
	id: string;
	kind: ChatTraceStepKind;
	status: ChatTraceStepStatus;
	title: string;
	/** Locale key for generated UI titles. `title` remains the fallback/raw text. */
	titleKey?: string;
	titleParams?: Record<string, string | number>;
	text?: string;
	/** A short live summary separate from the full expandable payload. */
	summary?: string;
	toolCallId?: string;
	toolName?: string;
	args?: unknown;
	argsText?: string;
	/** Latest partial result emitted during tool execution. */
	partialResult?: unknown;
	result?: unknown;
	isError?: boolean;
	questionId?: string;
	questionParams?: { questions: QuestionData[] };
	skillName?: string;
	skillArgs?: string;
	skillSource?: string;
	skillPath?: string;
	skillDescription?: string;
	skillState?: "loaded" | "expanded";
	eventType?: string;
	eventPhase?: "start" | "update" | "end";
	eventDetail?: unknown;
	workspaceChanges?: WorkspaceFileChange[];
	attempt?: number;
	contentIndex?: number;
	preparationStartedAt?: number;
	startedAt?: number;
	endedAt?: number;
	durationMs?: number;
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

/** A parked pi-permission-system `ask`, awaiting an approval decision. */
export interface PendingPermission {
	requestId: string;
	source: string;
	surface: string | null;
	value: string | null;
	toolName: string | null;
	command: string | null;
	path: string | null;
	agentName: string | null;
	/** Set when the ask was forwarded from a subagent. */
	forwardedFrom: string | null;
	preview: string | null;
	sessionId?: string;
	turnId?: string;
}

export type PermissionDecisionKind = "allow_once" | "allow_session" | "deny";

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
	attachments?: ChatAttachments;
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
	/** Stable UI trace identity for this PI turn; older servers may omit it. */
	traceId?: string;
	/** Server-side time at which the normalized PI event was published. */
	occurredAt?: string;
	event: ChatStreamEvent;
}

// Turn-scoped SSE event types
export type ChatStreamEvent = (
	| { type: "stream_state"; status: "queued" | "running" }
	| { type: "text_start"; contentIndex?: number }
	| { type: "text_delta"; delta: string; contentIndex?: number }
	| { type: "text_end"; contentIndex?: number }
	| { type: "thinking_start"; contentIndex?: number }
	| { type: "thinking_delta"; delta: string; contentIndex?: number }
	| { type: "thinking_end"; contentIndex?: number }
	| { type: "tool_call_start"; toolCallId: string; toolName: string; contentIndex?: number; args?: unknown }
	| { type: "tool_call_delta"; toolCallId: string; toolName: string; contentIndex?: number; args?: unknown; argsDelta?: string }
		| { type: "tool_call_end"; toolCallId: string; toolName: string; contentIndex?: number; args?: unknown }
		| { type: "tool_start"; toolCallId: string; toolName: string; args?: unknown; contentIndex?: number }
		| { type: "tool_update"; toolCallId: string; toolName: string; args?: unknown; partialResult?: unknown; contentIndex?: number }
		| { type: "tool_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean; contentIndex?: number }
	| { type: "workspace_change"; changes: WorkspaceFileChange[]; toolCallId?: string; toolName?: string; workspaceId?: string; truncated?: boolean }
	| { type: "question"; questionId: string; params: { questions: QuestionData[] }; toolCallId?: string }
	| { type: "question_resolved"; questionId: string; cancelled?: boolean; error?: string }
	| { type: "permission_request"; requestId: string; source?: string; surface?: string | null; value?: string | null; toolName?: string | null; command?: string | null; path?: string | null; agentName?: string | null; forwardedFrom?: string | null; preview?: string | null; turnId?: string }
	| { type: "permission_resolved"; requestId: string; decision?: string; allowed?: boolean }
	| { type: "skill_loaded"; count: number; skills?: Array<{ name: string; description?: string; path?: string; source?: string }> }
	| { type: "skill_invoked"; skillName: string; args?: string; source?: string; path?: string; description?: string }
	| { type: "system_event"; eventType: string; phase?: "start" | "update" | "end"; summary?: string; detail?: unknown; attempt?: number; success?: boolean }
	| { type: "done"; fullText: string; persisted: true; finalMessageCount: number; finalSessionRevision: string }
	| { type: "error"; message: string; code?: string; persisted: boolean; finalMessageCount?: number; finalSessionRevision?: string }
	| { type: "aborted"; message?: string; persisted: boolean; finalMessageCount?: number; finalSessionRevision?: string }
) & {
	/** Original PI event name before the server's UI normalization. */
	piEventType?: string;
};

export interface ChatTraceEventRecord {
	eventId?: number;
	traceId?: string;
	occurredAt?: string;
	event: ChatStreamEvent;
}
