import { apiFetch, streamSSE } from "./client.js";
import type { ChatStreamEvent } from "../types/chat.js";

export async function postChat(prompt: string, sessionId?: string | null): Promise<string> {
	const res = await apiFetch<{ response: string }>("/api/chat", {
		method: "POST",
		body: JSON.stringify({ prompt, sessionId: sessionId ?? undefined }),
	});
	return res.response;
}

export function streamChat(prompt: string, sessionId?: string | null, signal?: AbortSignal): AsyncGenerator<ChatStreamEvent> {
	return streamSSE<ChatStreamEvent>("/api/chat/stream", { prompt, sessionId: sessionId ?? undefined }, signal);
}
