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
	params: unknown;
	resolve: (result: QuestionBridgeResult) => void;
}

/** Snapshot of a pending question, exposed so a reconnecting SSE client can
 *  re-render the card after a session switch. */
export interface PendingQuestionSnapshot {
	questionId: string;
	params: unknown;
}

/** A persistable pending question (no resolve callback). */
export interface PersistedQuestion {
	questionId: string;
	params: unknown;
	createdAt: string;
}

/** Callbacks injected by the server to persist/restore pending questions
 *  across process restarts. */
export interface QuestionBridgePersistence {
	save: (sessionId: string, question: PersistedQuestion) => void;
	remove: (sessionId: string) => void;
}

class QuestionBridge {
	private emitter: SseEmitter | null = null;
	private pending: PendingQuestion | null = null;
	private pendingSessionId: string | null = null;
	private persistence: QuestionBridgePersistence | null = null;

	setEmitter(fn: SseEmitter | null): void {
		this.emitter = fn;
	}

	setPersistence(p: QuestionBridgePersistence | null): void {
		this.persistence = p;
	}

	getPending(): PendingQuestionSnapshot | null {
		if (!this.pending) return null;
		return { questionId: this.pending.questionId, params: this.pending.params };
	}

	getPendingSessionId(): string | null {
		return this.pendingSessionId;
	}

	ask(params: unknown, sessionId?: string): Promise<QuestionBridgeResult> {
		if (!this.emitter) {
			return Promise.resolve({ answers: [], cancelled: true, error: "no_ui" });
		}

		if (this.pending) {
			this.pending.resolve({ answers: [], cancelled: true, error: "superseded" });
			if (this.pendingSessionId) this.persistence?.remove(this.pendingSessionId);
			this.pending = null;
			this.pendingSessionId = null;
		}

		const questionId = randomUUID();
		const emitter = this.emitter;
		this.pendingSessionId = sessionId ?? null;

		if (sessionId) {
			this.persistence?.save(sessionId, {
				questionId,
				params,
				createdAt: new Date().toISOString(),
			});
		}

		return new Promise<QuestionBridgeResult>((resolve) => {
			this.pending = { questionId, params, resolve };
			emitter({ type: "question", questionId, params });
		});
	}

	respond(questionId: string, result: QuestionBridgeResult): boolean {
		if (!this.pending || this.pending.questionId !== questionId) return false;
		const { resolve } = this.pending;
		if (this.pendingSessionId) this.persistence?.remove(this.pendingSessionId);
		this.pending = null;
		this.pendingSessionId = null;
		resolve(result);
		return true;
	}

	cancel(): void {
		if (!this.pending) return;
		const { resolve } = this.pending;
		if (this.pendingSessionId) this.persistence?.remove(this.pendingSessionId);
		this.pending = null;
		this.pendingSessionId = null;
		resolve({ answers: [], cancelled: true, error: "disconnected" });
	}

	/** Whether a live prompt is waiting on a question (vs a question restored
	 *  from disk after restart whose prompt no longer exists). */
	hasLivePrompt(): boolean {
		return this.pending !== null;
	}
}

export const questionBridge = new QuestionBridge();
