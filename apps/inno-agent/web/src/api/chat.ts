import { apiFetch, streamSSE, streamSSEGet } from "./client.js";
import type { QuestionnaireResult, StreamEventEnvelope, StreamSnapshot } from "../types/chat.js";

export interface InlineImage {
	data: string;
	mimeType: string;
}

export async function postChat(prompt: string, sessionId?: string | null, images?: InlineImage[]): Promise<string> {
	const res = await apiFetch<{ response: string }>("/api/chat", {
		method: "POST",
		body: JSON.stringify({ prompt, sessionId: sessionId ?? undefined, images: images?.length ? images : undefined }),
	});
	return res.response;
}

export function streamChat(prompt: string, sessionId: string, clientRequestId: string, signal?: AbortSignal, images?: InlineImage[]): AsyncGenerator<StreamEventEnvelope> {
	return streamSSE<StreamEventEnvelope>("/api/chat/stream", { prompt, sessionId, clientRequestId, images: images?.length ? images : undefined }, signal);
}

/**
 * Explicitly tell the backend to abort the currently running prompt. Best-effort:
 * connection-close from aborting the SSE fetch is unreliable through dev proxies,
 * so the UI calls this to deterministically release the server's prompt queue.
 */
export async function abortChat(sessionId: string, turnId: string): Promise<void> {
	await apiFetch(`/api/chat/${encodeURIComponent(sessionId)}/${encodeURIComponent(turnId)}/abort`, { method: "POST" });
}

/**
 * Reconnect to an in-progress session's event stream. Returns silently
 * if the session has no active stream (404).
 */
export function streamSessionEvents(sessionId: string, turnId: string, after: number, signal?: AbortSignal): AsyncGenerator<StreamEventEnvelope> {
	return streamSSEGet<StreamEventEnvelope>(`/api/chat/events/${encodeURIComponent(sessionId)}?turnId=${encodeURIComponent(turnId)}&after=${after}`, signal, { allowNotFound: false });
}

export async function getChatStatus(sessionId: string): Promise<{ found: boolean; stream?: StreamSnapshot }> {
	return apiFetch(`/api/chat/status/${encodeURIComponent(sessionId)}`);
}

export async function submitChatQuestion(sessionId: string, turnId: string, questionId: string, result: QuestionnaireResult): Promise<void> {
	await apiFetch("/api/chat/question-response", {
		method: "POST",
		body: JSON.stringify({ sessionId, turnId, questionId, result }),
	});
}
