import { apiFetch } from "./client.js";
import type { BtwThreadTurn } from "../types/btw.js";

/** Ask a side question ("顺便问问") against a session. The answer is a
 *  stateless side-channel completion — it never enters the session file. */
export async function askBtw(sessionId: string, question: string, thread: BtwThreadTurn[]): Promise<string> {
	const res = await apiFetch<{ answer: string }>("/api/btw/ask", {
		method: "POST",
		body: JSON.stringify({ sessionId, question, thread }),
	});
	return res.answer;
}

/** Append a confirmed btw Q/A pair to the main session as an assistant
 *  notification, so the agent can build on it in later turns. */
export async function bringBackBtw(sessionId: string, question: string, answer: string): Promise<void> {
	await apiFetch("/api/btw/bring-back", {
		method: "POST",
		body: JSON.stringify({ sessionId, question, answer }),
	});
}
