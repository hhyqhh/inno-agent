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

interface TurnBinding {
	sessionId: string;
	turnId: string;
	emit: (event: Record<string, unknown> & { type: string }) => void;
	timeoutMs: number;
}

interface PendingQuestion {
	questionId: string;
	sessionId: string;
	turnId: string;
	resolve: (result: QuestionBridgeResult) => void;
	timer: ReturnType<typeof setTimeout>;
}

export type QuestionResponseStatus = "accepted" | "not_found" | "scope_mismatch" | "already_resolved";

export class QuestionBridge {
	private binding: TurnBinding | null = null;
	private pending: PendingQuestion | null = null;
	private lastResolved: Pick<PendingQuestion, "questionId" | "sessionId" | "turnId"> | null = null;

	bindTurn(binding: TurnBinding): void {
		if (this.binding && (this.binding.sessionId !== binding.sessionId || this.binding.turnId !== binding.turnId)) {
			this.unbindTurn({ ...this.binding, reason: "superseded" });
		}
		this.binding = binding;
	}

	ask(params: unknown): Promise<QuestionBridgeResult> {
		const binding = this.binding;
		if (!binding) return Promise.resolve({ answers: [], cancelled: true, error: "no_ui" });
		if (this.pending) this.resolvePending({ answers: [], cancelled: true, error: "superseded" }, false);

		const questionId = randomUUID();
		return new Promise<QuestionBridgeResult>((resolve) => {
			const timer = setTimeout(() => {
				if (this.pending?.questionId !== questionId) return;
				this.resolvePending({ answers: [], cancelled: true, error: "timeout" }, true);
			}, binding.timeoutMs);
			this.pending = { questionId, sessionId: binding.sessionId, turnId: binding.turnId, resolve, timer };
			binding.emit({ type: "question", questionId, params });
		});
	}

	respond(input: { sessionId: string; turnId: string; questionId: string; result: QuestionBridgeResult }): QuestionResponseStatus {
		const pending = this.pending;
		if (!pending || pending.questionId !== input.questionId) {
			return this.lastResolved?.questionId === input.questionId
				&& this.lastResolved.sessionId === input.sessionId
				&& this.lastResolved.turnId === input.turnId
				? "already_resolved"
				: "not_found";
		}
		if (pending.sessionId !== input.sessionId || pending.turnId !== input.turnId) return "scope_mismatch";
		this.resolvePending(input.result, true);
		return "accepted";
	}

	unbindTurn(input: { sessionId: string; turnId: string; reason: string }): void {
		if (!this.binding || this.binding.sessionId !== input.sessionId || this.binding.turnId !== input.turnId) return;
		if (this.pending?.sessionId === input.sessionId && this.pending.turnId === input.turnId) {
			this.resolvePending({ answers: [], cancelled: true, error: input.reason }, true);
		}
		this.binding = null;
	}

	private resolvePending(result: QuestionBridgeResult, emitResolved: boolean): void {
		const pending = this.pending;
		if (!pending) return;
		clearTimeout(pending.timer);
		this.pending = null;
		this.lastResolved = { questionId: pending.questionId, sessionId: pending.sessionId, turnId: pending.turnId };
		if (emitResolved && this.binding?.sessionId === pending.sessionId && this.binding.turnId === pending.turnId) {
			this.binding.emit({ type: "question_resolved", questionId: pending.questionId, cancelled: result.cancelled, error: result.error });
		}
		pending.resolve(result);
	}
}

export const questionBridge = new QuestionBridge();
