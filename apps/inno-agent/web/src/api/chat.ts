import { apiFetch, streamSSE } from "./client.js";
import type { ChatStreamEvent } from "../types/chat.js";

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

export function streamChat(prompt: string, sessionId?: string | null, signal?: AbortSignal, images?: InlineImage[]): AsyncGenerator<ChatStreamEvent> {
	return streamSSE<ChatStreamEvent>("/api/chat/stream", { prompt, sessionId: sessionId ?? undefined, images: images?.length ? images : undefined }, signal);
}
