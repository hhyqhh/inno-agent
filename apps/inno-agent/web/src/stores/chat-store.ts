import { EventEmitter } from "./event-emitter.js";
import { streamChat, abortChat } from "../api/chat.js";
import type { InlineImage } from "../api/chat.js";
import type { ChatMessage, ChatStreamEvent, ChatToolRecord, PendingQuestion, QuestionnaireResult } from "../types/chat.js";
import { notebookStore } from "./notebook-store.js";

interface ChatStoreEvents {
	change: void;
}

class ChatStoreImpl extends EventEmitter<ChatStoreEvents> {
	messages: ChatMessage[] = [];
	isSending = false;
	/** Set while fetching persisted history for a session. */
	isLoadingHistory = false;
	streamingText = "";
	streamingThinking = "";
	/** Backend/model error for the in-flight turn, surfaced in the UI (collapsible). */
	streamingError = "";
	/** Active tool calls in progress */
	activeTools: ChatToolRecord[] = [];
	completedTools: ChatToolRecord[] = [];
	/** Last user prompt sent, kept so users can Retry. */
	lastUserPrompt: string | null = null;
	/** Images from the last send, kept so users can Retry. */
	lastImages: InlineImage[] | undefined = undefined;
	/** Pending question from agent's ask_user_question tool */
	pendingQuestion: PendingQuestion | null = null;
	/** Prefill chat input (consumed by ChatCenter). */
	prefillInput: string | null = null;
	private abortController: AbortController | null = null;
	private wikiInvalidated = false;

	async send(prompt: string, images?: InlineImage[]): Promise<void> {
		if ((!prompt.trim() && !images?.length) || this.isSending) return;

		// Capture the target session at send time to prevent misalignment
		// if the user switches sessions while the request is queued.
		const { sessionsStore } = await import("./sessions-store.js");
		const targetSessionId = sessionsStore.currentSessionId;

		this.lastUserPrompt = prompt;
		this.lastImages = images;
		this.messages = [...this.messages, {
			role: "user",
			content: prompt,
			timestamp: Date.now(),
			images: images?.map(({ data, mimeType }) => ({
				previewUrl: `data:${mimeType};base64,${data}`,
				mimeType,
			})),
		}];
		this.isSending = true;
		this.streamingText = "";
		this.streamingThinking = "";
		this.streamingError = "";
		this.activeTools = [];
		this.completedTools = [];
		this.wikiInvalidated = false;
		const controller = new AbortController();
		this.abortController = controller;
		this.emit("change", undefined);

		try {
			for await (const event of streamChat(prompt, targetSessionId, controller.signal, images)) {
				this._handleStreamEvent(event);
			}
			const aborted = controller.signal.aborted;
			// Finalize: add accumulated text as assistant message. Also finalize
			// when the turn produced only an error (no text), so the error is
			// preserved in history instead of vanishing when streaming state resets.
			if (this.streamingText || this.streamingError || aborted) {
				this.messages = [
					...this.messages,
					{
						role: "assistant",
						content: aborted && !this.streamingText
							? "[Stopped by user]"
							: this.streamingText + (aborted ? "\n\n[Stopped by user]" : ""),
						timestamp: Date.now(),
						thinking: this.streamingThinking || undefined,
						tools: this.completedTools.length > 0 ? this.completedTools : undefined,
						error: this.streamingError || undefined,
					},
				];
			}
		} catch (err) {
			if (!controller.signal.aborted) {
				const message = err instanceof Error ? err.message : "Unknown error";
				this.messages = [
					...this.messages,
					{ role: "assistant", content: "", timestamp: Date.now(), error: message },
				];
			}
		} finally {
			this.isSending = false;
			this.streamingText = "";
			this.streamingThinking = "";
			this.streamingError = "";
			this.activeTools = [];
			this.completedTools = [];
			this.abortController = null;
			this.pendingQuestion = null;
			const shouldRefreshWiki = this.wikiInvalidated;
			this.wikiInvalidated = false;
			this.emit("change", undefined);
			if (shouldRefreshWiki) {
				// L2 tools mutated the wiki — refresh pages + graph so the
				// Notebook tab reflects the new state without manual reload.
				void notebookStore.loadAll();
				void import("./sources-store.js").then((m) => m.sourcesStore.loadAll());
			}
			// Refresh the sessions sidebar so the current conversation
			// (especially a freshly-created one) appears with its updated
			// preview / message count without a manual page reload.
			//
			// Dynamic import avoids a hard circular-import dependency with
			// sessions-store (which already imports chat-store).
			void import("./sessions-store.js").then((m) => m.sessionsStore.refresh());
		}
	}

	/** Abort the in-flight stream. */
	cancel(): void {
		const wasSending = this.isSending;
		this.abortController?.abort();
		// Aborting the local fetch may not promptly close the upstream connection
		// (dev proxy buffering), so explicitly tell the backend to stop the run.
		// This releases the server's shared prompt queue immediately, preventing
		// new-session / switch-session from blocking behind a still-running turn.
		if (wasSending) void abortChat();
	}

