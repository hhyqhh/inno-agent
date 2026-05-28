export type ChannelName = "feishu" | "qq" | "wechat" | "wecom" | "cli";

export interface MessageAttachment {
	/** File type: image, file, audio, video */
	type: "image" | "file" | "audio" | "video";
	/** Original file name */
	fileName?: string;
	/** MIME type */
	mimeType?: string;
	/** Base64 encoded data (for images) */
	data?: string;
	/** Local file path (for downloaded files) */
	filePath?: string;
}

export interface IncomingMessage {
	channel: ChannelName;
	messageId: string;
	chatId?: string;
	userId?: string;
	text: string;
	attachments?: MessageAttachment[];
	raw: unknown;
}

export interface PushTarget {
	channel: ChannelName;
	chatId: string;
}
