import { createMeetingSocket, getActiveMeetings, getMeetingImportJob, importMeetingAudio, retryMeetingSummary, retranscribeMeeting, type MeetingImportJob } from "../api/meetings.js";
import { EventEmitter } from "./event-emitter.js";
import { notesStore } from "./notes-store.js";

export type MeetingUiState = "idle" | "connecting" | "recording" | "paused" | "finishing" | "importing" | "summarizing" | "completed" | "no_speech" | "error";

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
	inputDevices: MediaDeviceInfo[] = [];
	selectedDeviceId = "";
	permissionState: PermissionState | "unknown" = "unknown";
	isRecovering = false;
	inputLevel = 0;
	audioAvailable = false;
	importJob: MeetingImportJob | null = null;
	private socket: WebSocket | null = null;
	private mediaStream: MediaStream | null = null;
	private audioContext: AudioContext | null = null;
	private processor: AudioWorkletNode | null = null;
	private source: MediaStreamAudioSourceNode | null = null;
	private silentGain: GainNode | null = null;
	private timer: number | null = null;
	private lastLevelEmitAt = 0;

	async refreshDevices(): Promise<void> {
		try {
			if (navigator.permissions?.query) {
				const permission = await navigator.permissions.query({ name: "microphone" as PermissionName });
				this.permissionState = permission.state;
			}
			this.inputDevices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "audioinput");
			if (!this.selectedDeviceId && this.inputDevices[0]) this.selectedDeviceId = this.inputDevices[0].deviceId;
		} catch {
			this.permissionState = "unknown";
		}
		this.emit("change", undefined);
	}

	setSelectedDevice(deviceId: string): void {
		this.selectedDeviceId = deviceId;
		this.emit("change", undefined);
	}

	async start(rawPath: string, title: string, deviceId = this.selectedDeviceId): Promise<void> {
		if (this.state !== "idle" && this.state !== "completed" && this.state !== "no_speech" && this.state !== "error") return;
		if (!rawPath.trim()) return;
		if (!(await notesStore.flushSelected())) return;
		this.resetRuntime();
		this.state = "connecting";
		this.rawPath = rawPath;
		this.title = title.trim() || "录音记录";
		this.emit("change", undefined);
		try {
			this.selectedDeviceId = deviceId;
			await this.acquireMedia();
			const socket = createMeetingSocket();
			this.attachSocket(socket);
			socket.onopen = () => socket.send(JSON.stringify({ type: "start", title: this.title, rawPath }));
		} catch (error) {
			this.setError(error instanceof Error ? error.message : "无法访问麦克风");
		}
	}

	async recoverActive(): Promise<void> {
		if (this.state !== "idle" || this.isRecovering) return;
		this.isRecovering = true;
		try {
			const active = (await getActiveMeetings())[0];
			if (!active || !["connecting", "recording", "paused"].includes(active.state)) return;
			this.meetingId = active.id;
			this.rawPath = active.rawPath;
			this.title = active.title;
			this.audioAvailable = Boolean(active.audioPath);
			this.elapsedSeconds = Math.max(0, Math.floor((Date.now() - active.startedAt) / 1000));
			this.state = "connecting";
			const socket = createMeetingSocket();
			this.attachSocket(socket);
			socket.onopen = () => socket.send(JSON.stringify({ type: "reconnect", meetingId: active.id }));
		} catch {
			// Recovery is best-effort; a normal new recording remains available.
		} finally {
			this.isRecovering = false;
			this.emit("change", undefined);
		}
	}

	pause(): void {
		if (this.state !== "recording") return;
		this.state = "paused";
		this.socket?.send(JSON.stringify({ type: "pause" }));
		this.emit("change", undefined);
	}

	resume(): void {
		if (this.state !== "paused") return;
		this.state = "recording";
		this.socket?.send(JSON.stringify({ type: "resume" }));
		this.emit("change", undefined);
	}

	async retrySummary(): Promise<void> {
		if (!this.meetingId) return;
		this.state = "summarizing";
		this.error = null;
		this.emit("change", undefined);
		try {
			await retryMeetingSummary(this.meetingId);
			await this.refreshDraft();
			this.state = "completed";
		} catch (error) {
			this.setError(error instanceof Error ? error.message : "重新生成纪要失败");
		}
		this.emit("change", undefined);
	}

	async importAudio(file: File): Promise<void> {
		this.resetRuntime();
		this.state = "importing";
		this.title = file.name;
		this.emit("change", undefined);
		try {
			const result = await importMeetingAudio(file);
			this.meetingId = result.meetingId;
			this.rawPath = result.rawPath;
			this.audioAvailable = true;
			await this.refreshDraft();
			await this.pollImportJob(result.jobId);
		} catch (error) {
			this.setError(error instanceof Error ? error.message : "音频导入失败");
		}
	}

	async retranscribe(): Promise<void> {
		if (!this.meetingId) return;
		this.state = "importing";
		this.emit("change", undefined);
		try {
			const result = await retranscribeMeeting(this.meetingId);
			await this.pollImportJob(result.jobId);
		} catch (error) {
			this.setError(error instanceof Error ? error.message : "重新转写失败");
		}
	}

	private async pollImportJob(jobId: string): Promise<void> {
		while (true) {
			const job = await getMeetingImportJob(jobId);
			this.importJob = job;
			this.state = job.status === "summarizing" ? "summarizing" : job.status === "completed" ? "completed" : job.status === "failed" ? "error" : "importing";
			this.error = job.error ?? null;
			this.emit("change", undefined);
			if (job.status === "completed" || job.status === "failed") {
				await this.refreshDraft();
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, 1000));
		}
	}

	stop(): void {
		if (this.state !== "recording" && this.state !== "paused") return;
		this.stopAudio();
		this.state = "finishing";
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
				this.audioAvailable = event.audioAvailable === true;
				await this.refreshDraft();
				break;
			case "ready":
				try {
					await this.acquireMedia();
					await this.startAudio();
					this.state = event.paused === true ? "paused" : "recording";
					this.timer = window.setInterval(() => {
						if (this.state === "recording") this.elapsedSeconds += 1;
						this.emit("change", undefined);
					}, 1000);
					this.emit("change", undefined);
				} catch (error) {
					this.setError(error instanceof Error ? error.message : "无法启动音频采集");
				}
				break;
			case "paused":
				this.state = "paused";
				this.emit("change", undefined);
				break;
			case "resumed":
				this.state = "recording";
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
			case "finishing_transcript":
				this.state = "finishing";
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
			case "note_deleted":
				this.resetRuntime();
				this.state = "idle";
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
		await audioContext.audioWorklet.addModule("/audio/pcm-capture-worklet.js");
		const source = audioContext.createMediaStreamSource(this.mediaStream);
		const processor = new AudioWorkletNode(audioContext, "inno-pcm-capture", {
			numberOfInputs: 1,
			numberOfOutputs: 1,
			outputChannelCount: [1],
		});
		const silentGain = audioContext.createGain();
		silentGain.gain.value = 0;
		processor.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
			const samples = new Float32Array(event.data);
			const now = performance.now();
			if (now - this.lastLevelEmitAt >= 100) {
				let sum = 0;
				for (const sample of samples) sum += sample * sample;
				this.inputLevel = Math.min(1, Math.sqrt(sum / Math.max(1, samples.length)) * 4);
				this.lastLevelEmitAt = now;
				this.emit("change", undefined);
			}
			if (this.socket?.readyState !== WebSocket.OPEN || this.state !== "recording") return;
			this.socket.send(downsampleToPcm16(samples, audioContext.sampleRate));
		};
		source.connect(processor);
		processor.connect(silentGain);
		silentGain.connect(audioContext.destination);
		this.audioContext = audioContext;
		this.source = source;
		this.processor = processor;
		this.silentGain = silentGain;
	}

	private async acquireMedia(): Promise<void> {
		if (this.mediaStream?.active) return;
		this.mediaStream = await navigator.mediaDevices.getUserMedia({
			audio: {
				...(this.selectedDeviceId ? { deviceId: { exact: this.selectedDeviceId } } : {}),
				channelCount: 1,
				echoCancellation: true,
				noiseSuppression: true,
				autoGainControl: true,
			},
		});
		this.permissionState = "granted";
		await this.refreshDevices();
	}

	private attachSocket(socket: WebSocket): void {
		this.socket = socket;
		socket.binaryType = "arraybuffer";
		socket.onmessage = (event) => void this.handleServerEvent(JSON.parse(String(event.data)) as Record<string, any>);
		socket.onerror = () => this.setError("会议转写连接失败");
		socket.onclose = () => {
			if (["connecting", "recording", "paused"].includes(this.state)) this.setError("会议转写连接已断开");
		};
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
		if (this.processor) this.processor.port.onmessage = null;
		this.source?.disconnect();
		this.silentGain?.disconnect();
		this.processor = null;
		this.source = null;
		this.silentGain = null;
		void this.audioContext?.close();
		this.audioContext = null;
		for (const track of this.mediaStream?.getTracks() ?? []) track.stop();
		this.mediaStream = null;
		this.inputLevel = 0;
	}

	private setError(message: string): void {
		this.stopAudio();
		if (this.socket) {
			this.socket.onclose = null;
			this.socket.close();
			this.socket = null;
		}
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
		this.audioAvailable = false;
		this.importJob = null;
	}
}

export const meetingStore = new MeetingStore();
