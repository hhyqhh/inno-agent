import type { IncomingMessage, PushTarget } from "./types.js";
import { readJson, writeJson } from "../storage/file-store.js";

export interface ChatChannel {
	readonly name: string;
	verify(req: { headers: Record<string, string>; body: unknown }): Promise<boolean>;
	parse(body: unknown): Promise<IncomingMessage | null>;
	reply(message: IncomingMessage, text: string): Promise<void>;
	push(target: PushTarget, text: string): Promise<void>;
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
