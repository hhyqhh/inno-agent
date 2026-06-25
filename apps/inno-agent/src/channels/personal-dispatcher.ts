import type { ChatChannel, ChannelStreamEvent } from "./channel.js";
import type { ChannelRegistry } from "./channel.js";
import { isStreamingChannel } from "./channel.js";
import type { IncomingMessage } from "./types.js";
import type { ImageContent } from "@earendil-works/pi-ai";
import { DedupeStore } from "./dedupe-store.js";
import { ChannelRunLog, generateRunId } from "./run-log.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { logger } from "../logger.js";

const NEW_SESSION_COMMANDS = new Set(["/new", "新建对话", "新建会话"]);
const MAX_TEXT_LENGTH = 20_000;

/** Callback type for streaming prompt execution. */
export type StreamEventCallback = (event: ChannelStreamEvent) => void;

export interface PersonalChannelDispatcherOptions {
	channelRegistry: ChannelRegistry;
	/** Plain runPrompt (runs in the current global session). */
	runPrompt: (prompt: string, images?: ImageContent[]) => Promise<string>;
	/** Atomically switch to sessionPath and run prompt in one enqueue slot. */
	runPromptInSession: (sessionPath: string, prompt: string, images?: ImageContent[]) => Promise<string>;
	/** Streaming variant: runs prompt and forwards events via callback. */
	runPromptStreamingInSession?: (
		sessionPath: string,
		prompt: string,
		onEvent: StreamEventCallback,
		images?: ImageContent[],
	) => Promise<string>;
	createNewSession: () => Promise<string>;
	getCurrentSessionId: () => string;
	recordSessionChannel: (channel: string, explicitSessionId?: string) => void;
	/** Fire-and-forget: auto-generate a topic for a session if it lacks one. */
	maybeAutoGenerateTopic?: (sessionId: string) => void;
	/** Called after a new session is created for a channel chat. */
	onSessionCreated?: (sessionId: string, channel: string) => void;
	channelsDataDir: string;
	sessionDir: string;
}

/** Persisted mapping from channel chatId to sessionId (filename). */
type ChatSessionMap = Record<string, string>;

export class PersonalChannelDispatcher {
	private dedupeStore: DedupeStore;
	private runLog: ChannelRunLog;
	private opts: PersonalChannelDispatcherOptions;
	private chatSessionMap: ChatSessionMap;
	private chatSessionMapPath: string;

	constructor(opts: PersonalChannelDispatcherOptions) {
		this.opts = opts;
		this.dedupeStore = new DedupeStore(`${opts.channelsDataDir}/dedupe.jsonl`);
		this.runLog = new ChannelRunLog(`${opts.channelsDataDir}/runs.jsonl`);
		this.chatSessionMapPath = join(opts.channelsDataDir, "chat-sessions.json");
		this.chatSessionMap = this.loadChatSessionMap();

		setInterval(() => this.dedupeStore.cleanup(), 60 * 60 * 1000);
	}

