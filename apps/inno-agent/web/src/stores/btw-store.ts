import { EventEmitter } from "./event-emitter.js";
import { askBtw, bringBackBtw } from "../api/btw.js";
import type { BtwExchange, BtwThreadTurn } from "../types/btw.js";

interface BtwStoreEvents {
	change: void;
}

let nextId = 1;

/**
 * "顺便问问" side-question store. Threads are bucketed per session and kept
 * purely in memory — reopening the page starts a fresh side note, matching
 * the "scratch pad next to the lesson" semantics. The main conversation is
 * never touched unless the learner explicitly brings an exchange back.
 */
export class BtwStoreImpl extends EventEmitter<BtwStoreEvents> {	threads = new Map<string, BtwExchange[]>();
	panelOpen = false;
	draft = "";

	threadFor(sessionId: string | null | undefined): BtwExchange[] {
		if (!sessionId) return [];
		return this.threads.get(sessionId) ?? [];
	}

	togglePanel(open?: boolean): void {
		this.panelOpen = open ?? !this.panelOpen;
		this.emit("change", undefined);
	}

	setDraft(text: string): void {
		this.draft = text;
		this.emit("change", undefined);
	}

	clearThread(sessionId: string): void {
		if (!this.threads.delete(sessionId)) return;
		this.emit("change", undefined);
	}

	private updateExchange(sessionId: string, id: string, patch: Partial<BtwExchange>): void {
		const thread = this.threads.get(sessionId);
		const index = thread?.findIndex((e) => e.id === id) ?? -1;
		if (!thread || index < 0) return;
		thread[index] = { ...thread[index], ...patch };
		this.emit("change", undefined);
	}

	async ask(sessionId: string, question: string): Promise<void> {
		const trimmed = question.trim();
		if (!sessionId || !trimmed) return;
		const thread = this.threads.get(sessionId) ?? [];
		const history: BtwThreadTurn[] = thread
			.filter((e) => e.status === "done")
			.map((e) => ({ question: e.question, answer: e.answer }));
		const exchange: BtwExchange = { id: `btw-${nextId++}`, question: trimmed, answer: "", status: "pending" };
		this.threads.set(sessionId, [...thread, exchange]);
		this.draft = "";
		this.panelOpen = true;
		this.emit("change", undefined);
		try {
			const answer = await askBtw(sessionId, trimmed, history);
			this.updateExchange(sessionId, exchange.id, { status: "done", answer });
		} catch (err) {
			this.updateExchange(sessionId, exchange.id, {
				status: "error",
				error: err instanceof Error ? err.message : "Request failed",
			});
		}
	}

	async retry(sessionId: string, exchangeId: string): Promise<void> {
		const exchange = this.threadFor(sessionId).find((e) => e.id === exchangeId);
		if (!exchange || exchange.status !== "error") return;
		this.updateExchange(sessionId, exchangeId, { status: "pending", error: undefined });
		const history: BtwThreadTurn[] = this.threadFor(sessionId)
			.filter((e) => e.status === "done" && e.id !== exchangeId)
			.map((e) => ({ question: e.question, answer: e.answer }));
		try {
			const answer = await askBtw(sessionId, exchange.question, history);
			this.updateExchange(sessionId, exchangeId, { status: "done", answer });
		} catch (err) {
			this.updateExchange(sessionId, exchangeId, {
				status: "error",
				error: err instanceof Error ? err.message : "Request failed",
			});
		}
	}

	async bringBack(sessionId: string, exchangeId: string): Promise<void> {
		const exchange = this.threadFor(sessionId).find((e) => e.id === exchangeId);
		if (!exchange || exchange.status !== "done" || exchange.broughtBack) return;
		await bringBackBtw(sessionId, exchange.question, exchange.answer);
		this.updateExchange(sessionId, exchangeId, { broughtBack: true });
	}
}

export const btwStore = new BtwStoreImpl();
