import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { TranscriptionProvider, TranscriptionSession } from "../transcription-provider.js";
import type { TranscriptSegment, TranscriptionEvents, TranscriptionOptions } from "../types.js";

export interface DashScopeProviderConfig {
	websocketUrl: string;
	apiKey: string;
	model: string;
	vocabularyId: string;
	maxSentenceSilenceMs: number;
}

export class DashScopeTranscriptionProvider implements TranscriptionProvider {
	readonly id = "dashscope";

	constructor(private readonly config: DashScopeProviderConfig) {}

	start(options: TranscriptionOptions, events: TranscriptionEvents): TranscriptionSession {
		const taskId = randomUUID().replaceAll("-", "").slice(0, 32);
		const socket = new WebSocket(this.config.websocketUrl, {
			headers: { Authorization: `bearer ${this.config.apiKey}` },
		});
		let stopping = false;
		let settled = false;
		const connectTimer = setTimeout(() => fail(new Error("语音识别服务连接超时")), 20_000);

		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(connectTimer);
			events.onError(error);
			if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.terminate();
		};

		socket.on("open", () => {
			const parameters: Record<string, unknown> = {
				format: "pcm",
				sample_rate: options.sampleRate,
				max_sentence_silence: this.config.maxSentenceSilenceMs,
			};
			if (options.language) parameters.language_hints = [options.language];
			if (this.config.vocabularyId) parameters.vocabulary_id = this.config.vocabularyId;
			socket.send(JSON.stringify({
				header: { action: "run-task", task_id: taskId, streaming: "duplex" },
				payload: { task_group: "audio", task: "asr", function: "recognition", model: this.config.model, parameters, input: {} },
			}));
		});

		socket.on("message", (raw) => {
			let message: any;
			try { message = JSON.parse(raw.toString()); } catch { return; }
			const event = message?.header?.event;
			if (event === "task-started") {
				clearTimeout(connectTimer);
				events.onReady();
				return;
			}
			if (event === "result-generated") {
				const sentence = message?.payload?.output?.sentence;
				if (!sentence || typeof sentence.text !== "string") return;
				const segment: TranscriptSegment = {
					id: String(sentence.sentence_id ?? `${sentence.begin_time ?? 0}`),
					beginTime: Number(sentence.begin_time ?? 0),
					endTime: Number(sentence.end_time ?? sentence.begin_time ?? 0),
					text: sentence.text.trim(),
					final: sentence.sentence_end === true,
				};
				if (!segment.text) return;
				if (segment.final) events.onFinal(segment);
				else events.onPartial(segment);
				return;
			}
			if (event === "task-finished") {
				if (settled) return;
				settled = true;
				clearTimeout(connectTimer);
				events.onFinished();
				return;
			}
			if (event === "task-failed") fail(new Error(message?.header?.error_message || "语音识别失败"));
		});
		socket.on("error", (error) => fail(error));
		socket.on("close", () => {
			if (!settled && !stopping) fail(new Error("语音识别连接已断开"));
		});

		return {
			pushAudio(chunk) {
				if (!settled && socket.readyState === WebSocket.OPEN) socket.send(chunk, { binary: true });
			},
			finish() {
				if (settled || stopping) return;
				stopping = true;
				if (socket.readyState === WebSocket.OPEN) {
					socket.send(JSON.stringify({
						header: { action: "finish-task", task_id: taskId, streaming: "duplex" },
						payload: { input: {} },
					}));
				} else {
					settled = true;
					clearTimeout(connectTimer);
					events.onFinished();
				}
			},
			cancel() {
				settled = true;
				clearTimeout(connectTimer);
				if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.terminate();
			},
		};
	}
}
