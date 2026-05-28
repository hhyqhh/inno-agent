import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

const ILINK_API = "https://ilinkai.weixin.qq.com";
const VER = "2.1.10";
const ILINK_APP_ID = "bot";
const ILINK_APP_CLIENT_VERSION = String((2 << 16) | (1 << 8) | 10);
const UA = `openclaw-weixin/${VER}`;
const MSG_USER = 1;
const MSG_BOT = 2;
const ITEM_TEXT = 1;
const STATE_FINISH = 2;

export class AuthExpiredError extends Error {
	constructor(message = "iLink auth expired") {
		super(message);
		this.name = "AuthExpiredError";
	}
}

export interface ILinkMessage {
	message_id: number;
	message_type: number;
	from_user_id: string;
	to_user_id: string;
	context_token?: string;
	item_list: Array<{
		type: number;
		text_item?: { text: string };
		image_item?: Record<string, unknown>;
		file_item?: Record<string, unknown>;
	}>;
}

export interface ILinkQrCode {
	qrcode: string;
	qrcode_img_content: string;
}

export interface ILinkQrStatus {
	status: string;
	bot_token?: string;
	ilink_bot_id?: string;
}

interface TokenData {
	bot_token: string;
	ilink_bot_id: string;
	updates_buf: string;
	login_time?: string;
}

function generateUin(): string {
	const buf = randomBytes(4);
	const num = buf.readUInt32BE(0);
	return Buffer.from(String(num)).toString("base64");
}

export class ILinkClient {
	token: string = "";
	botId: string = "";
	private updatesBuf: string = "";
	private tokenFilePath: string;

	constructor(tokenFilePath: string) {
		this.tokenFilePath = tokenFilePath;
		this.load();
	}

	get isLoggedIn(): boolean {
		return Boolean(this.token && this.botId);
	}

	private load(): void {
		if (!existsSync(this.tokenFilePath)) return;
		try {
			const data = JSON.parse(readFileSync(this.tokenFilePath, "utf-8")) as TokenData;
			this.token = data.bot_token ?? "";
			this.botId = data.ilink_bot_id ?? "";
			this.updatesBuf = data.updates_buf ?? "";
		} catch {
			// ignore corrupt file
		}
	}

	private save(extra?: Partial<TokenData>): void {
		const dir = dirname(this.tokenFilePath);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		const data: TokenData = {
			bot_token: this.token,
			ilink_bot_id: this.botId,
			updates_buf: this.updatesBuf,
			...extra,
		};
		writeFileSync(this.tokenFilePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
	}

	private buildHeaders(): Record<string, string> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			"AuthorizationType": "ilink_bot_token",
			"X-WECHAT-UIN": generateUin(),
			"iLink-App-Id": ILINK_APP_ID,
			"iLink-App-ClientVersion": ILINK_APP_CLIENT_VERSION,
			"User-Agent": UA,
		};
		if (this.token) {
			headers["Authorization"] = `Bearer ${this.token}`;
		}
		return headers;
	}

	private async post(endpoint: string, body: unknown, timeout = 15_000): Promise<Record<string, unknown>> {
		const resp = await fetch(`${ILINK_API}/${endpoint}`, {
			method: "POST",
			headers: this.buildHeaders(),
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeout),
		});
		if (!resp.ok) {
			throw new Error(`iLink ${endpoint} HTTP ${resp.status}`);
		}
		return resp.json() as Promise<Record<string, unknown>>;
	}

	async getQrCode(): Promise<ILinkQrCode> {
		const resp = await fetch(`${ILINK_API}/ilink/bot/get_bot_qrcode?bot_type=3`, {
			headers: { "User-Agent": UA },
			signal: AbortSignal.timeout(10_000),
		});
		if (!resp.ok) throw new Error(`getQrCode HTTP ${resp.status}`);
		const body = await resp.json() as Record<string, unknown>;
		console.log(`[wechat] getQrCode raw keys: ${Object.keys(body).join(", ")}`);
		// iLink may nest the fields directly or under a wrapper — handle both
		const qrcode = (body.qrcode ?? "") as string;
		const qrcode_img_content = (body.qrcode_img_content ?? "") as string;
		return { qrcode, qrcode_img_content };
	}

	async getQrCodeStatus(qrId: string): Promise<ILinkQrStatus> {
		const resp = await fetch(`${ILINK_API}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrId)}`, {
			headers: { "User-Agent": UA },
			signal: AbortSignal.timeout(60_000),
		});
		if (!resp.ok) throw new Error(`getQrCodeStatus HTTP ${resp.status}`);
		return resp.json() as Promise<ILinkQrStatus>;
	}

	confirmLogin(status: ILinkQrStatus): void {
		this.token = status.bot_token ?? "";
		this.botId = status.ilink_bot_id ?? "";
		this.updatesBuf = "";
		this.save({ login_time: new Date().toISOString() });
		console.log(`[wechat] QR login confirmed, bot_id=${this.botId}`);
	}

	async getUpdates(timeout = 30): Promise<ILinkMessage[]> {
		let resp: Record<string, unknown>;
		try {
			resp = await this.post(
				"ilink/bot/getupdates",
				{
					get_updates_buf: this.updatesBuf || "",
					base_info: { channel_version: VER },
				},
				(timeout + 5) * 1000,
			);
		} catch (err) {
			if (err instanceof Error && err.name === "TimeoutError") return [];
			throw err;
		}

		const errcode = resp.errcode as number | undefined;
		if (errcode) {
			if (errcode === -14) {
				this.updatesBuf = "";
				this.token = "";
				this.botId = "";
				this.save();
				throw new AuthExpiredError(String(resp.errmsg ?? ""));
			}
			console.warn(`[wechat] getUpdates errcode=${errcode}: ${resp.errmsg ?? ""}`);
			return [];
		}

		const newBuf = resp.get_updates_buf as string | undefined;
		if (newBuf) {
			this.updatesBuf = newBuf;
			this.save();
		}

		return (resp.msgs as ILinkMessage[] | undefined) ?? [];
	}

	async sendText(toUserId: string, text: string, contextToken?: string): Promise<void> {
		const msg: Record<string, unknown> = {
			from_user_id: "",
			to_user_id: toUserId,
			client_id: `inno-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
			message_type: MSG_BOT,
			message_state: STATE_FINISH,
			item_list: [{ type: ITEM_TEXT, text_item: { text } }],
		};
		if (contextToken) msg.context_token = contextToken;

		await this.post("ilink/bot/sendmessage", {
			msg,
			base_info: { channel_version: VER },
		});
	}

	clearAuth(): void {
		this.token = "";
		this.botId = "";
		this.updatesBuf = "";
		this.save();
	}

	static extractText(msg: ILinkMessage): string {
		return (msg.item_list ?? [])
			.filter((item) => item.type === ITEM_TEXT && item.text_item?.text)
			.map((item) => item.text_item!.text)
			.join("\n");
	}

	static isUserMessage(msg: ILinkMessage): boolean {
		return msg.message_type === MSG_USER;
	}
}
