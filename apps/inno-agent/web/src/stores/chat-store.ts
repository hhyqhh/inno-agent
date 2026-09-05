import { EventEmitter } from "./event-emitter.js";
import { streamChat, abortChat, getChatStatus, streamSessionEvents, submitChatQuestion, formatQuestionnaireAsPrompt } from "../api/chat.js";
import type { InlineImage } from "../api/chat.js";
import type { ChatAttachments, ChatMessage, ChatStreamEvent, ChatToolRecord, PendingQuestion, QuestionnaireResult, StreamEventEnvelope, StreamSnapshot, WorkspaceFileChange } from "../types/chat.js";
import { notebookStore } from "./notebook-store.js";
import { appStore } from "./app-store.js";
import { workspaceStore, type StreamingWorkspacePreview } from "./workspace-store.js";
import { ensureWindowForPanel } from "./window-expansion.js";

function hasAttachmentFiles(attachments?: ChatAttachments): boolean {
	return Boolean(attachments && (attachments.bindings.some((binding) => binding.files.length > 0) || attachments.loose.length > 0));
}

function createClientRequestId(): string {
	try {
		if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
	} catch {
		// randomUUID is unavailable in some non-secure or embedded browser contexts.
	}

	const bytes = new Uint8Array(16);
	try {
		if (typeof globalThis.crypto?.getRandomValues === "function") globalThis.crypto.getRandomValues(bytes);
		else throw new Error("Web Crypto unavailable");
	} catch {
		for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256);
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type StreamingTarget = "chat" | "workspace";

// Flush interval for streaming text/thinking updates. 40ms (~25fps) is the
// floor for motion to read as continuous rather than stepped; rendering cost
// per flush is bounded by the block-split in StreamingBubbles (only the
// incomplete tail re-parses), so a faster cadence is affordable.
const STREAM_CHANGE_INTERVAL_MS = 40;

type StreamingPreviewPatch = Partial<Pick<StreamingWorkspacePreview, "title" | "path" | "language" | "content" | "status" | "stage">>;

interface ChatStoreEvents {
	change: void;
}

interface ActiveStreamOwner {
	sessionId: string;
	clientRequestId: string;
	turnId: string | null;
	generation: number;
	controller: AbortController;
	lastAppliedEventId: number;
	cancellationRequested: boolean;
	terminalEvent?: TerminalChatStreamEvent;
	phase: "submitting" | "streaming" | "cancelling" | "reconnecting" | "reloading_history";
}

type TerminalChatStreamEvent = Extract<ChatStreamEvent, { type: "done" | "error" | "aborted" }>;

const RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000] as const;

export class ChatStoreImpl extends EventEmitter<ChatStoreEvents> {
	messages: ChatMessage[] = [];
	isSending = false;
	/** Set while fetching persisted history for a session. */
	isLoadingHistory = false;
	streamingText = "";
	streamingThinking = "";
	streamingTarget: StreamingTarget = "chat";
	streamingActivity = "";
	streamingActivityDetail = "";
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
	/** Question IDs the user has already answered. Suppresses stale replays
	 *  (backend may re-push a question event before the answer POST lands) and
	 *  guards restored cards against reappearing from a stale cache. */
	private answeredQuestionIds = new Set<string>();
	/** Tool calls swapped to a completed questionnaire card before the answer
	 *  POST returned. tool_end removes the id; a submit failure may only roll
	 *  the card back while the id is still here — once tool_end landed, the
	 *  server already consumed the answer and restoring the editable card
	 *  would resurrect a resolved question. */
	private optimisticQuestionToolIds = new Set<string>();
	canReconnect = false;
	private wikiInvalidated = false;
	private streamChangeTimer: ReturnType<typeof setTimeout> | null = null;
	private workspacePreviewId: string | null = null;
	private fileToolPaths = new Map<string, string>();
	private fileToolArgText = new Map<string, string>();
	private completedFileToolIds = new Set<string>();
	private previewChangeTimer: ReturnType<typeof setTimeout> | null = null;
	private pendingPreviewUpdate: { id: string; patch: StreamingPreviewPatch } | null = null;
	private activeOwner: ActiveStreamOwner | null = null;
	private ownerGeneration = 0;
	private currentSessionContext: string | null = null;
	private retryInputBySession = new Map<string, { prompt: string; images?: InlineImage[]; attachments?: ChatAttachments }>();

