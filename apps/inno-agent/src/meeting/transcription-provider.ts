import type { TranscriptionEvents, TranscriptionOptions } from "./types.js";

export interface TranscriptionSession {
	pushAudio(chunk: Buffer): void;
	finish(): void;
	cancel(): void;
}

export interface TranscriptionProvider {
	readonly id: string;
	start(options: TranscriptionOptions, events: TranscriptionEvents): TranscriptionSession;
}