	/** Re-send the last user prompt. No-op while a send is in flight. */
	async retry(): Promise<void> {
		if (this.isSending || !this.lastUserPrompt) return;
		await this.send(this.lastUserPrompt, this.lastImages);
	}

	setPrefillInput(text: string): void {
		this.prefillInput = text;
		this.emit("change", undefined);
	}

	consumePrefillInput(): string | null {
		const value = this.prefillInput;
		this.prefillInput = null;
		return value;
	}

	private _handleStreamEvent(event: ChatStreamEvent) {
		switch (event.type) {
			case "text_delta":
				this.streamingText += event.delta;
				this.emit("change", undefined);
				break;
			case "thinking_delta":
				this.streamingThinking += event.delta;
				this.emit("change", undefined);
				break;
			case "tool_start":
				this.activeTools = [...this.activeTools, {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
				}];
				this.emit("change", undefined);
				break;
			case "tool_end":
				this.completedTools = [
					...this.completedTools,
					{
						...(this.activeTools.find((t) => t.toolCallId === event.toolCallId) ?? {
							toolCallId: event.toolCallId,
							toolName: "tool",
							args: undefined,
						}),
						result: event.result,
						isError: event.isError,
					},
				];
				this.activeTools = this.activeTools.filter(
					(t) => t.toolCallId !== event.toolCallId,
				);
				if (mutatesWiki(event.toolName)) {
					this.wikiInvalidated = true;
				}
				if (event.toolName === "create_practice_lab" && !event.isError) {
					void handlePracticeLabResult(event.result);
				}
				this.emit("change", undefined);
				break;
			case "error":
				// Keep the error separate from the reply text so the UI can render
				// it as a distinct, collapsible block rather than inline markdown.
				this.streamingError = this.streamingError
					? `${this.streamingError}\n${event.message}`
					: event.message;
				this.emit("change", undefined);
				break;
			case "question":
				this.pendingQuestion = {
					questionId: event.questionId,
					params: event.params,
				};
				this.emit("change", undefined);
				break;
			case "done":
				// Final message set with full content
				if (event.fullText) {
					this.streamingText = event.fullText;
				}
				this.emit("change", undefined);
				break;
		}
	}

	async submitQuestionResponse(questionId: string, result: QuestionnaireResult): Promise<void> {
		this.pendingQuestion = null;
		this.emit("change", undefined);
		try {
			await fetch("/api/chat/question-response", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ questionId, result }),
			});
		} catch {
			// best-effort — the agent will time out or get cancelled if this fails
		}
	}

	async dismissQuestion(questionId: string): Promise<void> {
		await this.submitQuestionResponse(questionId, { answers: [], cancelled: true });
	}

	clear() {
		// If a stream is still running, abort it so its finally{} can run and
		// release isSending (otherwise the next .send / new-session attempt
		// is locked behind a permanent isSending=true).
		this.abortController?.abort();
		this.abortController = null;
		this.messages = [];
		this.isSending = false;
		this.streamingText = "";
		this.streamingThinking = "";
		this.streamingError = "";
		this.activeTools = [];
		this.completedTools = [];
		this.pendingQuestion = null;
		this.emit("change", undefined);
	}

	loadHistory(messages: ChatMessage[]) {
		this.messages = messages;
		this.isSending = false;
		this.streamingText = "";
		this.streamingThinking = "";
		this.streamingError = "";
		this.activeTools = [];
		this.completedTools = [];
		this.emit("change", undefined);
	}

	setLoadingHistory(loading: boolean) {
		this.isLoadingHistory = loading;
		this.emit("change", undefined);
	}
}

export const chatStore = new ChatStoreImpl();

/**
 * Tools that modify the L2 wiki/graph. When any of these complete during a
 * chat turn we trigger a refresh of the Wiki list and the knowledge graph
 * so the workspace tabs reflect agent-side writes in real time.
 */
function mutatesWiki(toolName: string): boolean {
	return toolName === "l2_archive" || toolName === "l2_link_pages" || toolName.startsWith("wiki_");
}

/**
 * Reaction to a successful create_practice_lab tool call: refresh the
 * workspace tree, open the main file in the preview panel, and switch the
 * right-side tab to "preview" so the user immediately sees the new lab.
 */
async function handlePracticeLabResult(result: unknown): Promise<void> {
	// Result is the details object as serialized by PI. Be defensive about shape.
	let mainFile: string | undefined;
	if (result && typeof result === "object") {
		const r = result as Record<string, unknown>;
		const details = (r.details && typeof r.details === "object" ? r.details : r) as Record<string, unknown>;
		if (typeof details.mainFile === "string") mainFile = details.mainFile;
	}
	try {
		const { workspaceStore } = await import("./workspace-store.js");
		const { appStore } = await import("./app-store.js");
		appStore.setRightPanelTab("preview");
		await workspaceStore.loadTree();
		if (mainFile) {
			await workspaceStore.selectFile(mainFile);
		}
	} catch {
		// best-effort — non-fatal if any store import fails
	}
}