	async send(prompt: string, images?: InlineImage[], sessionIdOverride?: string | null, attachments?: ChatAttachments): Promise<void> {
		if ((!prompt.trim() && !images?.length && !hasAttachmentFiles(attachments)) || this.isSending) return;
		const { sessionsStore } = await import("./sessions-store.js");
		const targetSessionId = sessionIdOverride === undefined
			? sessionsStore.currentSessionId
			: sessionIdOverride;
		if (!targetSessionId || this.isSending) return;

		this.currentSessionContext = targetSessionId;
		this.retryInputBySession.set(targetSessionId, { prompt, images, attachments });
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
			attachments,
			transient: true,
			complete: false,
		}];
		this.resetTransientStreamState();
		this.isSending = true;
		this.setStreamingActivity("正在分析请求");
		this.wikiInvalidated = false;
		const controller = new AbortController();
		const owner: ActiveStreamOwner = {
			sessionId: targetSessionId,
			clientRequestId: createClientRequestId(),
			turnId: null,
			generation: ++this.ownerGeneration,
			controller,
			lastAppliedEventId: 0,
			cancellationRequested: false,
			phase: "submitting",
		};
		this.activeOwner = owner;
		this.emit("change", undefined);

		try {
			for await (const envelope of streamChat(prompt, targetSessionId, owner.clientRequestId, controller.signal, images, attachments)) {
				await this._handleStreamEnvelope(owner, envelope);
			}
			if (this.owns(owner) && !owner.terminalEvent) {
				await this.reconnectOwner(owner, new Error("实时连接提前结束"));
			}
		} catch (err) {
			if (!this.owns(owner) || owner.controller.signal.aborted || owner.terminalEvent) return;
			const bound = await this.bindOwnerFromStatus(owner);
			if (!this.owns(owner)) return;
			if (!bound) {
				const message = err instanceof Error ? err.message : "提交请求失败";
				this.materializeTransientTurn(owner, message);
				this.finalizeOwner(owner);
				return;
			}
			await this.reconnectOwner(owner, err);
		}
	}

	/**
	 * Abort the in-flight stream. Called when user clicks the stop button —
	 * the only path that actually stops the backend task.
	 */
	cancel(): void {
		const owner = this.activeOwner;
		if (!owner) return;
		owner.cancellationRequested = true;
		owner.phase = "cancelling";
		this.canReconnect = false;
		this.setStreamingActivity("正在取消");
		this.emit("change", undefined);
		void this.cancelOwnedTurn(owner);
	}

	/**
	 * Detach from the current stream without stopping the backend task.
	 * Used when the user navigates to a different session.
	 */
	detach(): void {
		this.activeOwner?.controller.abort();
		this.activeOwner = null;
		this.ownerGeneration++;
		this.isSending = false;
		this.canReconnect = false;
		this.currentSessionContext = null;
		this.lastUserPrompt = null;
		this.lastImages = undefined;
		this.resetTransientStreamState();
		this.emit("change", undefined);
	}

	private async cancelOwnedTurn(owner: ActiveStreamOwner): Promise<void> {
		try {
			if (!owner.turnId) await this.bindOwnerFromStatus(owner);
			if (!this.owns(owner)) return;
			if (!owner.turnId) throw new Error("尚未确认服务端任务，请重试停止操作");
			await abortChat(owner.sessionId, owner.turnId);
			if (!this.owns(owner)) return;
			this.setStreamingActivity("正在等待任务停止");
			this.emit("change", undefined);
		} catch (err) {
			if (this.owns(owner)) {
				this.canReconnect = true;
				this.streamingError = err instanceof Error ? err.message : "无法停止该任务";
				this.emit("change", undefined);
			}
		}
	}

	/**
	 * Reconnect to an in-progress session's backend event stream.
	 * Replays history and continues receiving live events.
	 */
	async resumeStream(sessionId: string, snapshot?: StreamSnapshot): Promise<void> {
		if (this.isSending) return;
		const stream = snapshot ?? (await getChatStatus(sessionId)).stream;
		if (!stream || !["queued", "running"].includes(stream.status)) return;
		if (!Number.isInteger(stream.baselineMessageCount) || stream.baselineMessageCount < 0) {
			this.streamingError = "该任务缺少恢复基线，无法安全恢复实时内容";
			this.emit("change", undefined);
			return;
		}
		this.currentSessionContext = sessionId;
		this.resetTransientStreamState();
		this.isSending = true;
		this.streamingActivity = "正在恢复生成";
		const controller = new AbortController();
		const owner: ActiveStreamOwner = {
			sessionId,
			clientRequestId: stream.clientRequestId,
			turnId: stream.turnId,
			generation: ++this.ownerGeneration,
			controller,
			lastAppliedEventId: 0,
			cancellationRequested: stream.cancelRequested,
			phase: "reconnecting",
		};
		this.activeOwner = owner;
		this.messages = [
			...this.messages.slice(0, stream.baselineMessageCount),
			{
				role: "user",
				content: stream.inputSnapshot.prompt,
				timestamp: Date.parse(stream.inputSnapshot.submittedAt) || Date.now(),
				images: stream.inputSnapshot.images
					.filter((image) => image.previewUrl)
					.map((image) => ({ previewUrl: image.previewUrl!, mimeType: image.mimeType })),
				attachments: stream.inputSnapshot.attachments,
				turnId: stream.turnId,
				transient: true,
				complete: false,
			},
		];
		this.emit("change", undefined);

		try {
			for await (const envelope of streamSessionEvents(sessionId, stream.turnId, 0, controller.signal)) {
				await this._handleStreamEnvelope(owner, envelope);
			}
			if (this.owns(owner) && !owner.terminalEvent) {
				await this.reconnectOwner(owner, new Error("恢复连接提前结束"));
			}
		} catch (err) {
			if (this.owns(owner) && !controller.signal.aborted && !owner.terminalEvent) {
				await this.reconnectOwner(owner, err);
			}
		}
	}

	/** Re-send the last user prompt. No-op while a send is in flight. */
	async retry(): Promise<void> {
		if (this.isSending || !this.currentSessionContext) return;
		const input = this.retryInputBySession.get(this.currentSessionContext);
		if (!input) return;
		await this.send(input.prompt, input.images, undefined, input.attachments);
	}

	/** Retry a failed event reconnect or final-history confirmation. */
	async reconnect(): Promise<void> {
		const owner = this.activeOwner;
		if (!owner || !this.canReconnect) return;
		this.canReconnect = false;
		this.streamingError = "";
		if (owner.terminalEvent) {
			await this.handleTerminal(owner, owner.terminalEvent);
		} else {
			await this.reconnectOwner(owner, new Error("用户请求重新连接"));
		}
	}

	private owns(owner: ActiveStreamOwner): boolean {
		return this.activeOwner === owner && this.activeOwner.generation === owner.generation;
	}

	private async bindOwnerFromStatus(owner: ActiveStreamOwner): Promise<boolean> {
		for (let attempt = 0; attempt < RECONNECT_DELAYS_MS.length; attempt++) {
			if (!this.owns(owner)) return false;
			try {
				const status = await getChatStatus(owner.sessionId);
				if (status.stream?.clientRequestId === owner.clientRequestId) {
					owner.turnId = status.stream.turnId;
					return true;
				}
			} catch {
				// A just-submitted request may not be visible yet; retry below.
			}
			if (attempt < RECONNECT_DELAYS_MS.length - 1) await delay(RECONNECT_DELAYS_MS[attempt]);
		}
		return false;
	}

	private async reconnectOwner(owner: ActiveStreamOwner, cause: unknown): Promise<void> {
		if (!this.owns(owner) || owner.terminalEvent) return;
		owner.phase = "reconnecting";
		this.setStreamingActivity("连接中断，正在重连");
		this.emit("change", undefined);
		let lastError = cause;
		for (let attempt = 0; attempt < RECONNECT_DELAYS_MS.length; attempt++) {
			if (!this.owns(owner) || owner.terminalEvent) return;
			if (attempt > 0) await delay(RECONNECT_DELAYS_MS[attempt - 1]);
			try {
				if (!owner.turnId && !(await this.bindOwnerFromStatus(owner))) continue;
				if (!owner.turnId || !this.owns(owner)) return;
				const status = await getChatStatus(owner.sessionId);
				if (!status.stream || status.stream.turnId !== owner.turnId || status.stream.clientRequestId !== owner.clientRequestId) {
					throw new Error("服务端任务状态已不可用");
				}
				const reconnectController = new AbortController();
				owner.controller = reconnectController;
				for await (const envelope of streamSessionEvents(owner.sessionId, owner.turnId, owner.lastAppliedEventId, reconnectController.signal)) {
					await this._handleStreamEnvelope(owner, envelope);
				}
				if (!this.owns(owner) || owner.terminalEvent) return;
				lastError = new Error("重连后事件流提前结束");
			} catch (error) {
				if (!this.owns(owner) || owner.controller.signal.aborted) return;
				lastError = error;
			}
		}
		this.failRecovery(owner, lastError, "实时连接恢复失败，请重新连接");
	}

	private async _handleStreamEnvelope(owner: ActiveStreamOwner, envelope: StreamEventEnvelope): Promise<void> {
		if (!this.owns(owner) || envelope.sessionId !== owner.sessionId || envelope.clientRequestId !== owner.clientRequestId) return;
		if (owner.turnId === null) owner.turnId = envelope.turnId;
		if (owner.turnId !== envelope.turnId || envelope.eventId <= owner.lastAppliedEventId) return;
		owner.lastAppliedEventId = envelope.eventId;
		if (envelope.event.type === "stream_state" && envelope.event.status === "running") owner.phase = "streaming";
		this._handleStreamEvent(envelope.event, owner);
		if (!["done", "error", "aborted"].includes(envelope.event.type)) return;
		await this.handleTerminal(owner, envelope.event as TerminalChatStreamEvent);
	}

	private async handleTerminal(owner: ActiveStreamOwner, terminal: TerminalChatStreamEvent): Promise<void> {
		if (!this.owns(owner)) return;
		owner.terminalEvent = terminal;
		owner.phase = "reloading_history";
		if (!terminal.persisted) {
			const message = terminal.type === "error" ? terminal.message : terminal.message ?? "最终记录尚未确认";
			this.materializeTransientTurn(owner, message);
			this.finalizeOwner(owner);
			return;
		}
		const loaded = await this.reloadCanonicalHistory(owner, terminal.finalMessageCount, terminal.finalSessionRevision);
		if (loaded) this.finalizeOwner(owner);
		else this.failRecovery(owner, new Error("最终记录尚未确认"), "最终记录尚未确认，请重新加载");
	}

	private async reloadCanonicalHistory(owner: ActiveStreamOwner, finalMessageCount?: number, finalRevision?: string): Promise<boolean> {
		const { getSession } = await import("../api/sessions.js");
		for (let attempt = 0; attempt < RECONNECT_DELAYS_MS.length; attempt++) {
			try {
				const session = await getSession(owner.sessionId);
				if (!this.owns(owner)) return false;
				const countMatches = finalMessageCount !== undefined && session.messageCount >= finalMessageCount;
				const revisionMatches = Boolean(finalRevision) && session.sessionRevision === finalRevision;
				if (countMatches || revisionMatches) {
					this.messages = session.messages.map((message) => ({ ...message, complete: true, transient: false }));
					this.emit("change", undefined);
					return true;
				}
			} catch {
				// The JSONL write may not be visible to this request yet.
			}
			if (attempt < RECONNECT_DELAYS_MS.length - 1) await delay(RECONNECT_DELAYS_MS[attempt]);
		}
		return false;
	}

	private materializeTransientTurn(owner: ActiveStreamOwner, error: string): void {
		if (!this.owns(owner)) return;
		this.messages = [...this.messages, {
			role: "assistant",
			content: this.streamingText,
			timestamp: Date.now(),
			thinking: this.streamingThinking || undefined,
			tools: this.completedTools.length ? this.completedTools : undefined,
			error,
			turnId: owner.turnId ?? undefined,
			transient: true,
			complete: false,
		}];
	}

	private failRecovery(owner: ActiveStreamOwner, error: unknown, prefix: string): void {
		if (!this.owns(owner)) return;
		this.canReconnect = true;
		const detail = error instanceof Error ? error.message : String(error);
		this.streamingError = detail && detail !== prefix ? `${prefix}：${detail}` : prefix;
		this.emit("change", undefined);
	}

	private finalizeOwner(owner: ActiveStreamOwner): void {
		if (!this.owns(owner)) return;
		this.flushStreamChange();
		this.activeOwner = null;
		this.isSending = false;
		this.canReconnect = false;
		this.resetTransientStreamState();
		const shouldRefreshWiki = this.wikiInvalidated;
		this.wikiInvalidated = false;
		this.emit("change", undefined);
		if (shouldRefreshWiki) void notebookStore.loadAll();
		void import("./sessions-store.js").then((module) => module.sessionsStore.refreshUntilTopic(owner.sessionId));
	}

	private _handleStreamEvent(event: ChatStreamEvent, owner: ActiveStreamOwner) {
		switch (event.type) {
			case "stream_state":
				this.setStreamingActivity(event.status === "queued" ? "等待执行" : "正在分析请求");
				this.emit("change", undefined);
				break;
			case "text_delta":
				this.streamingText += event.delta;
				if (!this.workspacePreviewId) this.setStreamingActivity("正在组织回复");
				this.scheduleStreamChange();
				break;
			case "thinking_delta":
				this.streamingThinking += event.delta;
				this.scheduleStreamChange();
				break;
			case "tool_call_delta":
				this.maybePrepareFileToolPreview(event.toolCallId, event.toolName, event.args, event.argsDelta);
				break;
			case "tool_start":
				this.flushStreamChange();
				this.maybeStartFileToolPreview(event.toolCallId, event.toolName, event.args);
				this.activeTools = [...this.activeTools.filter((tool) => tool.toolCallId !== event.toolCallId), {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					// Questionnaire options sit one level deeper than the generic tool
					// payload compactor keeps. Preserve this small, bounded payload so
					// the completed card can render every option immediately.
					args: event.toolName === "ask_user_question" ? event.args : compactToolPayload(event.args),
					contentOffset: this.streamingText.length,
				}];
				this.emit("change", undefined);
				break;
			case "tool_end":
				this.flushStreamChange();
				this.maybeFinishFileToolPreview(event.toolCallId, event.toolName, event.result, event.isError, owner);
				this.optimisticQuestionToolIds.delete(event.toolCallId);
				const existingTool = this.completedTools.find((tool) => tool.toolCallId === event.toolCallId)
					?? this.activeTools.find((tool) => tool.toolCallId === event.toolCallId);
				this.completedTools = [
					...this.completedTools.filter((tool) => tool.toolCallId !== event.toolCallId),
					{
						...(existingTool ?? {
							toolCallId: event.toolCallId,
							toolName: event.toolName,
							args: undefined,
						}),
						result: event.toolName === "ask_user_question" ? event.result : compactToolPayload(event.result),
						isError: event.isError,
					},
				];
				this.activeTools = this.activeTools.filter(
					(t) => t.toolCallId !== event.toolCallId,
				);
				if (mutatesWiki(event.toolName)) {
					this.wikiInvalidated = true;
				}
				this.emit("change", undefined);
				break;
			case "workspace_change":
				this.handleWorkspaceChange(event, owner);
				break;
			case "error":
				this.flushStreamChange();
				this.flushPreviewChange();
				// Keep the error separate from the reply text so the UI can render
				// it as a distinct, collapsible block rather than inline markdown.
				this.streamingError = this.streamingError
					? `${this.streamingError}\n${event.message}`
					: event.message;
				this.emit("change", undefined);
				if (this.workspacePreviewId) workspaceStore.finishStreamingPreview(this.workspacePreviewId, "error");
				break;
			case "question":
				// Skip replays of questions the user already answered (the backend
				// may still hold the pending question briefly after the answer POST).
				if (this.answeredQuestionIds.has(event.questionId)) break;
				this.flushStreamChange();
				this.pendingQuestion = {
					questionId: event.questionId,
					params: event.params,
					sessionId: owner.sessionId,
					turnId: owner.turnId ?? undefined,
				};
				this.emit("change", undefined);
				break;
			case "question_resolved":
				if (this.pendingQuestion?.questionId === event.questionId) this.pendingQuestion = null;
				this.emit("change", undefined);
				break;
			case "done":
				this.flushStreamChange();
				// Final message set with full content
				if (event.fullText) {
					this.streamingText = event.fullText;
				}
				this.emit("change", undefined);
				break;
			case "aborted":
				this.streamingError = event.message ?? "Stopped by user";
				this.emit("change", undefined);
				break;
		}
	}

	private scheduleStreamChange(): void {
		if (this.streamChangeTimer) return;
		this.streamChangeTimer = setTimeout(() => this.flushStreamChange(), STREAM_CHANGE_INTERVAL_MS);
	}

	private flushStreamChange(): void {
		if (this.streamChangeTimer) {
			clearTimeout(this.streamChangeTimer);
			this.streamChangeTimer = null;
		}
		this.emit("change", undefined);
	}

	private resetStreamTimers(): void {
		if (this.streamChangeTimer) clearTimeout(this.streamChangeTimer);
		this.streamChangeTimer = null;
	}

	private resetTransientStreamState(): void {
		this.resetStreamTimers();
		this.streamingText = "";
		this.streamingThinking = "";
		this.streamingTarget = "chat";
		this.streamingActivity = "";
		this.streamingActivityDetail = "";
		this.streamingError = "";
		this.activeTools = [];
		this.completedTools = [];
		this.optimisticQuestionToolIds.clear();
		this.pendingQuestion = null;
		if (this.workspacePreviewId) workspaceStore.clearStreamingPreview(this.workspacePreviewId);
		this.resetWorkspaceStreamState();
	}

	private setStreamingActivity(label: string, detail = ""): void {
		if (this.streamingActivity === label && this.streamingActivityDetail === detail) return;
		this.streamingActivity = label;
		this.streamingActivityDetail = detail;
		this.scheduleStreamChange();
	}

	private maybeStartFileToolPreview(toolCallId: string, toolName: string, args: unknown): void {
		if (!isFileWritingTool(toolName)) {
			this.setStreamingActivity("正在执行工具", toolName);
			return;
		}
		this.maybePrepareFileToolPreview(toolCallId, toolName, args);
		this.flushPreviewChange();
		const rawArgsText = this.fileToolArgText.get(toolCallId);
		const filePath = this.fileToolPaths.get(toolCallId) ?? extractToolFilePath(args) ?? extractToolFilePath(rawArgsText);
		this.setStreamingActivity(fileToolExecutionLabel(toolName), filePath ?? "");
		const previewId = `tool-${toolCallId}`;
		if (this.workspacePreviewId === previewId) {
			workspaceStore.updateStreamingPreview(previewId, {
				stage: fileToolExecutionLabel(toolName),
				status: "streaming",
			});
		}
	}

	private maybePrepareFileToolPreview(toolCallId: string, toolName: string, args: unknown, argsDelta?: string): void {
		if (!isFileWritingTool(toolName)) return;
		const rawArgsText = this.updateToolArgText(toolCallId, argsDelta);
		const filePath = extractToolFilePath(args) ?? extractToolFilePath(rawArgsText);
		if (filePath) this.fileToolPaths.set(toolCallId, filePath);
		const resolvedPath = this.fileToolPaths.get(toolCallId);
		const content = extractToolContent(args) ?? extractToolContent(rawArgsText);
		if (!resolvedPath && content === undefined) return;
		const hasContent = typeof content === "string" && content.length > 0;
		const id = `tool-${toolCallId}`;
		const title = resolvedPath
			? `${fileToolActionLabel(toolName)} ${resolvedPath}`
			: `${fileToolActionLabel(toolName)}文件`;
		const language = resolvedPath ? languageFromPath(resolvedPath) : "plaintext";
		const stage = hasContent ? "正在生成内容" : "正在准备文件";
		this.setStreamingActivity(stage, resolvedPath ?? "");
		this.streamingTarget = "workspace";
		this.workspacePreviewId = id;
		if (workspaceStore.streamingPreview?.id === id) {
			this.schedulePreviewChange(id, {
				title,
				path: resolvedPath,
				language,
				content: content ?? workspaceStore.streamingPreview.content,
				status: "streaming",
				stage,
			});
		} else {
			this.flushPreviewChange();
			void revealWorkspacePreview();
			workspaceStore.startStreamingPreview({
				id,
				title,
				path: resolvedPath,
				language,
				content: content ?? "",
				stage,
				source: "tool",
			});
		}
	}

	private maybeFinishFileToolPreview(toolCallId: string, toolName: string, result: unknown, isError: boolean, owner: ActiveStreamOwner): void {
		if (!isFileWritingTool(toolName)) return;
		this.flushPreviewChange();
		const rawArgsText = this.fileToolArgText.get(toolCallId);
		const filePath = this.fileToolPaths.get(toolCallId) ?? extractToolFilePath(result) ?? extractToolFilePath(rawArgsText);
		if (!filePath && this.workspacePreviewId !== `tool-${toolCallId}`) return;
		const previewId = `tool-${toolCallId}`;
		const isActivePreview = this.workspacePreviewId === previewId;
		if (isActivePreview) {
			workspaceStore.finishStreamingPreview(previewId, isError ? "error" : "done");
		}
		this.fileToolArgText.delete(toolCallId);
		this.fileToolPaths.delete(toolCallId);
		if (isActivePreview) this.workspacePreviewId = null;
		this.streamingTarget = "chat";
		if (!isError && filePath) {
			this.completedFileToolIds.add(toolCallId);
			this.setStreamingActivity("正在刷新文件预览", filePath);
			void openChangedWorkspacePath(filePath, isActivePreview ? previewId : undefined, () => this.owns(owner));
		}
	}

	private handleWorkspaceChange(event: Extract<ChatStreamEvent, { type: "workspace_change" }>, owner: ActiveStreamOwner): void {
		if (!event.changes.length || (event.toolCallId && this.completedFileToolIds.has(event.toolCallId))) return;
		const eventPreviewId = event.toolCallId ? `tool-${event.toolCallId}` : null;
		const previewId = eventPreviewId && this.workspacePreviewId === eventPreviewId ? eventPreviewId : null;
		const target = pickOpenableWorkspaceChange(event.changes);
		this.setStreamingActivity("正在刷新文件预览", target?.path ?? "");
		if (previewId) workspaceStore.finishStreamingPreview(previewId, "done");
		if (previewId) {
			this.streamingTarget = "chat";
			this.workspacePreviewId = null;
		}
		void openChangedWorkspacePath(target?.path, previewId ?? undefined, () => this.owns(owner));
	}

	private updateToolArgText(toolCallId: string, argsDelta?: string): string {
		const previous = this.fileToolArgText.get(toolCallId) ?? "";
		const next = typeof argsDelta === "string" && argsDelta.length > 0 ? previous + argsDelta : previous;
		if (next !== previous) this.fileToolArgText.set(toolCallId, next);
		return next;
	}

	private schedulePreviewChange(id: string, patch: StreamingPreviewPatch): void {
		if (this.pendingPreviewUpdate && this.pendingPreviewUpdate.id !== id) this.flushPreviewChange();
		this.pendingPreviewUpdate = {
			id,
			patch: { ...(this.pendingPreviewUpdate?.patch ?? {}), ...patch },
		};
		if (this.previewChangeTimer) return;
		this.previewChangeTimer = setTimeout(() => this.flushPreviewChange(), STREAM_CHANGE_INTERVAL_MS);
	}

	private flushPreviewChange(): void {
		if (this.previewChangeTimer) clearTimeout(this.previewChangeTimer);
		this.previewChangeTimer = null;
		const pending = this.pendingPreviewUpdate;
		this.pendingPreviewUpdate = null;
		if (pending) workspaceStore.updateStreamingPreview(pending.id, pending.patch);
	}

	private resetWorkspaceStreamState(options: { flushPreview?: boolean } = {}): void {
		if (options.flushPreview) this.flushPreviewChange();
		else {
			if (this.previewChangeTimer) clearTimeout(this.previewChangeTimer);
			this.previewChangeTimer = null;
			this.pendingPreviewUpdate = null;
		}
		this.workspacePreviewId = null;
		this.fileToolPaths.clear();
		this.fileToolArgText.clear();
		this.completedFileToolIds.clear();
	}

	async submitQuestionResponse(questionId: string, result: QuestionnaireResult): Promise<void> {
		const pending = this.pendingQuestion;
		if (pending?.questionId !== questionId) return;
		// Live cards take the scope from the active stream owner; restored cards
		// (persisted across a restart) carry their own stale scope — the backend
		// detects the dead turn and asks us to resend the answer as a new turn.
		const sessionId = this.activeOwner?.sessionId ?? pending.sessionId;
		const turnId = this.activeOwner?.turnId ?? pending.turnId;
		if (!sessionId || !turnId) return;
		this.answeredQuestionIds.add(questionId);
		const activeQuestionTool = this.activeTools.find((tool) => tool.toolName === "ask_user_question");
		const optimisticToolCallId = !result.cancelled ? activeQuestionTool?.toolCallId : undefined;
		// Swap the editable card for a complete read-only card immediately. The
		// eventual tool_end event reuses this record and replaces only its result,
		// so subsequent streamed text grows below it without changing the card.
		this.pendingQuestion = null;
		if (activeQuestionTool && !result.cancelled) {
			this.optimisticQuestionToolIds.add(activeQuestionTool.toolCallId);
			this.activeTools = this.activeTools.filter((tool) => tool.toolCallId !== activeQuestionTool.toolCallId);
			this.completedTools = [
				...this.completedTools.filter((tool) => tool.toolCallId !== activeQuestionTool.toolCallId),
				{
					...activeQuestionTool,
					args: pending.params,
					result,
					isError: false,
				},
			];
		}
		this.emit("change", undefined);
		try {
			const response = await submitChatQuestion(sessionId, turnId, questionId, result);
			if (response.expired) {
				// The original turn is gone: consume the card and resubmit the
				// answer as a normal user prompt so the agent resumes from the
				// session history.
				this.pendingQuestion = null;
				this.emit("change", undefined);
				await this.send(formatQuestionnaireAsPrompt(result));
			}
		} catch (err) {
			if (!this.activeOwner || this.owns(this.activeOwner)) {
				// Roll back only while the optimistic card is still ours. If
				// tool_end already arrived, the server consumed the answer
				// despite the failed POST — keep the completed card and only
				// surface the error instead of resurrecting the question.
				if (optimisticToolCallId && this.optimisticQuestionToolIds.has(optimisticToolCallId)) {
					this.optimisticQuestionToolIds.delete(optimisticToolCallId);
					this.completedTools = this.completedTools.filter((tool) => tool.toolCallId !== optimisticToolCallId);
					if (activeQuestionTool) this.activeTools = [...this.activeTools, activeQuestionTool];
					this.pendingQuestion = pending;
					this.answeredQuestionIds.delete(questionId);
				}
				this.streamingError = err instanceof Error ? err.message : "提交回答失败";
				this.emit("change", undefined);
			}
		}
	}

	async dismissQuestion(questionId: string): Promise<void> {
		await this.submitQuestionResponse(questionId, { answers: [], cancelled: true });
	}

	clear() {
		this.detach();
		this.messages = [];
		this.answeredQuestionIds.clear();
		this.optimisticQuestionToolIds.clear();
		this.emit("change", undefined);
	}

	loadHistory(messages: ChatMessage[], sessionId?: string) {
		this.isLoadingHistory = false;
		this.messages = messages;
		this.isSending = false;
		this.canReconnect = false;
		this.currentSessionContext = sessionId ?? null;
		const retryInput = sessionId ? this.retryInputBySession.get(sessionId) : undefined;
		this.lastUserPrompt = retryInput?.prompt ?? null;
		this.lastImages = retryInput?.images;
		this.resetTransientStreamState();
		this.emit("change", undefined);
	}

	/**
	 * Mirror a server-side session branch in the visible conversation.
	 * The edited user message and every response after it belong to the
	 * abandoned branch and must disappear before the replacement is sent.
	 */
	branchBefore(entryId: string): boolean {
		const index = this.messages.findIndex((message) => message.entryId === entryId);
		if (index < 0 || this.messages[index]?.role !== "user") return false;

		this.messages = this.messages.slice(0, index);
		let priorUserMessage: ChatMessage | undefined;
		for (let cursor = this.messages.length - 1; cursor >= 0; cursor--) {
			if (this.messages[cursor]?.role === "user") {
				priorUserMessage = this.messages[cursor];
				break;
			}
		}
		this.lastUserPrompt = priorUserMessage?.content ?? null;
		this.lastImages = undefined;
		this.pendingQuestion = null;
		this.resetTransientStreamState();
		this.emit("change", undefined);
		return true;
	}

	showError(message: string): void {
		this.streamingError = message;
		this.emit("change", undefined);
	}

	/** Add a server-persisted learning-system reply to the currently open chat. */
	appendAssistantMessage(content: string): void {
		this.messages = [...this.messages, {
			role: "assistant",
			content,
			timestamp: Date.now(),
			complete: true,
			transient: false,
		}];
		this.emit("change", undefined);
	}

	setLoadingHistory(loading: boolean) {
		this.isLoadingHistory = loading;
		this.emit("change", undefined);
	}

	/** Restore a previously-shown question card after switching back to a
	 *  session (from the local per-session cache or the server-persisted
	 *  record). No-op if a newer question is already shown — the live stream
	 *  replay wins. Skips cards the user already answered. */
	restorePendingQuestion(question: PendingQuestion | null): void {
		if (this.pendingQuestion) return;
		if (!question || this.answeredQuestionIds.has(question.questionId)) return;
		this.pendingQuestion = question;
		this.emit("change", undefined);
	}
}

