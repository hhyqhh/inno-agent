import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { WebSocket as ClientWebSocket } from "ws";
import type { InnoMeetingConfig } from "../config.js";
import { logger } from "../logger.js";
import { createL2Note, saveL2MeetingDraft } from "../memory/l2/notes-service.js";

type MeetingState = "recording" | "summarizing" | "completed" | "no_speech" | "failed" | "interrupted";

interface TranscriptSentence {
	beginTime: number;
	endTime: number;
	text: string;
}

interface MeetingSession {
	id: string;
	title: string;
	rawPath: string;
	startedAt: number;
	state: MeetingState;
	client: ClientWebSocket;
	upstream: WebSocket;
	taskId: string;
	sentences: TranscriptSentence[];
	partialText: string;
	stopping: boolean;
	connectTimer: ReturnType<typeof setTimeout>;
}

export interface MeetingManagerDeps {
	l2DataDir: string;
	codeDir: string;
	getConfig: () => InnoMeetingConfig | undefined;
	summarize: (prompt: string) => Promise<string>;
}

function send(ws: ClientWebSocket, event: unknown): void {
	if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
}

function formatClock(milliseconds: number): string {
	const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}

function transcriptMarkdown(sentences: TranscriptSentence[]): string {
	if (sentences.length === 0) return "_尚未识别到有效语音。_";
	return sentences.map((sentence) => `- [${formatClock(sentence.beginTime)}] ${sentence.text}`).join("\n");
}

function recordingBody(title: string, sentences: TranscriptSentence[]): string {
	return `# ${title}\n\n> 正在录音并实时转写，内容尚未校对。\n\n## 会议纪要\n\n录音结束后自动生成。\n\n## 实时转写\n\n${transcriptMarkdown(sentences)}\n`;
}

function summarizingBody(title: string, sentences: TranscriptSentence[]): string {
	return `# ${title}\n\n> 纪要正在总结中，请稍候。转写内容已经保存，可以离开当前页面。\n\n## 会议纪要\n\n_正在根据会议转写整理摘要、决策事项和待办任务……_\n\n## 完整转写\n\n${transcriptMarkdown(sentences)}\n`;
}

function completedBody(title: string, summary: string, sentences: TranscriptSentence[]): string {
	return `# ${title}\n\n> AI 生成的会议纪要草稿，请在归档前核对。\n\n${summary.trim()}\n\n## 完整转写\n\n${transcriptMarkdown(sentences)}\n`;
}

function failedBody(title: string, message: string, sentences: TranscriptSentence[]): string {
	return `# ${title}\n\n> 纪要总结失败：${message}。完整转写已保留。\n\n## 会议纪要\n\n_总结失败，请稍后重新尝试。_\n\n## 完整转写\n\n${transcriptMarkdown(sentences)}\n`;
}

function noSpeechBody(title: string): string {
	return `# ${title}\n\n> 未识别到有效语音，本次录音未生成会议纪要。\n\n## 会议纪要\n\n_请检查麦克风权限、输入设备和录音音量后重试。_\n\n## 完整转写\n\n_尚未识别到有效语音。_\n`;
}

function summaryPrompt(title: string, sentences: TranscriptSentence[]): string {
	const transcript = sentences.map((sentence) => `[${formatClock(sentence.beginTime)}] ${sentence.text}`).join("\n");
	return `你是会议纪要助手。请根据以下逐字稿生成简洁、可核对的中文会议纪要。\n\n会议标题：${title}\n\n逐字稿：\n${transcript.slice(0, 60000)}\n\n只输出 Markdown，必须包含：\n## 核心摘要\n## 主要讨论\n## 决策事项\n## 待办事项\n## 风险与待确认问题\n\n规则：不得虚构发言人、负责人或截止日期；不能确认时写“待确认”；待办使用 Markdown 任务列表；重要结论尽量附上逐字稿时间点。`;
}

export class MeetingManager {
	private sessions = new Map<string, MeetingSession>();

	constructor(private deps: MeetingManagerDeps) {}

