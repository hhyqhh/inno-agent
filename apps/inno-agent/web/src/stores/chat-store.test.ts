import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	streamChat: vi.fn(),
	abortChat: vi.fn(),
	getChatStatus: vi.fn(),
	streamSessionEvents: vi.fn(),
	submitChatQuestion: vi.fn(),
	getSession: vi.fn(),
	refresh: vi.fn(),
	refreshUntilTopic: vi.fn(),
}));

vi.mock("../api/chat.js", () => ({
	streamChat: mocks.streamChat,
	abortChat: mocks.abortChat,
	getChatStatus: mocks.getChatStatus,
	streamSessionEvents: mocks.streamSessionEvents,
	submitChatQuestion: mocks.submitChatQuestion,
}));

vi.mock("../api/sessions.js", () => ({ getSession: mocks.getSession }));
vi.mock("./sessions-store.js", () => ({ sessionsStore: { currentSessionId: "session.jsonl", refresh: mocks.refresh, refreshUntilTopic: mocks.refreshUntilTopic } }));
vi.mock("./notebook-store.js", () => ({ notebookStore: { loadAll: vi.fn() } }));
vi.mock("./app-store.js", () => ({
	appStore: {
		workspaceWidth: 640,
		workspaceMode: "half",
		setRightPanelTab: vi.fn(),
		setWorkspaceWidth: vi.fn(),
		setWorkspaceMode: vi.fn(),
	},
}));
vi.mock("./workspace-store.js", () => ({
	workspaceStore: {
		streamingPreview: null,
		clearStreamingPreview: vi.fn(),
		finishStreamingPreview: vi.fn(),
		updateStreamingPreview: vi.fn(),
		startStreamingPreview: vi.fn(),
		loadTree: vi.fn(),
		selectFile: vi.fn(),
	},
}));

import { ChatStoreImpl } from "./chat-store.js";
import type { ChatStreamEvent, QuestionnaireResult, StreamEventEnvelope } from "../types/chat.js";
import { answeredQuestionnaireFromTool } from "../utils/questionnaire.js";

const CLIENT_REQUEST_ID = "00000000-0000-4000-8000-000000000001";

function envelope(eventId: number, event: ChatStreamEvent): StreamEventEnvelope {
	return {
		eventId,
		sessionId: "session.jsonl",
		turnId: "turn-1",
		clientRequestId: CLIENT_REQUEST_ID,
		event,
	};
}

function activeSnapshot() {
	return {
		found: true,
		stream: {
			sessionId: "session.jsonl",
			turnId: "turn-1",
			clientRequestId: CLIENT_REQUEST_ID,
			workspaceId: "workspace-1",
			status: "running" as const,
			createdAt: new Date().toISOString(),
			inputSnapshot: { prompt: "hello", submittedAt: new Date().toISOString(), images: [] },
			activeTools: [],
			lastEventId: 3,
			cancelRequested: false,
			baselineMessageCount: 0,
			baselineSessionRevision: "0:0",
			persisted: false,
		},
	};
}