export const chatStore = new ChatStoreImpl();

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Tools that modify the L2 wiki/graph. When any of these complete during a
 * chat turn we trigger a refresh of the Wiki list and the knowledge graph
 * so the workspace tabs reflect agent-side writes in real time.
 */
function mutatesWiki(toolName: string): boolean {
	return toolName === "l2_archive" || toolName === "l2_link_pages" || toolName.startsWith("wiki_");
}

const FILE_EXTENSIONS = [
	"ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "md", "markdown", "html", "htm",
	"css", "scss", "less", "json", "jsonl", "yaml", "yml", "toml", "sh", "bash",
	"zsh", "sql", "txt", "xml", "svg", "java", "go", "rs", "cpp", "c", "h",
].join("|");
const FILE_PATH_RE = new RegExp(`(?:^|[\\s"'\\\`“”‘’（(])((?:[\\w.-]+\\/)*[\\w.-]+\\.(${FILE_EXTENSIONS}))(?:$|[\\s"'\\\`“”‘’）),，。:：])`, "i");

async function revealWorkspacePreview(): Promise<void> {
	const currentMode = appStore.workspaceMode;
	const opensSplitPanel = currentMode !== "full";
	const targetMode = currentMode === "collapsed" || currentMode === "quarter" ? "half" : currentMode;
	const targetWidth = appStore.workspaceWidth < 560 ? 640 : appStore.workspaceWidth;

	if (opensSplitPanel) {
		// Desktop: grow the native window first. Browser users have no desktop
		// bridge, so ensureWindowForPanel returns "unavailable" and the local
		// fitPanelLayout fallback below still opens the panel safely.
		await ensureWindowForPanel("right", targetWidth, targetMode);
	}

	appStore.setRightPanelTab("preview");
	if (appStore.workspaceWidth < 560) appStore.setWorkspaceWidth(640);
	if (appStore.workspaceMode === "collapsed" || appStore.workspaceMode === "quarter") {
		appStore.setWorkspaceMode("half");
	}
}

