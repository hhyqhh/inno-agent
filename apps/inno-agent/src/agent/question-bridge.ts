import { randomUUID } from "node:crypto";

export interface QuestionBridgeAnswer {
	questionIndex: number;
	question: string;
	kind: "option" | "custom" | "chat" | "multi";
	answer: string | null;
	selected?: string[];
	notes?: string;
	preview?: string;
}

export interface QuestionBridgeResult {
	answers: QuestionBridgeAnswer[];
	cancelled: boolean;
	error?: string;
}

type SseEmitter = (data: unknown) => void;

interface PendingQuestion {
	questionId: string;
	resolve: (result: QuestionBridgeResult) => void;
}

class QuestionBridge {
	private emitter: SseEmitter | null = null;
	private pending: PendingQuestion | null = null;

	setEmitter(fn: SseEmitter | null): void {
		this.emitter = fn;
	}

	ask(params: unknown): Promise<QuestionBridgeResult> {
		if (!this.emitter) {
			return Promise.resolve({ answers: [], cancelled: true, error: "no_ui" });
		}

		if (this.pending) {
			this.pending.resolve({ answers: [], cancelled: true, error: "superseded" });
			this.pending = null;
		}

		const questionId = randomUUID();
		const emitter = this.emitter;

		return new Promise<QuestionBridgeResult>((resolve) => {
			this.pending = { questionId, resolve };
			emitter({ type: "question", questionId, params });
		});
	}

	respond(questionId: string, result: QuestionBridgeResult): boolean {
		if (!this.pending || this.pending.questionId !== questionId) return false;
		const { resolve } = this.pending;
		this.pending = null;
		resolve(result);
		return true;
	}

	cancel(): void {
		if (!this.pending) return;
		const { resolve } = this.pending;
		this.pending = null;
		resolve({ answers: [], cancelled: true, error: "disconnected" });
	}
}

export const questionBridge = new QuestionBridge();
