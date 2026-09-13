import { apiFetch } from "./client.js";
import type { BtwStateResponse, BtwThreadTurn } from "../types/btw.js";

export async function getBtwState(sessionId: string, signal?: AbortSignal): Promise<BtwStateResponse> {
	return apiFetch<BtwStateResponse>(`/api/btw/state/${encodeURIComponent(sessionId)}`, { signal });
}

export async function saveBtwState(sessionId: string, state: BtwStateResponse, signal?: AbortSignal): Promise<BtwStateResponse> {
	return apiFetch<BtwStateResponse>(`/api/btw/state/${encodeURIComponent(sessionId)}`, {
		method: "PUT",
		body: JSON.stringify(state),
		signal,
	});
}

/** Ask a side question ("顺便问问") against a session. The answer is a
 *  stateless side-channel completion — it never enters the session file. */
export async function askBtw(sessionId: string, question: string, thread: BtwThreadTurn[], signal?: AbortSignal): Promise<string> {
	const res = await apiFetch<{ answer: string }>("/api/btw/ask", {
		method: "POST",
		body: JSON.stringify({ sessionId, question, thread }),
		signal,
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