function isFileWritingTool(toolName: string): boolean {
	const name = toolName.toLowerCase();
	if (["write", "edit", "patch", "apply_patch", "create_practice_lab"].includes(name)) return true;
	const tokens = name.split(/[^a-z0-9]+/).filter(Boolean);
	const hasFileTarget = tokens.some((token) => token === "file" || token === "files" || token === "workspace");
	const hasWriteAction = tokens.some((token) => [
		"write", "edit", "patch", "save", "create", "upload", "rename", "move", "delete", "remove",
	].includes(token));
	return hasFileTarget && hasWriteAction;
}

function fileToolActionLabel(toolName: string): string {
	const name = toolName.toLowerCase();
	if (name.includes("edit") || name.includes("patch")) return "正在修改";
	if (name.includes("rename") || name.includes("move")) return "正在移动";
	if (name.includes("delete") || name.includes("remove")) return "正在删除";
	if (name.includes("upload")) return "正在上传";
	return "正在写入";
}

function fileToolExecutionLabel(toolName: string): string {
	const name = toolName.toLowerCase();
	if (name.includes("edit") || name.includes("patch")) return "正在应用修改";
	if (name.includes("rename") || name.includes("move")) return "正在移动文件";
	if (name.includes("delete") || name.includes("remove")) return "正在删除文件";
	if (name.includes("upload")) return "正在上传文件";
	return "正在写入磁盘";
}

