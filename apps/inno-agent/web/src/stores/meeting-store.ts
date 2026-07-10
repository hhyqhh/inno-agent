import { createMeetingSocket } from "../api/meetings.js";
import { EventEmitter } from "./event-emitter.js";
import { notesStore } from "./notes-store.js";

export type MeetingUiState = "idle" | "connecting" | "recording" | "summarizing" | "completed" | "no_speech" | "error";

interface MeetingStoreEvents { change: void; }

function downsampleToPcm16(input: Float32Array, inputRate: number, outputRate = 16000): ArrayBuffer {
	const ratio = inputRate / outputRate;
	const length = Math.max(1, Math.floor(input.length / ratio));
	const output = new Int16Array(length);
	for (let i = 0; i < length; i++) {
		const start = Math.floor(i * ratio);
		const end = Math.min(input.length, Math.floor((i + 1) * ratio));
		let sum = 0;
		for (let j = start; j < end; j++) sum += input[j];
		const sample = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
		output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
	}
	return output.buffer;
}

class MeetingStore extends EventEmitter<MeetingStoreEvents> {
	state: MeetingUiState = "idle";
	meetingId: string | null = null;
	rawPath: string | null = null;
	title = "";
	elapsedSeconds = 0;
	partialText = "";
	lastFinalText = "";
	error: string | null = null;
	private socket: WebSocket | null = null;
	private mediaStream: MediaStream | null = null;
	private audioContext: AudioContext | null = null;
	private processor: ScriptProcessorNode | null = null;
	private source: MediaStreamAudioSourceNode | null = null;
	private timer: number | null = null;

	async start(): Promise<void> {
		if (this.state !== "idle" && this.state !== "completed" && this.state !== "no_speech" && this.state !== "error") return;
		this.resetRuntime();
		this.state = "connecting";
		this.title = `会议纪要 ${new Date().toLocaleString("zh-CN", { hour12: false })}`;
		this.emit("change", undefined);
		try {
			this.mediaStream = await navigator.mediaDevices.getUserMedia({
				audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
			});
			const socket = createMeetingSocket();
			this.socket = socket;
			socket.binaryType = "arraybuffer";
			socket.onopen = () => socket.send(JSON.stringify({ type: "start", title: this.title }));
			socket.onmessage = (event) => void this.handleServerEvent(JSON.parse(String(event.data)) as Record<string, any>);
			socket.onerror = () => this.setError("会议转写连接失败");
			socket.onclose = () => {
				if (this.state === "connecting" || this.state === "recording") this.setError("会议转写连接已断开");
			};
		} catch (error) {
			this.setError(error instanceof Error ? error.message : "无法访问麦克风");
		}
	}

	stop(): void {
		if (this.state !== "recording") return;
		this.stopAudio();
		this.state = "summarizing";
		this.partialText = "";
		this.emit("change", undefined);
		if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: "stop" }));
	}

	dismiss(): void {
		if (this.state === "recording" || this.state === "connecting" || this.state === "summarizing") return;
		this.state = "idle";
		this.emit("change", undefined);
	}

	private async handleServerEvent(event: Record<string, any>): Promise<void> {
		switch (event.type) {
			case "draft_created":
				this.meetingId = String(event.meetingId);
				this.rawPath = String(event.rawPath);
				await this.refreshDraft();
				break;
			case "ready":
				await this.startAudio();
				this.state = "recording";
				this.timer = window.setInterval(() => { this.elapsedSeconds += 1; this.emit("change", undefined); }, 1000);
				this.emit("change", undefined);
				break;
			case "transcript_partial":
				this.partialText = String(event.text ?? "");
				this.emit("change", undefined);
				break;
			case "transcript_final":
				this.partialText = "";
				this.lastFinalText = String(event.sentence?.text ?? "");
				this.emit("change", undefined);
				break;
			case "summarizing":
				this.state = "summarizing";
				await this.refreshDraft();
				this.emit("change", undefined);
				break;
			case "completed":
				this.state = "completed";
				await this.refreshDraft();
				this.socket?.close();
				this.emit("change", undefined);
				break;
			case "no_speech":
				this.state = "no_speech";
				await this.refreshDraft();
				this.socket?.close();
				this.emit("change", undefined);
				break;
			case "error":
				this.setError(String(event.message ?? "会议处理失败"));
				await this.refreshDraft();
				break;
		}
	}

	private async startAudio(): Promise<void> {
		if (!this.mediaStream) throw new Error("麦克风不可用");
		const audioContext = new AudioContext();
		const source = audioContext.createMediaStreamSource(this.mediaStream);
		const processor = audioContext.createScriptProcessor(4096, 1, 1);
		const silentGain = audioContext.createGain();
		silentGain.gain.value = 0;
		processor.onaudioprocess = (event) => {
			if (this.socket?.readyState !== WebSocket.OPEN || this.state !== "recording") return;
			const samples = event.inputBuffer.getChannelData(0);
			this.socket.send(downsampleToPcm16(samples, audioContext.sampleRate));
		};
		source.connect(processor);
		processor.connect(silentGain);
		silentGain.connect(audioContext.destination);
		this.audioContext = audioContext;
		this.source = source;
		this.processor = processor;
	}

	private async refreshDraft(): Promise<void> {
		if (!this.rawPath) return;
		await notesStore.loadAll();
		const note = notesStore.notes.find((item) => item.rawPath === this.rawPath);
		if (note) await notesStore.selectNote(note);
	}

	private stopAudio(): void {
		if (this.timer !== null) window.clearInterval(this.timer);
		this.timer = null;
		this.processor?.disconnect();
		this.source?.disconnect();
		this.processor = null;
		this.source = null;
		void this.audioContext?.close();
		this.audioContext = null;
		for (const track of this.mediaStream?.getTracks() ?? []) track.stop();
		this.mediaStream = null;
	}

	private setError(message: string): void {
		this.stopAudio();
		this.state = "error";
		this.error = message;
		this.emit("change", undefined);
	}

	private resetRuntime(): void {
		this.stopAudio();
		this.socket?.close();
		this.socket = null;
		this.meetingId = null;
		this.rawPath = null;
		this.elapsedSeconds = 0;
		this.partialText = "";
		this.lastFinalText = "";
		this.error = null;
	}
}

export const meetingStore = new MeetingStore();