	bind(client: ClientWebSocket): void {
		let session: MeetingSession | null = null;
		client.on("message", (raw, isBinary) => {
			if (isBinary) {
				if (session?.state === "recording" && session.upstream.readyState === WebSocket.OPEN) {
					session.upstream.send(raw, { binary: true });
				}
				return;
			}
			let event: { type?: string; title?: string };
			try { event = JSON.parse(raw.toString()) as { type?: string; title?: string }; }
			catch { send(client, { type: "error", message: "Invalid meeting event" }); return; }
			if (event.type === "start" && !session) {
				void this.start(client, event.title).then((created) => { session = created; });
			} else if (event.type === "stop" && session) {
				this.stop(session);
			}
		});
		client.on("close", () => {
			if (session?.state === "recording") this.interrupt(session);
		});
	}

	private async start(client: ClientWebSocket, requestedTitle?: string): Promise<MeetingSession | null> {
		const config = this.deps.getConfig();
		const apiKey = config?.apiKey || process.env.DASHSCOPE_API_KEY || "";
		const websocketUrl = config?.websocketUrl || process.env.DASHSCOPE_WEBSOCKET_URL || "";
		if (!config?.enabled || !apiKey || !websocketUrl) {
			send(client, { type: "error", message: "请先在设置中启用并配置阿里云会议转写" });
			return null;
		}
		const now = new Date();
		const defaultTitle = `会议纪要 ${now.toLocaleString("zh-CN", { hour12: false }).replaceAll("/", "-")}`;
		const title = requestedTitle?.trim() || defaultTitle;
		const id = `meeting_${randomUUID().slice(0, 8)}`;
		const note = createL2Note(this.deps.l2DataDir, this.deps.codeDir, {
			title,
			tags: ["会议纪要"],
			content: recordingBody(title, []),
		});
		saveL2MeetingDraft(this.deps.l2DataDir, note.rawPath, {
			meetingId: id, meetingStatus: "recording", title, tags: ["会议纪要"], content: recordingBody(title, []),
		});
		send(client, { type: "draft_created", meetingId: id, rawPath: note.rawPath, title });

		const upstream = new WebSocket(websocketUrl, { headers: { Authorization: `bearer ${apiKey}` } });
		const session: MeetingSession = {
			id, title, rawPath: note.rawPath, startedAt: Date.now(), state: "recording", client, upstream,
			taskId: randomUUID().replaceAll("-", "").slice(0, 32), sentences: [], partialText: "", stopping: false,
			connectTimer: setTimeout(() => this.fail(session, "语音识别服务连接超时"), 20_000),
		};
		this.sessions.set(id, session);
		upstream.on("open", () => {
			const parameters: Record<string, unknown> = {
				format: "pcm", sample_rate: 16000, max_sentence_silence: config.maxSentenceSilenceMs,
			};
			if (config.vocabularyId) parameters.vocabulary_id = config.vocabularyId;
			upstream.send(JSON.stringify({
				header: { action: "run-task", task_id: session.taskId, streaming: "duplex" },
				payload: { task_group: "audio", task: "asr", function: "recognition", model: config.model, parameters, input: {} },
			}));
		});
		upstream.on("message", (raw) => this.handleUpstream(session, raw.toString()));
		upstream.on("error", (error) => this.fail(session, error.message));
		upstream.on("close", () => {
			if (session.state === "recording" && !session.stopping) this.fail(session, "语音识别连接已断开");
		});
		return session;
	}

	private handleUpstream(session: MeetingSession, raw: string): void {
		let message: any;
		try { message = JSON.parse(raw); } catch { return; }
		const event = message?.header?.event;
		if (event === "task-started") {
			clearTimeout(session.connectTimer);
			send(session.client, { type: "ready", meetingId: session.id });
			return;
		}
		if (event === "result-generated") {
			const sentence = message?.payload?.output?.sentence;
			if (!sentence || typeof sentence.text !== "string") return;
			if (sentence.sentence_end === true) {
				const finalSentence = {
					beginTime: Number(sentence.begin_time ?? 0),
					endTime: Number(sentence.end_time ?? sentence.begin_time ?? 0),
					text: sentence.text.trim(),
				};
				if (finalSentence.text) {
					const existing = session.sentences.findIndex((item) => item.beginTime === finalSentence.beginTime);
					if (existing >= 0) session.sentences[existing] = finalSentence;
					else session.sentences.push(finalSentence);
					saveL2MeetingDraft(this.deps.l2DataDir, session.rawPath, {
						meetingId: session.id, meetingStatus: "recording", content: recordingBody(session.title, session.sentences),
					});
					send(session.client, { type: "transcript_final", sentence: finalSentence });
				}
			} else {
				session.partialText = sentence.text;
				send(session.client, { type: "transcript_partial", text: sentence.text });
			}
			return;
		}
		if (event === "task-finished") void this.summarize(session);
		if (event === "task-failed") this.fail(session, message?.header?.error_message || "语音识别失败");
	}

