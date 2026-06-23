import * as Lark from "@larksuiteoapi/node-sdk";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { RealtimeChatChannel, MessageHandler } from "../channel.js";
import type { IncomingMessage, PushTarget, MessageAttachment } from "../types.js";
import type { PersonalChannelConfig } from "../../config.js";
import { FeishuAPI, type FeishuConfig } from "./feishu-api.js";
import { logger } from "../../logger.js";

const SUPPORTED_TYPES = new Set(["text", "image", "file", "post"]);

export class FeishuChannel implements RealtimeChatChannel {
	readonly name = "feishu";
	private api: FeishuAPI;
	private wsClient: Lark.WSClient;
	private messageHandler: MessageHandler | null = null;
	private processedMessages = new Set<string>();
	private downloadDir: string;
	private personalOnly: boolean;
	private allowedUserIds: Set<string> | null;
	private cleanupTimer: ReturnType<typeof setInterval> | null = null;

	constructor(
		feishuConfig: FeishuConfig,
		dataDir?: string,
		channelConfig?: PersonalChannelConfig,
	) {
		this.api = new FeishuAPI(feishuConfig);
		this.wsClient = new Lark.WSClient({
			appId: feishuConfig.appId,
			appSecret: feishuConfig.appSecret,
			loggerLevel: Lark.LoggerLevel.info,
		});
		this.downloadDir = join(dataDir ?? "data", "downloads");
		mkdirSync(this.downloadDir, { recursive: true });

		this.personalOnly = channelConfig?.personalOnly ?? true;
		this.allowedUserIds = channelConfig?.allowedUserIds?.length
			? new Set(channelConfig.allowedUserIds)
			: null;

		this.cleanupTimer = setInterval(() => {
			if (this.processedMessages.size > 1000) {
				this.processedMessages.clear();
			}
		}, 60_000);
	}

	onMessage(handler: MessageHandler): void {
		this.messageHandler = handler;
	}

	start(): void {
		const eventDispatcher = new Lark.EventDispatcher({}).register({
			"im.message.receive_v1": async (data) => {
				const msg = await this.parseEvent(data);
				if (msg && this.messageHandler) {
					this.messageHandler(msg);
				}
			},
		});

		this.wsClient.start({ eventDispatcher });
		logger.info("[feishu] WebSocket client started");
	}

