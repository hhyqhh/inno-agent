import { join } from "node:path";
import type { RealtimeChatChannel, MessageHandler } from "../channel.js";
import type { IncomingMessage, PushTarget } from "../types.js";
import type { PersonalChannelConfig } from "../../config.js";
import { ILinkClient, AuthExpiredError, type ILinkMessage } from "./ilink-client.js";

export class WeChatChannel implements RealtimeChatChannel {
	readonly name = "wechat";
	private client: ILinkClient;
	private messageHandler: MessageHandler | null = null;
	private running = false;
	private pollAbort: AbortController | null = null;
	private processedMessages = new Set<number>();
	private personalOnly: boolean;
	private allowedUserIds: Set<string> | null;
	private contextTokens = new Map<string, string>();

	constructor(dataDir: string, channelConfig?: PersonalChannelConfig) {
		const tokenPath = join(dataDir, "channels", "wechat-token.json");
		this.client = new ILinkClient(tokenPath);
		this.personalOnly = channelConfig?.personalOnly ?? true;
		this.allowedUserIds = channelConfig?.allowedUserIds?.length
			? new Set(channelConfig.allowedUserIds)
			: null;

		setInterval(() => {
			if (this.processedMessages.size > 5000) {
				const arr = [...this.processedMessages];
				this.processedMessages = new Set(arr.slice(-2000));
			}
		}, 60_000);
	}

	get isConnected(): boolean {
		return this.client.isLoggedIn && this.running;
	}

	get botId(): string {
		return this.client.botId;
	}

	getClient(): ILinkClient {
		return this.client;
	}

	onMessage(handler: MessageHandler): void {
		this.messageHandler = handler;
	}

	start(): void {
		if (!this.client.isLoggedIn) {
			console.log("[wechat] not logged in, skipping start");
			return;
		}
		if (this.running) return;
		this.running = true;
		console.log(`[wechat] starting message loop (bot_id=${this.client.botId})`);
		void this.pollLoop();
	}

	async stop(): Promise<void> {
		this.running = false;
		this.pollAbort?.abort();
	}

	private async pollLoop(): Promise<void> {
		while (this.running) {
			try {
				const msgs = await this.client.getUpdates(30);
				for (const msg of msgs) {
					if (!ILinkClient.isUserMessage(msg)) continue;
					if (this.processedMessages.has(msg.message_id)) continue;
					this.processedMessages.add(msg.message_id);

					const parsed = this.parseMessage(msg);
					if (parsed && this.messageHandler) {
						this.messageHandler(parsed);
					}
				}
			} catch (err) {
				if (err instanceof AuthExpiredError) {
					console.error("[wechat] auth expired, stopping poll loop");
					this.running = false;
					return;
				}
				console.error("[wechat] poll error:", err instanceof Error ? err.message : err);
				await new Promise((r) => setTimeout(r, 5000));
			}
		}
	}

	private parseMessage(msg: ILinkMessage): IncomingMessage | null {
		const userId = msg.from_user_id;

		if (this.allowedUserIds && userId && !this.allowedUserIds.has(userId)) {
			return null;
		}

		const text = ILinkClient.extractText(msg).trim();
		if (!text) return null;

		if (msg.context_token) {
			this.contextTokens.set(userId, msg.context_token);
		}

		return {
			channel: "wechat",
			messageId: String(msg.message_id),
			chatId: userId,
			userId,
			text,
			raw: msg,
		};
	}

	async verify(): Promise<boolean> {
		return true;
	}

	async parse(): Promise<IncomingMessage | null> {
		return null;
	}

	async reply(message: IncomingMessage, text: string): Promise<void> {
		const raw = message.raw as ILinkMessage | undefined;
		const contextToken = raw?.context_token ?? this.contextTokens.get(message.userId ?? "");
		await this.client.sendText(message.userId ?? message.chatId ?? "", text, contextToken);
	}

	async push(target: PushTarget, text: string): Promise<void> {
		const contextToken = this.contextTokens.get(target.chatId);
		await this.client.sendText(target.chatId, text, contextToken);
	}
}