	async handle(channel: ChatChannel, msg: IncomingMessage): Promise<void> {
		if (this.dedupeStore.isDuplicate(msg.channel, msg.messageId)) {
			return;
		}
		this.dedupeStore.mark(msg.channel, msg.messageId);

		if (!msg.text?.trim() && (!msg.attachments || msg.attachments.length === 0)) {
			return;
		}

		if (msg.chatId) {
			this.opts.channelRegistry.setDefaultTarget({ channel: msg.channel, chatId: msg.chatId });
		}

		const rawText = msg.text.trim();
		const chatKey = this.chatKey(msg);

		if (NEW_SESSION_COMMANDS.has(rawText)) {
			try {
				const newSessionId = await this.opts.createNewSession();
				this.opts.onSessionCreated?.(newSessionId, msg.channel);
				this.opts.recordSessionChannel(msg.channel, newSessionId);
				// Bind this chatId to the new session
				if (chatKey) {
					this.chatSessionMap[chatKey] = newSessionId;
					this.saveChatSessionMap();
					logger.info({ chatKey, newSessionId }, "dispatcher bound chat to session");
				}
				await channel.reply(msg, `已新建会话：${newSessionId}\n后续消息将在新会话中继续。`);
			} catch (err) {
				logger.error({ err }, "dispatcher new session error");
				await this.safeReply(channel, msg, "新建会话失败，请稍后重试。");
			}
			return;
		}

		const images: ImageContent[] = [];
		if (msg.attachments) {
			for (const att of msg.attachments) {
				if (att.type === "image" && att.data) {
					images.push({
						type: "image",
						data: att.data,
						mimeType: att.mimeType ?? "image/png",
					});
				}
			}
		}

		let prompt = `[消息来源渠道: ${msg.channel}]\n${msg.text}`;
		if (prompt.length > MAX_TEXT_LENGTH) {
			prompt = prompt.slice(0, MAX_TEXT_LENGTH);
			await this.safeReply(channel, msg, "消息过长，已截断处理。");
		}

		if (msg.attachments) {
			for (const att of msg.attachments) {
				if (att.type === "file" && att.filePath) {
					prompt += `\n\n[附件已下载到: ${att.filePath}]`;
				}
			}
		}

		// Resolve target session for this chat (if any).
		let targetSessionPath = this.resolveSessionPath(chatKey);

		// If this chatKey has no session binding yet, create a dedicated session
		// so channel messages never piggy-back on the current web/global session.
		if (!targetSessionPath && chatKey) {
			try {
				const newSessionId = await this.opts.createNewSession();
				this.opts.onSessionCreated?.(newSessionId, msg.channel);
				this.chatSessionMap[chatKey] = newSessionId;
				this.saveChatSessionMap();
				this.opts.recordSessionChannel(msg.channel, newSessionId);
				// Build path directly — don't use resolveSessionPath which checks
				// existsSync (PI SDK creates session files lazily).
				targetSessionPath = resolve(join(this.opts.sessionDir, newSessionId));
				logger.info({ chatKey, newSessionId }, "dispatcher auto-created session");
			} catch (err) {
				logger.error({ err }, "dispatcher failed to auto-create session");
				// Fall through to global session as last resort
			}
		}

		const runId = generateRunId();
		const startedAt = new Date();

		try {
			let output: string;

			// Use streaming path if channel supports it and streaming function is available
			if (
				isStreamingChannel(channel) &&
				this.opts.runPromptStreamingInSession &&
				targetSessionPath
			) {
				try {
					output = await this.handleStreaming(channel, msg, targetSessionPath, prompt, images);
				} catch (streamErr: any) {
					// If streaming card creation itself failed (e.g. bot lacks interactive card
					// permissions), fall back to non-streaming. We detect this by checking if
					// the error came from beginStreamingReply (before prompt execution started).
					if (streamErr?._streamingInitFailed) {
						logger.warn({ err: streamErr }, "[dispatcher] streaming card init failed, falling back to non-streaming");
						output = await this.opts.runPromptInSession(targetSessionPath, prompt, images.length > 0 ? images : undefined);
						await this.safeReply(channel, msg, output);
					} else {
						throw streamErr;
					}
				}
			} else {
				output = targetSessionPath
					? await this.opts.runPromptInSession(targetSessionPath, prompt, images.length > 0 ? images : undefined)
					: await this.opts.runPrompt(prompt, images.length > 0 ? images : undefined);
				await this.safeReply(channel, msg, output);
			}

			const sessionId = this.opts.getCurrentSessionId();
			this.opts.recordSessionChannel(msg.channel, sessionId);
			this.opts.maybeAutoGenerateTopic?.(sessionId);

			const finishedAt = new Date();
			this.runLog.append({
				runId,
				channel: msg.channel,
				messageId: msg.messageId,
				status: "success",
				startedAt: startedAt.toISOString(),
				finishedAt: finishedAt.toISOString(),
				durationMs: finishedAt.getTime() - startedAt.getTime(),
			});
		} catch (err) {
			const finishedAt = new Date();
			this.runLog.append({
				runId,
				channel: msg.channel,
				messageId: msg.messageId,
				status: "error",
				startedAt: startedAt.toISOString(),
				finishedAt: finishedAt.toISOString(),
				durationMs: finishedAt.getTime() - startedAt.getTime(),
				error: err instanceof Error ? err.message : String(err),
			});
			logger.error({ err }, "dispatcher agent error");
			await this.safeReply(channel, msg, "这次处理失败了，请稍后重试。");
		}
	}

