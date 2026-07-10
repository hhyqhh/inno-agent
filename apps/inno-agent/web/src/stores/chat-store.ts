import { EventEmitter } from "./event-emitter.js";
import { streamChat, abortChat, streamSessionEvents } from "../api/chat.js";
import type { InlineImage } from "../api/chat.js";
import type { ChatMessage, ChatStreamEvent, ChatToolRecord, PendingQuestion, QuestionnaireResult, WorkspaceFileChange } from "../types/chat.js";
import { notebookStore } from "./notebook-store.js";
import { appStore } from "./app-store.js";
import { workspaceStore } from "./workspace-store.js";

type StreamingTarget = "chat" | "workspace";

const STREAM_CHANGE_INTERVAL_MS = 80;

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
	private abortController: AbortController | null = null;
	private detachMode = false;
	private wikiInvalidated = false;
	private streamChangeTimer: ReturnType<typeof setTimeout> | null = null;
	private workspacePreviewId: string | null = null;
	private fileToolPaths = new Map<string, string>();
	private fileToolArgText = new Map<string, string>();

	async send(prompt: string, images?: InlineImage[]): Promise<void> {
		if ((!prompt.trim() && !images?.length) || this.isSending) return;
		this.detachMode = false;
		this.resetStreamTimers();
		this.streamingTarget = "chat";
		this.workspacePreviewId = null;
		this.fileToolPaths.clear();
		this.fileToolArgText.clear();

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
		this.setStreamingActivity("正在分析请求");
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
			this.flushStreamChange();
			const aborted = controller.signal.aborted;

			// Finalize: add accumulated text as assistant message. Also finalize
			// when the turn produced only an error (no text), so the error is
			// preserved in history instead of vanishing when streaming state resets.
			if (this.detachMode) {
				// skip — backend still running, loadHistory will show final result
			} else if (this.streamingText || this.streamingError || aborted) {
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
			this.flushStreamChange();
			this.isSending = false;
			this.streamingText = "";
			this.streamingThinking = "";
			this.streamingTarget = "chat";
			this.streamingActivity = "";
			this.streamingActivityDetail = "";
			this.streamingError = "";
			this.activeTools = [];
			this.completedTools = [];
			this.abortController = null;
			this.detachMode = false;
			this.pendingQuestion = null;
			this.resetStreamTimers();
			this.workspacePreviewId = null;
			this.fileToolPaths.clear();
			this.fileToolArgText.clear();
			const shouldRefreshWiki = this.wikiInvalidated;
			this.wikiInvalidated = false;
			this.emit("change", undefined);
			if (shouldRefreshWiki) {
				// L2 tools mutated the wiki — refresh pages + graph so the
				// Notebook tab reflects the new state without manual reload.
				void notebookStore.loadAll();
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

	/**
	 * Abort the in-flight stream. Called when user clicks the stop button —
	 * the only path that actually stops the backend task.
	 */
	cancel(): void {
		const wasSending = this.isSending;
		this.abortController?.abort();
		// Aborting the local fetch may not promptly close the upstream connection
		// (dev proxy buffering), so explicitly tell the backend to stop the run.
		// This releases the server's shared prompt queue immediately, preventing
		// new-session / switch-session from blocking behind a still-running turn.
		if (wasSending) void abortChat();
	}

	/**
	 * Detach from the current stream without stopping the backend task.
	 * Used when the user navigates to a different session.
	 */
	detach(): void {
		this.detachMode = true;
		this.abortController?.abort();
		this.abortController = null;
	}

	/**
	 * Reconnect to an in-progress session's backend event stream.
	 * Replays history and continues receiving live events.
	 */
	async resumeStream(sessionId: string): Promise<void> {
		if (this.isSending) return;
		this.resetStreamTimers();
		this.isSending = true;
		this.streamingText = "";
		this.streamingThinking = "";
		this.streamingTarget = "chat";
		this.streamingActivity = "正在恢复生成";
		this.streamingActivityDetail = "";
		this.streamingError = "";
		this.activeTools = [];
		this.completedTools = [];
		this.detachMode = false;
		this.workspacePreviewId = null;
		this.fileToolPaths.clear();
		this.fileToolArgText.clear();
		const controller = new AbortController();
		this.abortController = controller;
		this.emit("change", undefined);

		try {
			for await (const event of streamSessionEvents(sessionId, controller.signal)) {
				this._handleStreamEvent(event);
			}
			this.flushStreamChange();
			// Finalize assistant message from accumulated streaming text
			if (this.detachMode) {
				// detached again — skip finalize
			} else if (this.streamingText || this.streamingError) {
				this.messages = [
					...this.messages,
					{
						role: "assistant",
						content: this.streamingText,
						timestamp: Date.now(),
						thinking: this.streamingThinking || undefined,
						tools: this.completedTools.length > 0 ? this.completedTools : undefined,
						error: this.streamingError || undefined,
					},
				];
			}
		} catch (err) {
			if (!controller.signal.aborted) {
				console.warn("[chat-store] resumeStream error:", err);
			}
		} finally {
			this.flushStreamChange();
			this.isSending = false;
			this.streamingText = "";
			this.streamingThinking = "";
			this.streamingTarget = "chat";
			this.streamingActivity = "";
			this.streamingActivityDetail = "";
			this.streamingError = "";
			this.activeTools = [];
			this.completedTools = [];
			this.abortController = null;
			this.detachMode = false;
			this.pendingQuestion = null;
			this.resetStreamTimers();
			this.workspacePreviewId = null;
			this.fileToolPaths.clear();
			this.fileToolArgText.clear();
			this.emit("change", undefined);
			void import("./sessions-store.js").then((m) => m.sessionsStore.refresh());
		}
	}

	/** Re-send the last user prompt. No-op while a send is in flight. */
	async retry(): Promise<void> {
		if (this.isSending || !this.lastUserPrompt) return;
		await this.send(this.lastUserPrompt, this.lastImages);
	}

	private _handleStreamEvent(event: ChatStreamEvent) {
		switch (event.type) {
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
				this.maybePrepareFileToolPreview(event.toolCallId, event.toolName, event.args, event.argsText, event.argsDelta);
				break;
			case "tool_start":
				this.flushStreamChange();
				this.maybeStartFileToolPreview(event.toolCallId, event.toolName, event.args);
				this.activeTools = [...this.activeTools, {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: compactToolPayload(event.args),
				}];
				this.emit("change", undefined);
				break;
			case "tool_end":
				this.flushStreamChange();
				this.maybeFinishFileToolPreview(event.toolCallId, event.toolName, event.result, event.isError);
				this.completedTools = [
					...this.completedTools,
					{
						...(this.activeTools.find((t) => t.toolCallId === event.toolCallId) ?? {
							toolCallId: event.toolCallId,
							toolName: "tool",
							args: undefined,
						}),
						result: compactToolPayload(event.result),
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
			case "workspace_change":
				this.handleWorkspaceChange(event.changes);
				break;
			case "error":
				this.flushStreamChange();
				// Keep the error separate from the reply text so the UI can render
				// it as a distinct, collapsible block rather than inline markdown.
				this.streamingError = this.streamingError
					? `${this.streamingError}\n${event.message}`
					: event.message;
				this.emit("change", undefined);
				if (this.workspacePreviewId) workspaceStore.finishStreamingPreview(this.workspacePreviewId, "error");
				break;
			case "question":
				this.flushStreamChange();
				this.pendingQuestion = {
					questionId: event.questionId,
					params: event.params,
				};
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

	private setStreamingActivity(label: string, detail = ""): void {
		if (this.streamingActivity === label && this.streamingActivityDetail === detail) return;
		this.streamingActivity = label;
		this.streamingActivityDetail = detail;
		this.scheduleStreamChange();
	}

	private maybeStartFileToolPreview(toolCallId: string, toolName: string, args: unknown): void {
		const rawArgsText = this.fileToolArgText.get(toolCallId);
		const filePath = this.fileToolPaths.get(toolCallId) ?? extractToolFilePath(args) ?? (rawArgsText ? extractToolFilePath(rawArgsText) : undefined);
		this.setStreamingActivity(filePath ? fileToolExecutionLabel(toolName) : "正在执行文件操作", filePath ?? "");
		if (this.workspacePreviewId === `tool-${toolCallId}`) {
			workspaceStore.updateStreamingPreview(this.workspacePreviewId, {
				stage: fileToolExecutionLabel(toolName),
				status: "streaming",
			});
		}
		this.maybePrepareFileToolPreview(toolCallId, toolName, args);
	}

	private maybePrepareFileToolPreview(toolCallId: string, toolName: string, args: unknown, argsText?: string, argsDelta?: string): void {
		if (!isFileWritingTool(toolName)) return;
		const rawArgsText = this.updateToolArgText(toolCallId, argsText, argsDelta);
		const filePath = extractToolFilePath(args) ?? (rawArgsText ? extractToolFilePath(rawArgsText) : undefined);
		if (filePath) this.fileToolPaths.set(toolCallId, filePath);
		const content = extractToolContent(args) ?? (rawArgsText ? extractToolContent(rawArgsText) : undefined);
		const hasContent = typeof content === "string" && content.length > 0;
		const id = `tool-${toolCallId}`;
		const title = filePath
			? `${fileToolActionLabel(toolName)} ${filePath}`
			: `${fileToolActionLabel(toolName)}文件`;
		const language = filePath ? languageFromPath(filePath) : "plaintext";
		const stage = hasContent ? "正在生成内容" : "正在准备文件";
		this.setStreamingActivity(stage, filePath ?? "");
		this.workspacePreviewId = id;
		revealWorkspacePreview();
		if (workspaceStore.streamingPreview?.id === id) {
			workspaceStore.updateStreamingPreview(id, {
				title,
				path: filePath,
				language,
				content: content ?? workspaceStore.streamingPreview.content,
				status: "streaming",
				stage,
			});
		} else {
			workspaceStore.startStreamingPreview({
				id,
				title,
				path: filePath,
				language,
				content: content ?? "",
				stage,
				source: "tool",
			});
		}
	}

	private maybeFinishFileToolPreview(toolCallId: string, toolName: string, result: unknown, isError: boolean): void {
		if (!isFileWritingTool(toolName)) return;
		const rawArgsText = this.fileToolArgText.get(toolCallId);
		const filePath = this.fileToolPaths.get(toolCallId) ?? extractToolFilePath(result) ?? (rawArgsText ? extractToolFilePath(rawArgsText) : undefined);
		if (!filePath && this.workspacePreviewId !== `tool-${toolCallId}`) return;
		const previewId = `tool-${toolCallId}`;
		if (this.workspacePreviewId === previewId) {
			workspaceStore.finishStreamingPreview(previewId, isError ? "error" : "done");
		}
		if (!isError && filePath) {
			this.setStreamingActivity("正在检查文件变化", filePath);
			this.streamingTarget = "chat";
		}
	}

	private handleWorkspaceChange(changes: WorkspaceFileChange[]): void {
		if (!changes.length) return;
		const previewId = this.workspacePreviewId;
		const target = pickOpenableWorkspaceChange(changes);
		this.setStreamingActivity("正在刷新文件预览", target?.path ?? "");
		if (previewId) workspaceStore.finishStreamingPreview(previewId, "done");
		this.streamingTarget = "chat";
		this.workspacePreviewId = null;
		void openChangedWorkspacePath(target?.path, previewId ?? undefined);
	}

	private updateToolArgText(toolCallId: string, argsText?: string, argsDelta?: string): string {
		const previous = this.fileToolArgText.get(toolCallId) ?? "";
		let next = previous;
		if (typeof argsText === "string" && argsText.length >= previous.length) {
			next = argsText;
		} else if (typeof argsDelta === "string" && argsDelta.length > 0) {
			next = previous + argsDelta;
		}
		if (next !== previous) this.fileToolArgText.set(toolCallId, next);
		return next;
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
		this.streamingTarget = "chat";
		this.streamingActivity = "";
		this.streamingActivityDetail = "";
		this.streamingError = "";
		this.activeTools = [];
		this.completedTools = [];
		this.pendingQuestion = null;
		this.resetStreamTimers();
		this.workspacePreviewId = null;
		this.fileToolPaths.clear();
		this.fileToolArgText.clear();
		this.emit("change", undefined);
	}

	loadHistory(messages: ChatMessage[]) {
		this.isLoadingHistory = false;
		this.messages = messages;
		this.isSending = false;
		this.streamingText = "";
		this.streamingThinking = "";
		this.streamingTarget = "chat";
		this.streamingActivity = "";
		this.streamingActivityDetail = "";
		this.streamingError = "";
		this.activeTools = [];
		this.completedTools = [];
		this.resetStreamTimers();
		this.workspacePreviewId = null;
		this.fileToolPaths.clear();
		this.fileToolArgText.clear();
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
		appStore.setRightPanelTab("preview");
		await workspaceStore.loadTree();
		if (mainFile) {
			await workspaceStore.selectFile(mainFile);
		}
	} catch {
		// best-effort — non-fatal if any store import fails
	}
}

const FILE_EXTENSIONS = [
	"ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "md", "markdown", "html", "htm",
	"css", "scss", "less", "json", "jsonl", "yaml", "yml", "toml", "sh", "bash",
	"zsh", "sql", "txt", "xml", "svg", "java", "go", "rs", "cpp", "c", "h",
].join("|");
const FILE_PATH_RE = new RegExp(`(?:^|[\\s"'\\\`“”‘’（(])((?:[\\w.-]+\\/)*[\\w.-]+\\.(${FILE_EXTENSIONS}))(?:$|[\\s"'\\\`“”‘’）),，。:：])`, "i");

function revealWorkspacePreview(): void {
	appStore.setRightPanelTab("preview");
	if (appStore.workspaceWidth < 560) appStore.setWorkspaceWidth(640);
	if (appStore.workspaceMode === "collapsed" || appStore.workspaceMode === "quarter") {
		appStore.setWorkspaceMode("half");
	}
}

function isFileWritingTool(toolName: string): boolean {
	const name = toolName.toLowerCase();
	return name.includes("write")
		|| name.includes("edit")
		|| name.includes("patch")
		|| name.includes("save")
		|| name.includes("create")
		|| name.includes("upload")
		|| name.includes("rename")
		|| name.includes("move")
		|| name.includes("delete")
		|| name.includes("remove");
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
	if (Array.isArray(value)) {
		for (const child of value) {
			const path = extractPathFromValue(child, seen, depth + 1, keyHint);
			if (path) return path;
		}
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
		const raw = readJsonStringFragment(source, start);
		const decoded = decodeJsonStringFragment(raw);
		if (decoded) return decoded;
	}
	return undefined;
}

function readJsonStringFragment(source: string, start: number): string {
	let result = "";
	let escaped = false;
	for (let i = start; i < source.length; i += 1) {
		const ch = source[i];
		if (escaped) {
			result += ch;
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			result += ch;
			escaped = true;
			continue;
		}
		if (ch === "\"") break;
		result += ch;
	}
	return result;
}

function decodeJsonStringFragment(raw: string): string | undefined {
	if (!raw) return undefined;
	let fragment = raw;
	if (fragment.endsWith("\\")) fragment = fragment.slice(0, -1);
	try {
		return JSON.parse(`"${fragment}"`);
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

async function openChangedWorkspacePath(filePath?: string, previewId?: string): Promise<void> {
	try {
		revealWorkspacePreview();
		if (previewId) workspaceStore.clearStreamingPreview(previewId);
		await workspaceStore.loadTree();
		if (filePath) await workspaceStore.selectFile(filePath);
	} catch {
		if (previewId) workspaceStore.finishStreamingPreview(previewId, "error");
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
