export interface ChatMessage {
	role: "user" | "assistant";
	content: string;
	timestamp: number;
	thinking?: string;
	tools?: ChatToolRecord[];
	channel?: string;
}

export interface ChatToolRecord {
	toolCallId: string;
	toolName: string;
	args: unknown;
	result?: unknown;
	isError?: boolean;
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

// Phase 2 SSE event types
export type ChatStreamEvent =
	| { type: "text_delta"; delta: string }
	| { type: "thinking_delta"; delta: string }
	| { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
	| { type: "tool_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
	| { type: "question"; questionId: string; params: { questions: QuestionData[] } }
	| { type: "done"; fullText: string }
	| { type: "error"; message: string };