	async stop(): Promise<void> {
		try {
			this.wsClient.close();
		} catch (err) {
			logger.warn({ err }, "[feishu] error closing WebSocket client");
		}
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = null;
		}
		this.processedMessages.clear();
		logger.info("[feishu] channel stopped");
	}

	/**
	 * Auto-discover the bot's p2p chats and return the first one as a PushTarget.
	 * This eliminates the chicken-and-egg problem where the user must send a
	 * message FROM Feishu before the agent can send TO Feishu.
	 */
	async discoverDefaultTarget(): Promise<PushTarget | null> {
		try {
			const resp = await this.api.client.im.v1.chat.list({
				params: { page_size: 20 },
			});
			if (resp.code !== 0) {
				logger.warn({ code: resp.code, msg: resp.msg }, "[feishu] chat.list failed");
				return null;
			}
			const items = resp.data?.items;
			if (!items || items.length === 0) return null;

			// Find a p2p chat (direct message with a user)
			const p2pChat = items.find((item: Record<string, unknown>) => item.chat_mode === "p2p");
			if (!p2pChat) return null;

			const chatId = (p2pChat as Record<string, unknown>).chat_id as string | undefined;
			if (!chatId) return null;

			logger.info({ chatId }, "[feishu] auto-discovered default p2p target");
			return { channel: "feishu", chatId };
		} catch (err) {
			logger.warn({ err }, "[feishu] discoverDefaultTarget failed");
			return null;
		}
	}

	private async parseEvent(data: Record<string, unknown>): Promise<IncomingMessage | null> {
		try {
			const message = data.message as Record<string, unknown> | undefined;
			const sender = data.sender as Record<string, unknown> | undefined;
			if (!message) return null;

			const messageId = message.message_id as string;
			const chatId = message.chat_id as string;
			const chatType = message.chat_type as string | undefined;
			const messageType = message.message_type as string;

			if (this.processedMessages.has(messageId)) return null;
			this.processedMessages.add(messageId);

			if (this.personalOnly && chatType !== "p2p") {
				return null;
			}

			if (!SUPPORTED_TYPES.has(messageType)) return null;

			const senderType = (sender as Record<string, unknown>)?.sender_type as string | undefined;
			if (senderType !== "user") return null;

			const senderId = ((sender as Record<string, unknown>)?.sender_id as Record<string, unknown>)
				?.open_id as string | undefined;

			if (this.allowedUserIds && senderId && !this.allowedUserIds.has(senderId)) {
				console.debug(`[feishu] ignoring message from non-allowed user: ${senderId}`);
				return null;
			}

			const contentStr = message.content as string;
			let text = "";
			const attachments: MessageAttachment[] = [];

			if (messageType === "text") {
				const content = JSON.parse(contentStr) as { text: string };
				text = content.text?.trim() ?? "";
			} else if (messageType === "post") {
				const content = JSON.parse(contentStr) as {
					title?: string;
					content?: Array<Array<{ tag: string; text?: string }>>;
					zh_cn?: { title?: string; content?: Array<Array<{ tag: string; text?: string }>> };
				};
				const localized = content.zh_cn ?? content;
				const parts: string[] = [];
				if (localized.title) parts.push(localized.title);
				for (const paragraph of localized.content ?? []) {
					for (const element of paragraph) {
						if ((element.tag === "text" || element.tag === "md") && element.text) {
							parts.push(element.text);
						}
					}
				}
				text = parts.join("\n").trim();
			} else if (messageType === "image") {
				const content = JSON.parse(contentStr) as { image_key: string };
				const attachment = await this.downloadResource(messageId, content.image_key, "image");
				if (attachment) attachments.push(attachment);
				text = "[用户发送了一张图片]";
			} else if (messageType === "file") {
				const content = JSON.parse(contentStr) as { file_key: string; file_name: string };
				const attachment = await this.downloadResource(
					messageId, content.file_key, "file", content.file_name,
				);
				if (attachment) {
					attachments.push(attachment);
					text = `[用户发送了文件: ${content.file_name}]`;
				}
			}

			if (!text && attachments.length === 0) return null;

			return {
				channel: "feishu",
				messageId,
				chatId,
				userId: senderId,
				text,
				attachments: attachments.length > 0 ? attachments : undefined,
				raw: data,
			};
		} catch (err) {
			logger.error({ err }, "Feishu message parse error");
			return null;
		}
	}

	private async downloadResource(
		messageId: string,
		fileKey: string,
		type: "image" | "file",
		fileName?: string,
	): Promise<MessageAttachment | null> {
		try {
			const resp = await this.api.client.im.v1.messageResource.get({
				params: { type },
				path: { message_id: messageId, file_key: fileKey },
			});

			if (!resp) return null;

			if (type === "image") {
				const stream = resp.getReadableStream();
				const chunks: Buffer[] = [];
				for await (const chunk of stream) {
					chunks.push(Buffer.from(chunk as Uint8Array));
				}
				const buffer = Buffer.concat(chunks);
				const data = buffer.toString("base64");

				return {
					type: "image",
					fileName: fileName ?? `${fileKey}.png`,
					mimeType: "image/png",
					data,
				};
			}

			const safeName = fileName ?? fileKey;
			const filePath = join(this.downloadDir, `${messageId}_${safeName}`);
			await resp.writeFile(filePath);

			const ext = safeName.toLowerCase().split(".").pop() ?? "";
			const imageExts = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);

			if (imageExts.has(ext)) {
				const { readFileSync } = await import("node:fs");
				const buffer = readFileSync(filePath);
				const mimeMap: Record<string, string> = {
					png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
					gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
				};
				return {
					type: "image",
					fileName: safeName,
					mimeType: mimeMap[ext] ?? "image/png",
					data: buffer.toString("base64"),
					filePath,
				};
			}

			return {
				type: "file",
				fileName: safeName,
				filePath,
			};
		} catch (err) {
			logger.error({ err, fileKey }, "Feishu download resource error");
			return null;
		}
	}

	async verify(): Promise<boolean> {
		return true;
	}

	async parse(): Promise<IncomingMessage | null> {
		return null;
	}

	async reply(message: IncomingMessage, text: string): Promise<void> {
		await this.api.replyMessage(message.messageId, text);
	}

	async push(target: PushTarget, text: string): Promise<void> {
		await this.api.sendMessage(target.chatId, text);
	}

	async sendFile(target: PushTarget, filePath: string, fileName?: string): Promise<void> {
		await this.api.sendFile(target.chatId, filePath, fileName);
	}
}
