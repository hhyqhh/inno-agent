/** "顺便问问" side-question thread types. Purely in-memory — the thread is a
 *  side note to the conversation and is intentionally not persisted. */

export interface BtwThreadTurn {
	question: string;
	answer: string;
}

export interface BtwExchange extends BtwThreadTurn {
	id: string;
	status: "pending" | "done" | "error";
	/** Set when status is "error" (network/completion failure). */
	error?: string;
	/** True once this exchange has been brought back into the main session. */
	broughtBack?: boolean;
}
