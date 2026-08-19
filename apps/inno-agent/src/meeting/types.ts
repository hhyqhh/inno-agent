export type MeetingState =
	| "connecting"
	| "recording"
	| "paused"
	| "finishing"
	| "summarizing"
	| "completed"
	| "no_speech"
	| "failed"
	| "interrupted";

export interface TranscriptSegment {
	id: string;
	beginTime: number;
	endTime: number;
	text: string;
	final: boolean;
	speakerId?: string;
}

export interface TranscriptionOptions {
	language?: string;
	sampleRate: number;
}

export interface TranscriptionEvents {
	onReady(): void;
	onPartial(segment: TranscriptSegment): void;
	onFinal(segment: TranscriptSegment): void;
	onFinished(): void;
	onError(error: Error): void;
}