function extractToolFilePath(args: unknown): string | undefined {
	return extractPathFromValue(args, new WeakSet<object>(), 0);
}

function extractToolContent(args: unknown): string | undefined {
	if (typeof args === "string") {
		const parsed = parseJsonObject(args);
		if (parsed) return extractToolContent(parsed);
		return extractPartialJsonStringField(args, ["content", "text", "new_content", "file_content", "body", "newText"]);
	}
	if (!args || typeof args !== "object") return undefined;
	const record = args as Record<string, unknown>;
	for (const key of ["content", "text", "new_content", "file_content", "body"]) {
		if (typeof record[key] === "string") return record[key];
	}
	if (Array.isArray(record.files)) {
		const entries = record.files.filter((file): file is Record<string, unknown> => Boolean(file) && typeof file === "object");
		const mainFile = typeof record.mainFile === "string" ? record.mainFile : undefined;
		const selected = entries.find((file) => mainFile && file.path === mainFile) ?? entries[0];
		if (selected && typeof selected.content === "string") return selected.content;
	}
	const editPreview = extractEditPreview(record);
	if (editPreview) return editPreview;
	return undefined;
}

function extractPathFromValue(value: unknown, seen: WeakSet<object>, depth: number, keyHint = ""): string | undefined {
	if (depth > 5 || value == null) return undefined;
	if (typeof value === "string") return extractPathFromString(value, keyHint);
	if (typeof value !== "object") return undefined;
	if (seen.has(value)) return undefined;
	seen.add(value);
	if (Array.isArray(value)) {
		for (const child of value) {
			const path = extractPathFromValue(child, seen, depth + 1, keyHint);
			if (path) return path;
		}
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const priorityKeys = [
		"targetPath", "target_path", "newPath", "new_path", "outputPath", "output_path",
		"file_path", "filePath", "path", "filename", "fileName", "mainFile",
		"destination", "dest", "to", "sourcePath", "source_path", "oldPath", "old_path",
	];
	for (const key of priorityKeys) {
		const child = record[key];
		if (typeof child === "string") {
			const path = cleanPathString(child);
			if (path) return path;
		}
	}
	for (const [key, child] of Object.entries(record)) {
		const path = extractPathFromValue(child, seen, depth + 1, key);
		if (path) return path;
	}
	return undefined;
}

function extractPathFromString(value: string, keyHint: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return undefined;
	const partialPath = extractPartialJsonStringField(trimmed, [
		"targetPath", "target_path", "newPath", "new_path", "outputPath", "output_path",
		"file_path", "filePath", "path", "filename", "fileName", "mainFile",
	]);
	if (partialPath) return cleanPathString(partialPath);
	const keyLooksPathLike = /(path|file|filename|destination|source|target|main)/i.test(keyHint);
	if (keyLooksPathLike) return cleanPathString(trimmed);
	if (trimmed.length > 320 || trimmed.includes("\n")) return undefined;
	const match = trimmed.match(FILE_PATH_RE);
	return match?.[1] ? cleanPathString(match[1]) : undefined;
}

function cleanPathString(value: string): string | undefined {
	const path = value.trim().replace(/^[`"']|[`"']$/g, "");
	if (!path || path.length > 500 || path.includes("\n")) return undefined;
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return undefined;
	return path;
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? parsed as Record<string, unknown>
			: undefined;
	} catch {
		return undefined;
	}
}

function extractPartialJsonStringField(source: string, fieldNames: string[]): string | undefined {
	for (const fieldName of fieldNames) {
		const pattern = new RegExp(`"${escapeRegExp(fieldName)}"\\s*:\\s*"`, "i");
		const match = pattern.exec(source);
		if (!match) continue;
		const start = match.index + match[0].length;
		const decoded = decodeJsonStringFragment(readJsonStringFragment(source, start));
		if (decoded !== undefined) return decoded;
	}
	return undefined;
}

function readJsonStringFragment(source: string, start: number): string {
	let result = "";
	let escaped = false;
	for (let i = start; i < source.length; i += 1) {
		const char = source[i];
		if (escaped) {
			result += char;
			escaped = false;
			continue;
		}
		if (char === "\\") {
			result += char;
			escaped = true;
			continue;
		}
		if (char === "\"") break;
		result += char;
	}
	return result;
}

function decodeJsonStringFragment(raw: string): string | undefined {
	if (!raw) return undefined;
	const fragment = raw.endsWith("\\") ? raw.slice(0, -1) : raw;
	try {
		return JSON.parse(`"${fragment}"`) as string;
	} catch {
		return fragment
			.replace(/\\n/g, "\n")
			.replace(/\\r/g, "\r")
			.replace(/\\t/g, "\t")
			.replace(/\\"/g, "\"")
			.replace(/\\\\/g, "\\");
	}
}

function extractEditPreview(record: Record<string, unknown>): string | undefined {
	const edits = record.edits;
	if (!Array.isArray(edits)) return undefined;
	const snippets = edits
		.map((edit) => edit && typeof edit === "object" ? (edit as Record<string, unknown>).newText : undefined)
		.filter((value): value is string => typeof value === "string" && value.length > 0);
	if (!snippets.length) return undefined;
	return snippets.join("\n\n");
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pickOpenableWorkspaceChange(changes: WorkspaceFileChange[]): WorkspaceFileChange | undefined {
	return changes.find((change) => change.change === "created")
		?? changes.find((change) => change.change === "modified")
		?? changes.find((change) => change.change !== "deleted");
}

async function openChangedWorkspacePath(filePath?: string, previewId?: string, isCurrent: () => boolean = () => true): Promise<void> {
	try {
		if (!isCurrent()) return;
		await revealWorkspacePreview();
		if (previewId) workspaceStore.clearStreamingPreview(previewId);
		await workspaceStore.loadTree(isCurrent);
		if (!isCurrent()) return;
		if (filePath) await workspaceStore.selectFile(filePath, isCurrent);
	} catch {
		if (previewId && isCurrent()) workspaceStore.finishStreamingPreview(previewId, "error");
	}
}

function compactToolPayload(value: unknown): unknown {
	return compactValue(value, new WeakSet<object>(), 0);
}

function compactValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
	if (typeof value === "string") {
		if (value.length <= 1600) return value;
		return `${value.slice(0, 1600)}\n\n[已省略 ${value.length - 1600} 个字符]`;
	}
	if (value == null || typeof value !== "object") return value;
	if (seen.has(value)) return "[循环引用]";
	seen.add(value);
	if (depth >= 4) return "[内容层级较深，已折叠]";
	if (Array.isArray(value)) {
		const items = value.slice(0, 24).map((item) => compactValue(item, seen, depth + 1));
		if (value.length > 24) items.push(`[已省略 ${value.length - 24} 项]`);
		return items;
	}
	const record = value as Record<string, unknown>;
	const entries = Object.entries(record).slice(0, 32);
	const result: Record<string, unknown> = {};
	for (const [key, item] of entries) {
		result[key] = compactValue(item, seen, depth + 1);
	}
	const remaining = Object.keys(record).length - entries.length;
	if (remaining > 0) result.__truncated = `已省略 ${remaining} 个字段`;
	return result;
}

function languageFromPath(path: string): string {
	const lower = path.toLowerCase();
	if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
	if (lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "javascript";
	if (lower.endsWith(".py")) return "python";
	if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
	if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
	if (lower.endsWith(".css") || lower.endsWith(".scss") || lower.endsWith(".less")) return "css";
	if (lower.endsWith(".json") || lower.endsWith(".jsonl")) return "json";
	if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
	if (lower.endsWith(".sql")) return "sql";
	if (lower.endsWith(".sh") || lower.endsWith(".bash") || lower.endsWith(".zsh")) return "bash";
	return "plaintext";
}