	private stop(session: MeetingSession): void {
		if (session.stopping || session.state !== "recording") return;
		session.stopping = true;
		send(session.client, { type: "finishing_transcript" });
		if (session.upstream.readyState === WebSocket.OPEN) {
			session.upstream.send(JSON.stringify({
				header: { action: "finish-task", task_id: session.taskId, streaming: "duplex" }, payload: { input: {} },
			}));
		} else {
			void this.summarize(session);
		}
	}

	private async summarize(session: MeetingSession): Promise<void> {
		if (session.state !== "recording") return;
		clearTimeout(session.connectTimer);
		if (session.sentences.length === 0) {
			session.state = "no_speech";
			saveL2MeetingDraft(this.deps.l2DataDir, session.rawPath, {
				meetingId: session.id, meetingStatus: "no_speech", content: noSpeechBody(session.title),
			});
			send(session.client, { type: "no_speech", rawPath: session.rawPath });
			if (session.upstream.readyState === WebSocket.OPEN) session.upstream.close();
			setTimeout(() => this.sessions.delete(session.id), 60_000);
			return;
		}
		session.state = "summarizing";
		saveL2MeetingDraft(this.deps.l2DataDir, session.rawPath, {
			meetingId: session.id, meetingStatus: "summarizing", content: summarizingBody(session.title, session.sentences),
		});
		send(session.client, { type: "summarizing", rawPath: session.rawPath });
		try {
			const summary = await this.deps.summarize(summaryPrompt(session.title, session.sentences));
			if (!summary.trim()) throw new Error("文本模型未返回纪要");
			session.state = "completed";
			saveL2MeetingDraft(this.deps.l2DataDir, session.rawPath, {
				meetingId: session.id, meetingStatus: "completed", content: completedBody(session.title, summary, session.sentences),
			});
			send(session.client, { type: "completed", rawPath: session.rawPath });
		} catch (error) {
			this.fail(session, error instanceof Error ? error.message : "纪要总结失败");
		} finally {
			if (session.upstream.readyState === WebSocket.OPEN) session.upstream.close();
			setTimeout(() => this.sessions.delete(session.id), 60_000);
		}
	}

	private interrupt(session: MeetingSession): void {
		clearTimeout(session.connectTimer);
		session.state = "interrupted";
		saveL2MeetingDraft(this.deps.l2DataDir, session.rawPath, {
			meetingId: session.id, meetingStatus: "interrupted", content: failedBody(session.title, "录音连接已中断", session.sentences),
		});
		if (session.upstream.readyState === WebSocket.OPEN || session.upstream.readyState === WebSocket.CONNECTING) {
			session.upstream.terminate();
		}
		this.sessions.delete(session.id);
	}

	private fail(session: MeetingSession, message: string): void {
		if (session.state === "failed" || session.state === "completed") return;
		clearTimeout(session.connectTimer);
		session.state = "failed";
		logger.warn({ meetingId: session.id, message }, "meeting transcription failed");
		saveL2MeetingDraft(this.deps.l2DataDir, session.rawPath, {
			meetingId: session.id, meetingStatus: "failed", content: failedBody(session.title, message, session.sentences),
		});
		send(session.client, { type: "error", message, rawPath: session.rawPath });
		if (session.upstream.readyState === WebSocket.OPEN || session.upstream.readyState === WebSocket.CONNECTING) {
			session.upstream.terminate();
		}
		setTimeout(() => this.sessions.delete(session.id), 60_000);
	}
}
