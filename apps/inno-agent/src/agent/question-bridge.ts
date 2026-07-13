import { randomUUID } from "node:crypto";
import { logger } from "../logger.js";

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
			logger.warn("[diag] question: ask skipped because no emitter is registered");
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
		const normalizedSessionId = typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : null;
		this.pendingSessionId = normalizedSessionId;
		logger.info(
			{
				questionId,
				sessionId: normalizedSessionId,
				hasPersistence: Boolean(this.persistence),
			},
			"[diag] question: ask",
		);

		if (normalizedSessionId) {
			this.persistence?.save(normalizedSessionId, {
				questionId,
				params,
				createdAt: new Date().toISOString(),
			});
		} else {
			logger.warn({ questionId }, "[diag] question: missing sessionId; pending question is not restart-safe");
		}

		return new Promise<QuestionBridgeResult>((resolve) => {
			this.pending = { questionId, params, resolve };
			emitter({ type: "question", questionId, params });
		});
	}

	respond(questionId: string, result: QuestionBridgeResult): boolean {
		if (!this.pending || this.pending.questionId !== questionId) {
			logger.info({ questionId, hasLivePrompt: Boolean(this.pending) }, "[diag] question: respond rejected");
			return false;
		}
		const { resolve } = this.pending;
		logger.info({ questionId, sessionId: this.pendingSessionId }, "[diag] question: respond accepted");
		if (this.pendingSessionId) this.persistence?.remove(this.pendingSessionId);
		this.pending = null;
		this.pendingSessionId = null;
		resolve(result);
		return true;
	}

	/**
	 * Stop waiting on the live UI prompt without deleting its persisted card.
	 * The owning session can then be resumed through the persisted-question
	 * path, just like a card that survived an app restart.
	 */
	suspendPending(): {
		questionId: string;
		params: PendingQuestion["params"];
		sessionId: string | null;
	} | null {
		const pending = this.pending;
		if (!pending) return null;

		const sessionId = this.pendingSessionId;
		this.pending = null;
		this.pendingSessionId = null;
		logger.info(
			{ questionId: pending.questionId, sessionId },
			"[diag] question: suspended for session switch",
		);
		pending.resolve({ answers: [], cancelled: true, error: "session_switched" });
		return {
			questionId: pending.questionId,
			params: pending.params,
			sessionId,
		};
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
