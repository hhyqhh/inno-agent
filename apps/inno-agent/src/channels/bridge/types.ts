import type { ChannelName } from "../types.js";

export interface BridgeMessageBody {
	channel: ChannelName;
	messageId: string;
	chatId: string;
	userId: string;
	text: string;
	attachments?: Array<{
		type: "image" | "file";
		fileName?: string;
		mimeType?: string;
		data?: string;
		filePath?: string;
	}>;
	raw?: unknown;
}

export interface BridgeReplyBody {
	channel: ChannelName;
	messageId: string;
	chatId: string;
	text: string;
}

export interface BridgePushBody {
	channel: ChannelName;
	chatId: string;
	text: string;
}

export interface BridgeMessageResponse {
	ok: boolean;
	runId?: string;
	error?: string;
}

export interface BridgeHealthStatus {
	channel: string;
	sidecarUrl: string;
	healthy: boolean;
	checkedAt: string;
	error?: string;
}
