import type { IncomingMessage, PushTarget } from "./types.js";
import { readJson, writeJson } from "../storage/file-store.js";

/** Thrown when a channel cannot send files (e.g. WeChat iLink). */
export class FileSendNotSupportedError extends Error {
	constructor(channelName: string) {
		super(`渠道「${channelName}」暂不支持发送文件。`);
		this.name = "FileSendNotSupportedError";
	}
}

export interface ChatChannel {
	readonly name: string;
	verify(req: { headers: Record<string, string>; body: unknown }): Promise<boolean>;
	parse(body: unknown): Promise<IncomingMessage | null>;
	reply(message: IncomingMessage, text: string): Promise<void>;
	push(target: PushTarget, text: string): Promise<void>;
	/**
	 * Send a local file to a push target. Optional: channels that do not support
	 * file delivery throw {@link FileSendNotSupportedError}.
	 */
	sendFile?(target: PushTarget, filePath: string, fileName?: string): Promise<void>;
}

/**
 * A streaming event forwarded from the agent loop to the channel during streaming reply.
 */
export interface ChannelStreamEvent {
	type: "text_delta" | "thinking_delta" | "tool_start" | "tool_end" | "error" | "done";
	delta?: string;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	summary?: string;
	message?: string;
}

/**
 * Channels that support progressive/streaming card updates implement this interface.
 * The dispatcher uses it to send real-time updates instead of waiting for the full response.
 */
export interface StreamingReplyChannel extends ChatChannel {
	readonly supportsStreamingReply: boolean;
	/**
	 * Begin a streaming reply. Sends an initial placeholder card and returns
	 * a handle that accepts streaming events and a finalize method.
	 */
	beginStreamingReply(message: IncomingMessage): Promise<StreamingReplyHandle>;
}

export interface StreamingReplyHandle {
	/** Forward a streaming event to update the card. */
	onEvent(event: ChannelStreamEvent): void;
	/** Finalize the card after all events are done. Must be called. */
	finalize(): Promise<void>;
}

export function isStreamingChannel(ch: ChatChannel): ch is StreamingReplyChannel {
	return "supportsStreamingReply" in ch && (ch as StreamingReplyChannel).supportsStreamingReply;
}

export type MessageHandler = (msg: IncomingMessage) => Promise<void> | void;

export interface RealtimeChatChannel extends ChatChannel {
	onMessage(handler: MessageHandler): void;
	start(): Promise<void> | void;
	stop?(): Promise<void>;
}

export class ChannelRegistry {
	private _channels = new Map<string, ChatChannel>();
	private _defaultTargets = new Map<string, PushTarget>();

	constructor(private defaultTargetsPath?: string) {
		if (!defaultTargetsPath) return;
		const targets = readJson<PushTarget[]>(defaultTargetsPath, []);
		for (const target of targets) {
			this._defaultTargets.set(target.channel, target);
		}
	}

	register(channel: ChatChannel): void {
		this._channels.set(channel.name, channel);
	}

	get(name: string): ChatChannel | undefined {
		return this._channels.get(name);
	}

	all(): ChatChannel[] {
		return [...this._channels.values()];
	}

	setDefaultTarget(target: PushTarget): void {
		this._defaultTargets.set(target.channel, target);
		if (this.defaultTargetsPath) {
			writeJson(this.defaultTargetsPath, [...this._defaultTargets.values()]);
		}
	}

	getDefaultTarget(channelName: string): PushTarget | undefined {
		return this._defaultTargets.get(channelName);
	}
}
