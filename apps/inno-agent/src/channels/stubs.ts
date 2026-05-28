import type { ChatChannel } from "./channel.js";
import type { IncomingMessage, PushTarget } from "./types.js";

/**
 * WeChat Enterprise (WeCom) channel stub — not yet implemented.
 */
export class WeComChannel implements ChatChannel {
	readonly name = "wecom";
	async verify(): Promise<boolean> {
		throw new Error("WeCom channel not implemented");
	}
	async parse(): Promise<IncomingMessage | null> {
		throw new Error("WeCom channel not implemented");
	}
	async reply(): Promise<void> {
		throw new Error("WeCom channel not implemented");
	}
	async push(): Promise<void> {
		throw new Error("WeCom channel not implemented");
	}
}
