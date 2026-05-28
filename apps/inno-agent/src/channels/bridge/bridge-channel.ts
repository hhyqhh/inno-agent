import type { ChatChannel } from "../channel.js";
import type { IncomingMessage, PushTarget, ChannelName } from "../types.js";
import type { BridgeReplyBody, BridgePushBody, BridgeHealthStatus } from "./types.js";

export class BridgeChannel implements ChatChannel {
	readonly name: string;
	private sidecarBaseUrl: string;
	private token: string;

	constructor(channelName: ChannelName, sidecarBaseUrl: string, token: string) {
		this.name = channelName;
		this.sidecarBaseUrl = sidecarBaseUrl.replace(/\/+$/, "");
		this.token = token;
	}

	async verify(): Promise<boolean> {
		return true;
	}

	async parse(): Promise<IncomingMessage | null> {
		return null;
	}

	async reply(message: IncomingMessage, text: string): Promise<void> {
		const body: BridgeReplyBody = {
			channel: message.channel,
			messageId: message.messageId,
			chatId: message.chatId ?? "",
			text,
		};
		await this.callSidecar("/reply", body);
	}

	async push(target: PushTarget, text: string): Promise<void> {
		const body: BridgePushBody = {
			channel: target.channel,
			chatId: target.chatId,
			text,
		};
		await this.callSidecar("/push", body);
	}

	async checkHealth(): Promise<BridgeHealthStatus> {
		const checkedAt = new Date().toISOString();
		try {
			const resp = await fetch(`${this.sidecarBaseUrl}/health`, {
				method: "GET",
				signal: AbortSignal.timeout(5000),
			});
			return {
				channel: this.name,
				sidecarUrl: this.sidecarBaseUrl,
				healthy: resp.ok,
				checkedAt,
			};
		} catch (err) {
			return {
				channel: this.name,
				sidecarUrl: this.sidecarBaseUrl,
				healthy: false,
				checkedAt,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	private async callSidecar(path: string, body: unknown): Promise<void> {
		const url = `${this.sidecarBaseUrl}${path}`;
		try {
			const resp = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Authorization": `Bearer ${this.token}`,
				},
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(30_000),
			});
			if (!resp.ok) {
				const text = await resp.text().catch(() => "");
				throw new Error(`Sidecar ${path} returned ${resp.status}: ${text}`);
			}
		} catch (err) {
			console.error(`[bridge:${this.name}] sidecar call ${path} failed:`, err instanceof Error ? err.message : err);
			throw err;
		}
	}
}