describe("ChatStore stream ownership", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(CLIENT_REQUEST_ID);
		mocks.abortChat.mockResolvedValue(undefined);
		mocks.submitChatQuestion.mockResolvedValue({ accepted: true });
		mocks.getChatStatus.mockResolvedValue(activeSnapshot());
		mocks.getSession.mockResolvedValue({ messages: [], messageCount: 0, sessionRevision: "0:0" });
	});

	it("keeps the owner while a scoped cancellation waits for its terminal event", async () => {
		let releaseTerminal!: () => void;
		const terminalReady = new Promise<void>((resolve) => { releaseTerminal = resolve; });
		mocks.streamChat.mockImplementation(async function* () {
			yield envelope(1, { type: "stream_state", status: "queued" });
			await terminalReady;
			yield envelope(2, { type: "aborted", message: "Stopped", persisted: false });
		});

		const store = new ChatStoreImpl();
		const sending = store.send("hello");
		await vi.waitFor(() => expect(store.isSending).toBe(true));
		store.cancel();
		await vi.waitFor(() => expect(mocks.abortChat).toHaveBeenCalledWith("session.jsonl", "turn-1"));
		expect(store.isSending).toBe(true);
		releaseTerminal();
		await sending;
		expect(store.isSending).toBe(false);
		expect(store.messages.at(-1)).toMatchObject({ role: "assistant", transient: true, complete: false });
	});

	it("uses the last cursor for transient reconnect without clearing accumulated text", async () => {
		mocks.streamChat.mockImplementation(async function* () {
			yield envelope(1, { type: "stream_state", status: "queued" });
			yield envelope(2, { type: "stream_state", status: "running" });
			yield envelope(3, { type: "text_delta", delta: "A" });
			throw new Error("network lost");
		});
		mocks.streamSessionEvents.mockImplementation(async function* () {
			yield envelope(4, { type: "text_delta", delta: "B" });
			yield envelope(5, { type: "aborted", message: "Stopped", persisted: false });
		});

		const store = new ChatStoreImpl();
		await store.send("hello");
		expect(mocks.streamSessionEvents).toHaveBeenCalledWith("session.jsonl", "turn-1", 3, expect.any(AbortSignal));
		expect(store.messages.at(-1)).toMatchObject({ role: "assistant", content: "AB", transient: true });
	});

	it("records where a tool call interrupted the assistant text", async () => {
		mocks.streamChat.mockImplementation(async function* () {
			yield envelope(1, { type: "stream_state", status: "running" });
			yield envelope(2, { type: "text_delta", delta: "before" });
			yield envelope(3, { type: "tool_start", toolCallId: "question-1", toolName: "ask_user_question", args: { questions: [] } });
			yield envelope(4, { type: "tool_end", toolCallId: "question-1", toolName: "ask_user_question", result: {}, isError: false });
			yield envelope(5, { type: "aborted", message: "Stopped", persisted: false });
		});

		const store = new ChatStoreImpl();
		await store.send("hello");

		expect(store.messages.at(-1)?.tools?.[0]).toMatchObject({
			toolCallId: "question-1",
			contentOffset: 6,
		});
	});

	it("materializes the full answered questionnaire as soon as it is submitted", async () => {
		let releaseTool!: () => void;
		const toolFinished = new Promise<void>((resolve) => { releaseTool = resolve; });
		const params = {
			questions: [{
				question: "Choose one",
				header: "Choice",
				options: [
					{ label: "A", description: "First" },
					{ label: "B", description: "Second" },
				],
			}],
		};
		const result: QuestionnaireResult = {
			answers: [{ questionIndex: 0, question: "Choose one", kind: "option", answer: "B" }],
			cancelled: false,
		};
		mocks.streamChat.mockImplementation(async function* () {
			yield envelope(1, { type: "stream_state", status: "running" });
			yield envelope(2, { type: "text_delta", delta: "before" });
			yield envelope(3, { type: "tool_start", toolCallId: "question-tool", toolName: "ask_user_question", args: params });
			yield envelope(4, { type: "question", questionId: "question-card", params });
			await toolFinished;
			yield envelope(5, { type: "tool_end", toolCallId: "question-tool", toolName: "ask_user_question", result, isError: false });
			yield envelope(6, { type: "aborted", message: "Stopped", persisted: false });
		});

		const store = new ChatStoreImpl();
		const sending = store.send("hello");
		await vi.waitFor(() => expect(store.pendingQuestion?.questionId).toBe("question-card"));
		await store.submitQuestionResponse("question-card", result);

		expect(store.pendingQuestion).toBeNull();
		expect(store.activeTools).toHaveLength(0);
		expect(store.completedTools).toHaveLength(1);
		expect(answeredQuestionnaireFromTool(store.completedTools[0]!)).toEqual({
			questions: params.questions,
			result,
		});

		releaseTool();
		await sending;
	});

	it("restores the pending question when the submit fails before tool_end", async () => {
		let releaseTool!: () => void;
		let rejectSubmit!: (err: Error) => void;
		const toolFinished = new Promise<void>((resolve) => { releaseTool = resolve; });
		mocks.submitChatQuestion.mockReturnValue(new Promise((_, reject) => { rejectSubmit = reject; }));
		const params = {
			questions: [{
				question: "Choose one",
				header: "Choice",
				options: [{ label: "A", description: "First" }, { label: "B", description: "Second" }],
			}],
		};
		const result: QuestionnaireResult = {
			answers: [{ questionIndex: 0, question: "Choose one", kind: "option", answer: "B" }],
			cancelled: false,
		};
		mocks.streamChat.mockImplementation(async function* () {
			yield envelope(1, { type: "stream_state", status: "running" });
			yield envelope(2, { type: "tool_start", toolCallId: "question-tool", toolName: "ask_user_question", args: params });
			yield envelope(3, { type: "question", questionId: "question-card", params });
			await toolFinished;
			yield envelope(4, { type: "tool_end", toolCallId: "question-tool", toolName: "ask_user_question", result, isError: false });
			yield envelope(5, { type: "aborted", message: "Stopped", persisted: false });
		});

		const store = new ChatStoreImpl();
		const sending = store.send("hello");
		await vi.waitFor(() => expect(store.pendingQuestion?.questionId).toBe("question-card"));
		const submitting = store.submitQuestionResponse("question-card", result);
		await vi.waitFor(() => expect(store.completedTools).toHaveLength(1));
		rejectSubmit(new Error("network down"));
		await submitting;

		expect(store.pendingQuestion?.questionId).toBe("question-card");
		expect(store.completedTools).toHaveLength(0);
		expect(store.activeTools.map((tool) => tool.toolCallId)).toEqual(["question-tool"]);
		expect(store.streamingError).toBe("network down");

		releaseTool();
		await sending;
	});

	it("keeps the completed card when tool_end lands before a failed submit", async () => {
		let releaseTool!: () => void;
		let rejectSubmit!: (err: Error) => void;
		const toolFinished = new Promise<void>((resolve) => { releaseTool = resolve; });
		mocks.submitChatQuestion.mockReturnValue(new Promise((_, reject) => { rejectSubmit = reject; }));
		const params = {
			questions: [{
				question: "Choose one",
				header: "Choice",
				options: [{ label: "A", description: "First" }, { label: "B", description: "Second" }],
			}],
		};
		const result: QuestionnaireResult = {
			answers: [{ questionIndex: 0, question: "Choose one", kind: "option", answer: "B" }],
			cancelled: false,
		};
		mocks.streamChat.mockImplementation(async function* () {
			yield envelope(1, { type: "stream_state", status: "running" });
			yield envelope(2, { type: "tool_start", toolCallId: "question-tool", toolName: "ask_user_question", args: params });
			yield envelope(3, { type: "question", questionId: "question-card", params });
			await toolFinished;
			yield envelope(4, { type: "tool_end", toolCallId: "question-tool", toolName: "ask_user_question", result, isError: false });
			yield envelope(5, { type: "aborted", message: "Stopped", persisted: false });
		});

		const store = new ChatStoreImpl();
		const sending = store.send("hello");
		await vi.waitFor(() => expect(store.pendingQuestion?.questionId).toBe("question-card"));
		const submitting = store.submitQuestionResponse("question-card", result);
		releaseTool();
		// tool_end arrives while the answer POST is still in flight: the server
		// has already consumed the answer, so a client-side failure must not
		// resurrect the editable question. Wait for the stream to settle so the
		// trailing aborted event cannot overwrite the submit error.
		await sending;
		expect(store.messages.at(-1)?.tools).toHaveLength(1);
		rejectSubmit(new Error("network down"));
		await submitting;

		expect(store.pendingQuestion).toBeNull();
		expect(store.activeTools).toHaveLength(0);
		expect(store.messages.at(-1)?.tools?.[0]?.result).toEqual(result);
		expect(store.streamingError).toBe("network down");
	});

	it("does not replace a transient turn with stale canonical history", async () => {
		vi.useFakeTimers();
		try {
			mocks.streamChat.mockImplementation(async function* () {
				yield envelope(1, { type: "stream_state", status: "queued" });
				yield envelope(2, { type: "stream_state", status: "running" });
				yield envelope(3, { type: "text_delta", delta: "new reply" });
				yield envelope(4, { type: "done", fullText: "new reply", persisted: true, finalMessageCount: 4, finalSessionRevision: "4:4" });
			});
			mocks.getSession.mockResolvedValue({
				messages: [{ role: "assistant", content: "old", timestamp: 1 }],
				messageCount: 1,
				sessionRevision: "1:1",
			});

			const store = new ChatStoreImpl();
			const sending = store.send("hello");
			await vi.waitFor(() => expect(mocks.getSession).toHaveBeenCalled());
			await vi.runAllTimersAsync();
			await sending;
			expect(store.isSending).toBe(true);
			expect(store.canReconnect).toBe(true);
			expect(store.messages[0]).toMatchObject({ role: "user", content: "hello", transient: true });
			expect(store.streamingText).toBe("new reply");
			store.detach();
		} finally {
			vi.useRealTimers();
		}
	});

	it("pins a welcome-screen send and its images to the newly created session", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		mocks.streamChat.mockImplementation(async function* () {
			await gate;
		});
		const images = [{ data: "aW1hZ2U=", mimeType: "image/png" }];
		const store = new ChatStoreImpl();
		const sending = store.send("describe", images, "created-session.jsonl");

		await vi.waitFor(() => expect(mocks.streamChat).toHaveBeenCalled());
		expect(mocks.streamChat).toHaveBeenCalledWith(
			"describe",
			"created-session.jsonl",
			CLIENT_REQUEST_ID,
			expect.any(AbortSignal),
			images,
		);

		store.detach();
		release();
		await sending;
	});

	it("rechecks isSending after the async session-store import", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		mocks.streamChat.mockImplementation(async function* () {
			await gate;
		});
		const store = new ChatStoreImpl();
		const first = store.send("first");
		const second = store.send("second");

		await vi.waitFor(() => expect(mocks.streamChat).toHaveBeenCalledTimes(1));
		expect(store.messages.filter((message) => message.role === "user")).toHaveLength(1);

		store.detach();
		release();
		await Promise.all([first, second]);
	});
});