	getRunLog(): ChannelRunLog {
		return this.runLog;
	}

	/** Build a stable key for a channel + chatId combo. */
	private chatKey(msg: IncomingMessage): string | null {
		if (!msg.chatId) return null;
		return `${msg.channel}:${msg.chatId}`;
	}

	/**
	 * Resolve the session file path for the given chatKey.
	 * Returns null if no binding exists or the file is gone.
	 */
	private resolveSessionPath(chatKey: string | null): string | null {
		if (!chatKey) return null;
		const targetSessionId = this.chatSessionMap[chatKey];
		if (!targetSessionId) return null;
		const sessionPath = resolve(join(this.opts.sessionDir, targetSessionId));
		if (!existsSync(sessionPath)) {
			// Session was deleted — remove stale mapping
			delete this.chatSessionMap[chatKey];
			this.saveChatSessionMap();
			return null;
		}
		return sessionPath;
	}

	private loadChatSessionMap(): ChatSessionMap {
		try {
			if (existsSync(this.chatSessionMapPath)) {
				return JSON.parse(readFileSync(this.chatSessionMapPath, "utf-8")) as ChatSessionMap;
			}
		} catch (err) {
			logger.warn({ err }, "failed to load chat-sessions.json, starting fresh");
			// ignore corrupt file
		}
		return {};
	}

	private saveChatSessionMap(): void {
		try {
			writeFileSync(this.chatSessionMapPath, JSON.stringify(this.chatSessionMap, null, 2), "utf-8");
		} catch (err) {
			logger.warn({ err }, "dispatcher failed to save chat-sessions.json");
		}
	}

	private async safeReply(channel: ChatChannel, msg: IncomingMessage, text: string): Promise<void> {
		try {
			await channel.reply(msg, text);
		} catch (err) {
			logger.error("dispatcher reply failed, retrying");
			try {
				await channel.reply(msg, text);
			} catch (retryErr) {
				logger.error({ err: retryErr }, "dispatcher reply retry also failed");
			}
		}
	}

	/**
	 * Handle a message using the streaming path: creates a streaming card,
	 * forwards events progressively, and finalizes on completion.
	 */
	private async handleStreaming(
		channel: ChatChannel & { beginStreamingReply: (msg: IncomingMessage) => Promise<import("./channel.js").StreamingReplyHandle> },
		msg: IncomingMessage,
		sessionPath: string,
		prompt: string,
		images: ImageContent[],
	): Promise<string> {
		let handle: import("./channel.js").StreamingReplyHandle;
		try {
			handle = await channel.beginStreamingReply(msg);
		} catch (err: any) {
			// Tag the error so the caller can detect streaming init failure vs prompt failure
			err._streamingInitFailed = true;
			throw err;
		}

		try {
			const output = await this.opts.runPromptStreamingInSession!(
				sessionPath,
				prompt,
				(event: ChannelStreamEvent) => {
					handle.onEvent(event);
				},
				images.length > 0 ? images : undefined,
			);
			await handle.finalize();
			return output;
		} catch (err) {
			handle.onEvent({
				type: "error",
				message: err instanceof Error ? err.message : String(err),
			});
			await handle.finalize();
			throw err;
		}
	}
}
