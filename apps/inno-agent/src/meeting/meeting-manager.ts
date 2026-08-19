import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import type { WebSocket as ClientWebSocket } from "ws";
import type { InnoMeetingConfig } from "../config.js";
import { logger } from "../logger.js";
import { createL2Note, readNoteContent, saveL2MeetingDraft } from "../memory/l2/notes-service.js";
import { DashScopeTranscriptionProvider } from "./providers/dashscope-provider.js";
import type { TranscriptionProvider, TranscriptionSession } from "./transcription-provider.js";
import type { MeetingState, TranscriptSegment } from "./types.js";
import { MeetingArtifactStore, type MeetingImportJob, type MeetingMetadata } from "./meeting-artifact-store.js";

type TranscriptSentence = Pick<TranscriptSegment, "beginTime" | "endTime" | "text"> & { id?: string };

interface MeetingSession {
	id: string;
	title: string;
	rawPath: string;
	startedAt: number;
	state: MeetingState;
	client: ClientWebSocket | null;
	transcription: TranscriptionSession;
	sentences: TranscriptSentence[];
	partialText: string;
	stopping: boolean;
	reconnectTimer: ReturnType<typeof setTimeout> | null;
	saveAudio: boolean;
}

export interface MeetingManagerDeps {
	l2DataDir: string;
	codeDir: string;
	meetingsDir: string;
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

function mergeMeetingBlock(originalContent: string, meetingId: string, title: string, meetingContent: string, replaceExisting: boolean): string {
	const startMarker = `<!-- inno-meeting:${meetingId}:start -->`;
	const endMarker = `<!-- inno-meeting:${meetingId}:end -->`;
	const sectionBody = meetingContent.replace(/^# [^\n]*\n+/, "").replace(/^## /gm, "### ").trim();
	const heading = `## 录音记录：${title}`;
	const block = `${heading}\n\n${sectionBody}`;
	const start = originalContent.indexOf(startMarker);
	const end = originalContent.indexOf(endMarker);
	if (start >= 0 && end >= start) {
		return `${originalContent.slice(0, start)}${block}${originalContent.slice(end + endMarker.length)}`;
	}
	if (replaceExisting) {
		const sectionStart = originalContent.lastIndexOf(heading);
		if (sectionStart >= 0) return `${originalContent.slice(0, sectionStart)}${block}\n`;
	}
	return `${originalContent.trimEnd()}\n\n${block}\n`;
}

function summaryPrompt(title: string, sentences: TranscriptSentence[]): string {
	const transcript = sentences.map((sentence) => `[${formatClock(sentence.beginTime)}] ${sentence.text}`).join("\n");
	return `你是会议纪要助手。请根据以下逐字稿生成简洁、可核对的中文会议纪要。\n\n会议标题：${title}\n\n逐字稿：\n${transcript.slice(0, 60000)}\n\n只输出 Markdown，必须包含：\n## 核心摘要\n## 主要讨论\n## 决策事项\n## 待办事项\n## 风险与待确认问题\n\n规则：不得虚构发言人、负责人或截止日期；不能确认时写“待确认”；待办使用 Markdown 任务列表；重要结论尽量附上逐字稿时间点。`;
}

export class MeetingManager {
	private sessions = new Map<string, MeetingSession>();
	private artifacts: MeetingArtifactStore;
	private importQueue: Promise<void> = Promise.resolve();

	constructor(private deps: MeetingManagerDeps) {
		this.artifacts = new MeetingArtifactStore(deps.meetingsDir);
		for (const stale of this.artifacts.listActive()) {
			const segments = this.artifacts.readSegments(stale.id);
			const message = stale.state === "summarizing" ? "服务重启导致纪要生成中断" : "服务重启导致录音中断";
			this.artifacts.finalizeAudio(stale.id);
			this.artifacts.update(stale.id, { state: "interrupted", error: message });
			this.saveMetadataDraft(stale, "interrupted", failedBody(stale.title, message, segments));
		}
		for (const job of this.artifacts.listPendingJobs()) {
			this.artifacts.versionAndClearSegments(job.meetingId);
			this.enqueueImport(job, this.artifacts.resolveJobInput(job), job.needsConversion);
		}
	}

	private send(session: MeetingSession, event: unknown): void {
		if (session.client) send(session.client, event);
	}

	bind(client: ClientWebSocket): void {
		let session: MeetingSession | null = null;
		client.on("message", (raw, isBinary) => {
			if (isBinary) {
				if (session?.state === "recording") {
					const chunk = Buffer.from(raw as Buffer);
					session.transcription.pushAudio(chunk);
					if (session.saveAudio) this.artifacts.appendAudio(session.id, chunk);
				}
				return;
			}
			let event: { type?: string; title?: string; rawPath?: string; meetingId?: string };
			try { event = JSON.parse(raw.toString()) as { type?: string; title?: string; rawPath?: string; meetingId?: string }; }
			catch { send(client, { type: "error", message: "Invalid meeting event" }); return; }
			if (event.type === "start" && !session) {
				void this.start(client, event.rawPath, event.title).then((created) => { session = created; });
			} else if (event.type === "stop" && session) {
				this.stop(session);
			} else if (event.type === "pause" && session) {
				this.pause(session);
			} else if (event.type === "resume" && session) {
				this.resume(session);
			} else if (event.type === "reconnect" && !session && event.meetingId) {
				session = this.reconnect(client, event.meetingId);
			}
		});
		client.on("close", () => {
			if (session && ["connecting", "recording", "paused"].includes(session.state)) this.detach(session);
		});
	}

	private async start(client: ClientWebSocket, requestedRawPath?: string, requestedTitle?: string): Promise<MeetingSession | null> {
		const config = this.deps.getConfig();
		const apiKey = config?.apiKey || process.env.DASHSCOPE_API_KEY || "";
		const websocketUrl = config?.websocketUrl || process.env.DASHSCOPE_WEBSOCKET_URL || "";
		if (!config?.enabled || config.transcriptionProvider !== "dashscope" || !apiKey || !websocketUrl) {
			send(client, { type: "error", message: "请先在设置中启用并配置阿里云会议转写" });
			return null;
		}
		const rawPath = requestedRawPath?.trim().replace(/\\/g, "/") ?? "";
		if (!rawPath.startsWith("raw/notes/")) {
			send(client, { type: "error", message: "请先选择一篇可编辑笔记再开始录音" });
			return null;
		}
		let note;
		try {
			note = readNoteContent(this.deps.l2DataDir, rawPath);
		} catch (error) {
			send(client, { type: "error", message: error instanceof Error ? error.message : "无法读取当前笔记" });
			return null;
		}
		const title = requestedTitle?.trim() || note.title;
		const id = `meeting_${randomUUID().slice(0, 8)}`;
		if (this.isRawPathActive(rawPath)) {
			send(client, { type: "error", message: "当前笔记已有正在进行的录音" });
			return null;
		}
		try {
			this.saveEmbeddedDraft(rawPath, id, title, "connecting", recordingBody(title, []));
		} catch (error) {
			send(client, { type: "error", message: error instanceof Error ? error.message : "无法更新当前笔记" });
			return null;
		}
		send(client, { type: "draft_created", meetingId: id, rawPath, title, audioAvailable: config.saveAudio });
		this.artifacts.create({ id, title, rawPath, state: "connecting", startedAt: Date.now(), embedded: true }, config.saveAudio);

		const provider = this.createProvider(config, apiKey, websocketUrl);
		let session!: MeetingSession;
		let transcription: TranscriptionSession;
		try {
			transcription = provider.start({ sampleRate: 16000, language: config.language }, {
				onReady: () => {
					if (session.state !== "connecting") return;
					session.state = "recording";
					try {
						this.saveSessionDraft(session, "recording", recordingBody(session.title, session.sentences));
					} catch (error) {
						this.handleDraftWriteFailure(session, error);
						return;
					}
				this.artifacts.update(session.id, { state: "recording" });
				this.send(session, { type: "ready", meetingId: session.id });
			},
			onPartial: (segment) => {
				session.partialText = segment.text;
				this.send(session, { type: "transcript_partial", segment, text: segment.text });
			},
			onFinal: (segment) => {
				const finalSentence: TranscriptSentence = segment;
				const existing = session.sentences.findIndex((item) => item.id === segment.id || item.beginTime === segment.beginTime);
				if (existing >= 0) session.sentences[existing] = finalSentence;
				else session.sentences.push(finalSentence);
				this.artifacts.appendSegment(session.id, segment);
					try {
						this.saveSessionDraft(session, "recording", recordingBody(session.title, session.sentences));
					} catch (error) {
						this.handleDraftWriteFailure(session, error);
						return;
					}
				this.send(session, { type: "transcript_final", segment, sentence: finalSentence });
			},
			onFinished: () => void this.summarize(session),
				onError: (error) => this.fail(session, error.message),
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : "无法启动语音识别";
				this.saveEmbeddedDraft(rawPath, id, title, "failed", failedBody(title, message, []));
			send(client, { type: "error", message, rawPath });
			return null;
		}
		session = {
			id, title, rawPath, startedAt: Date.now(), state: "connecting", client,
			transcription, sentences: [], partialText: "", stopping: false, reconnectTimer: null, saveAudio: config.saveAudio,
		};
		this.sessions.set(id, session);
		return session;
	}

	private createProvider(config: InnoMeetingConfig, apiKey: string, websocketUrl: string): TranscriptionProvider {
		return new DashScopeTranscriptionProvider({
			apiKey,
			websocketUrl,
			model: config.model,
			vocabularyId: config.vocabularyId,
			maxSentenceSilenceMs: config.maxSentenceSilenceMs,
		});
	}

	private stop(session: MeetingSession): void {
		if (session.stopping || (session.state !== "recording" && session.state !== "paused")) return;
		session.stopping = true;
		session.state = "finishing";
		this.artifacts.update(session.id, { state: "finishing" });
		this.artifacts.finalizeAudio(session.id);
		this.send(session, { type: "finishing_transcript" });
		session.transcription.finish();
	}

	private pause(session: MeetingSession): void {
		if (session.state !== "recording") return;
		session.state = "paused";
		this.artifacts.update(session.id, { state: "paused" });
		this.saveSessionDraft(session, "paused", recordingBody(session.title, session.sentences));
		this.send(session, { type: "paused" });
	}

	private resume(session: MeetingSession): void {
		if (session.state !== "paused") return;
		session.state = "recording";
		this.artifacts.update(session.id, { state: "recording" });
		this.saveSessionDraft(session, "recording", recordingBody(session.title, session.sentences));
		this.send(session, { type: "resumed" });
	}

	private detach(session: MeetingSession): void {
		session.client = null;
		if (session.state === "recording") {
			session.state = "paused";
			this.saveSessionDraft(session, "paused", recordingBody(session.title, session.sentences));
		}
		this.artifacts.update(session.id, { state: session.state });
		if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
		session.reconnectTimer = setTimeout(() => this.interrupt(session), 30_000);
	}

	private reconnect(client: ClientWebSocket, meetingId: string): MeetingSession | null {
		const session = this.sessions.get(meetingId);
		if (!session || !["connecting", "recording", "paused"].includes(session.state)) {
			send(client, { type: "error", message: "会议已结束或无法恢复" });
			return null;
		}
		if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
		session.reconnectTimer = null;
		session.client = client;
		send(client, { type: "draft_created", meetingId: session.id, rawPath: session.rawPath, title: session.title, recovered: true, audioAvailable: session.saveAudio });
		send(client, { type: "ready", meetingId: session.id, recovered: true, paused: session.state === "paused" });
		return session;
	}

	getActiveMeetings(): MeetingMetadata[] {
		return this.artifacts.listActive().filter((item) => this.sessions.has(item.id) || item.state === "summarizing");
	}

	getMeeting(id: string): MeetingMetadata | null {
		return this.artifacts.get(id);
	}

	private saveEmbeddedDraft(rawPath: string, meetingId: string, title: string, meetingStatus: MeetingState, content: string): void {
		const current = readNoteContent(this.deps.l2DataDir, rawPath);
		saveL2MeetingDraft(this.deps.l2DataDir, rawPath, {
			meetingId,
			meetingStatus,
			content: mergeMeetingBlock(current.content, meetingId, title, content, current.meetingId === meetingId),
		});
	}

	private saveSessionDraft(session: MeetingSession, meetingStatus: MeetingState, content: string): void {
		this.saveEmbeddedDraft(session.rawPath, session.id, session.title, meetingStatus, content);
	}

	private saveMetadataDraft(meeting: MeetingMetadata, meetingStatus: MeetingState, content: string): void {
		if (meeting.embedded) {
			this.saveEmbeddedDraft(meeting.rawPath, meeting.id, meeting.title, meetingStatus, content);
			return;
		}
		saveL2MeetingDraft(this.deps.l2DataDir, meeting.rawPath, {
			meetingId: meeting.id,
			meetingStatus,
			content,
		});
	}

	isRawPathActive(rawPath: string): boolean {
		const normalizedPath = rawPath.replace(/\\/g, "/");
		const hasActiveSession = [...this.sessions.values()].some((session) =>
			session.rawPath.replace(/\\/g, "/") === normalizedPath &&
			["connecting", "recording", "paused", "finishing", "summarizing"].includes(session.state));
		if (hasActiveSession) return true;
		return this.artifacts.listActive().some((meeting) =>
			meeting.rawPath.replace(/\\/g, "/") === normalizedPath &&
			["connecting", "recording", "paused", "finishing", "summarizing"].includes(meeting.state));
	}

	cancelForDeletedRawPath(rawPath: string): void {
		const normalizedPath = rawPath.replace(/\\/g, "/");
		for (const session of this.sessions.values()) {
			if (session.rawPath.replace(/\\/g, "/") !== normalizedPath) continue;
			if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
			session.state = "interrupted";
			this.artifacts.finalizeAudio(session.id);
			this.artifacts.update(session.id, { state: "interrupted", error: "笔记已删除，录音已停止" });
			this.send(session, { type: "note_deleted", rawPath: session.rawPath });
			session.transcription.cancel();
			this.sessions.delete(session.id);
		}
		for (const meeting of this.artifacts.listActive()) {
			if (meeting.rawPath.replace(/\\/g, "/") !== normalizedPath) continue;
			this.artifacts.finalizeAudio(meeting.id);
			this.artifacts.update(meeting.id, { state: "interrupted", error: "笔记已删除，录音已停止" });
		}
	}

	stopMeeting(id: string): boolean {
		const session = this.sessions.get(id);
		if (!session) return false;
		this.stop(session);
		return true;
	}

	async retrySummary(id: string): Promise<boolean> {
		const metadata = this.artifacts.get(id);
		if (!metadata) return false;
		const segments = this.artifacts.readSegments(id);
		if (segments.length === 0) return false;
		this.artifacts.update(id, { state: "summarizing", error: undefined });
		this.saveMetadataDraft(metadata, "summarizing", summarizingBody(metadata.title, segments));
		try {
			const summary = await this.deps.summarize(summaryPrompt(metadata.title, segments));
			if (!summary.trim()) throw new Error("文本模型未返回纪要");
			this.saveMetadataDraft(metadata, "completed", completedBody(metadata.title, summary, segments));
			this.artifacts.update(id, { state: "completed", error: undefined });
		} catch (error) {
			const message = error instanceof Error ? error.message : "纪要总结失败";
			this.artifacts.update(id, { state: "failed", error: message });
			this.saveMetadataDraft(metadata, "failed", failedBody(metadata.title, message, segments));
		}
		return true;
	}

	importAudio(fileName: string, data: Buffer): { job: MeetingImportJob; meeting: MeetingMetadata } {
		if (!data.length) throw new Error("Audio file is empty");
		const title = basename(fileName, extname(fileName)).trim() || "导入的会议录音";
		const id = `meeting_${randomUUID().slice(0, 8)}`;
		const note = createL2Note(this.deps.l2DataDir, this.deps.codeDir, {
			title,
			tags: ["会议纪要"],
			content: summarizingBody(title, []),
		});
		saveL2MeetingDraft(this.deps.l2DataDir, note.rawPath, {
			meetingId: id, meetingStatus: "connecting", title, tags: ["会议纪要"], content: summarizingBody(title, []),
		});
		const meeting = this.artifacts.create({ id, title, rawPath: note.rawPath, state: "connecting", startedAt: Date.now() }, false);
		const inputPath = this.artifacts.writeImportFile(id, fileName, data);
		const job = this.artifacts.createJob(id, fileName, basename(inputPath), true);
		this.enqueueImport(job, inputPath, true);
		return { job, meeting };
	}

	retranscribe(id: string): MeetingImportJob | null {
		const meeting = this.artifacts.get(id);
		if (!meeting) return null;
		const audioPath = this.artifacts.audioFile(id);
		try { readFileSync(audioPath, { flag: "r" }); } catch { return null; }
		this.artifacts.versionAndClearSegments(id);
		const job = this.artifacts.createJob(id, basename(audioPath), basename(audioPath), false);
		this.enqueueImport(job, audioPath, false);
		return job;
	}

	getImportJob(id: string): MeetingImportJob | null {
		return this.artifacts.getJob(id);
	}

	private enqueueImport(job: MeetingImportJob, inputPath: string, convert: boolean): void {
		const run = async () => {
			try { await this.processImport(job, inputPath, convert); }
			catch (error) {
				const message = error instanceof Error ? error.message : "音频转写失败";
				this.artifacts.updateJob(job.id, { status: "failed", error: message });
				this.artifacts.update(job.meetingId, { state: "failed", error: message });
				const meeting = this.artifacts.get(job.meetingId);
				if (meeting) this.saveMetadataDraft(meeting, "failed", failedBody(meeting.title, message, this.artifacts.readSegments(meeting.id)));
			}
		};
		this.importQueue = this.importQueue.then(run, run);
	}

	private async processImport(job: MeetingImportJob, inputPath: string, convert: boolean): Promise<void> {
		const meeting = this.artifacts.get(job.meetingId);
		if (!meeting) throw new Error("Meeting metadata not found");
		const audioPath = this.artifacts.audioFile(meeting.id);
		if (convert) {
			this.artifacts.updateJob(job.id, { status: "converting", progress: 5 });
			await this.convertToPcmWav(inputPath, audioPath);
			this.artifacts.update(meeting.id, { audioPath: `meetings/${meeting.id}/audio.wav` });
		}
		this.artifacts.updateJob(job.id, { status: "transcribing", progress: 10 });
		this.artifacts.update(meeting.id, { state: "recording", error: undefined });
		const segments = await this.transcribeWav(meeting.id, audioPath, job.id);
		if (segments.length === 0) throw new Error("未从音频中识别到有效语音");
		this.artifacts.updateJob(job.id, { status: "summarizing", progress: 92 });
		this.artifacts.update(meeting.id, { state: "summarizing" });
		this.saveMetadataDraft(meeting, "summarizing", summarizingBody(meeting.title, segments));
		const summary = await this.deps.summarize(summaryPrompt(meeting.title, segments));
		if (!summary.trim()) throw new Error("文本模型未返回纪要");
		this.saveMetadataDraft(meeting, "completed", completedBody(meeting.title, summary, segments));
		this.artifacts.update(meeting.id, { state: "completed", error: undefined });
		this.artifacts.updateJob(job.id, { status: "completed", progress: 100, error: undefined });
	}

	private convertToPcmWav(inputPath: string, outputPath: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const child = spawn("ffmpeg", ["-y", "-i", inputPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", outputPath], {
				windowsHide: true,
				stdio: ["ignore", "ignore", "pipe"],
			});
			let errorOutput = "";
			child.stderr.on("data", (chunk) => { errorOutput = `${errorOutput}${chunk}`.slice(-4000); });
			child.on("error", (error) => reject(new Error(`无法启动 FFmpeg：${error.message}`)));
			child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`FFmpeg 转换失败（${code}）：${errorOutput.trim()}`)));
		});
	}

	private async transcribeWav(meetingId: string, audioPath: string, jobId: string): Promise<TranscriptSentence[]> {
		const config = this.deps.getConfig();
		const apiKey = config?.apiKey || process.env.DASHSCOPE_API_KEY || "";
		const websocketUrl = config?.websocketUrl || process.env.DASHSCOPE_WEBSOCKET_URL || "";
		if (!config?.enabled || config.transcriptionProvider !== "dashscope" || !apiKey || !websocketUrl) throw new Error("会议转写 Provider 未配置");
		const wav = readFileSync(audioPath);
		const dataMarker = wav.indexOf(Buffer.from("data"));
		if (dataMarker < 0 || dataMarker + 8 >= wav.length) throw new Error("无效的 WAV 音频文件");
		const declaredSize = wav.readUInt32LE(dataMarker + 4);
		const audioStart = dataMarker + 8;
		const audioEnd = Math.min(wav.length, audioStart + declaredSize);
		const segments: TranscriptSentence[] = [];
		const provider = this.createProvider(config, apiKey, websocketUrl);
		let session!: TranscriptionSession;
		let readyResolve!: () => void;
		let finishResolve!: () => void;
		let rejectRun!: (error: Error) => void;
		const ready = new Promise<void>((resolve) => { readyResolve = resolve; });
		const finished = new Promise<void>((resolve) => { finishResolve = resolve; });
		const failed = new Promise<never>((_resolve, reject) => { rejectRun = reject; });
		session = provider.start({ sampleRate: 16000, language: config.language }, {
			onReady: readyResolve,
			onPartial: () => undefined,
			onFinal: (segment) => {
				const existing = segments.findIndex((item) => item.id === segment.id || item.beginTime === segment.beginTime);
				if (existing >= 0) segments[existing] = segment;
				else segments.push(segment);
				this.artifacts.appendSegment(meetingId, segment);
			},
			onFinished: finishResolve,
			onError: rejectRun,
		});
		await Promise.race([ready, failed]);
		const bytesPerChunk = 3200;
		for (let offset = audioStart; offset < audioEnd; offset += bytesPerChunk) {
			session.pushAudio(wav.subarray(offset, Math.min(audioEnd, offset + bytesPerChunk)));
			const ratio = (offset - audioStart) / Math.max(1, audioEnd - audioStart);
			this.artifacts.updateJob(jobId, { status: "transcribing", progress: 10 + Math.round(ratio * 80) });
			await Promise.race([new Promise<void>((resolve) => setTimeout(resolve, 100)), failed]);
		}
		session.finish();
		await Promise.race([finished, failed]);
		return segments;
	}

	private async summarize(session: MeetingSession): Promise<void> {
		if (session.state !== "recording" && session.state !== "finishing") return;
		if (session.sentences.length === 0) {
			session.state = "no_speech";
			this.artifacts.finalizeAudio(session.id);
			this.artifacts.update(session.id, { state: "no_speech" });
			this.saveSessionDraft(session, "no_speech", noSpeechBody(session.title));
			this.send(session, { type: "no_speech", rawPath: session.rawPath });
			setTimeout(() => this.sessions.delete(session.id), 60_000);
			return;
		}
		session.state = "summarizing";
		this.artifacts.update(session.id, { state: "summarizing" });
		this.saveSessionDraft(session, "summarizing", summarizingBody(session.title, session.sentences));
		this.send(session, { type: "summarizing", rawPath: session.rawPath });
		try {
			const summary = await this.deps.summarize(summaryPrompt(session.title, session.sentences));
			if (!this.sessions.has(session.id)) return;
			if (!summary.trim()) throw new Error("文本模型未返回纪要");
			session.state = "completed";
			this.artifacts.update(session.id, { state: "completed", error: undefined });
			this.saveSessionDraft(session, "completed", completedBody(session.title, summary, session.sentences));
			this.send(session, { type: "completed", rawPath: session.rawPath });
		} catch (error) {
			this.fail(session, error instanceof Error ? error.message : "纪要总结失败");
		} finally {
			setTimeout(() => this.sessions.delete(session.id), 60_000);
		}
	}

	private interrupt(session: MeetingSession): void {
		if (!this.sessions.has(session.id)) return;
		if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
		session.state = "interrupted";
		this.artifacts.finalizeAudio(session.id);
		this.artifacts.update(session.id, { state: "interrupted", error: "录音连接已中断" });
		this.saveSessionDraft(session, "interrupted", failedBody(session.title, "录音连接已中断", session.sentences));
		session.transcription.cancel();
		this.sessions.delete(session.id);
	}

	private handleDraftWriteFailure(session: MeetingSession, error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		logger.warn({ err: error, meetingId: session.id, rawPath: session.rawPath }, "meeting draft disappeared while transcription was active");
		session.state = "interrupted";
		this.artifacts.finalizeAudio(session.id);
		this.artifacts.update(session.id, { state: "interrupted", error: message });
		this.send(session, { type: "error", message: "录音笔记已不可用，本次录音已停止", rawPath: session.rawPath });
		session.transcription.cancel();
		this.sessions.delete(session.id);
	}

	private fail(session: MeetingSession, message: string): void {
		if (session.state === "failed" || session.state === "completed" || session.state === "interrupted") return;
		session.state = "failed";
		this.artifacts.finalizeAudio(session.id);
		this.artifacts.update(session.id, { state: "failed", error: message });
		logger.warn({ meetingId: session.id, message }, "meeting transcription failed");
		try {
			this.saveSessionDraft(session, "failed", failedBody(session.title, message, session.sentences));
		} catch (error) {
			logger.warn({ err: error, meetingId: session.id }, "failed to persist meeting failure state");
		}
		this.send(session, { type: "error", message, rawPath: session.rawPath });
		session.transcription.cancel();
		setTimeout(() => this.sessions.delete(session.id), 60_000);
	}
}
