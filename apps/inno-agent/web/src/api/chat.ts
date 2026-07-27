import { apiFetch, streamSSE, streamSSEGet } from "./client.js";
import type { ChatNoteReference, ChatStreamEvent } from "../types/chat.js";

export interface InlineImage {
	data: string;
	mimeType: string;
}

export async function postChat(prompt: string, sessionId?: string | null, images?: InlineImage[], noteReferences?: ChatNoteReference[]): Promise<string> {
	const res = await apiFetch<{ response: string }>("/api/chat", {
		method: "POST",
		body: JSON.stringify({
			prompt,
			sessionId: sessionId ?? undefined,
			images: images?.length ? images : undefined,
			noteContext: noteReferences?.length ? { rawPaths: noteReferences.map((note) => note.rawPath) } : undefined,
		}),
	});
	return res.response;
}

export function streamChat(prompt: string, sessionId?: string | null, signal?: AbortSignal, images?: InlineImage[], noteReferences?: ChatNoteReference[]): AsyncGenerator<ChatStreamEvent> {
	return streamSSE<ChatStreamEvent>("/api/chat/stream", {
		prompt,
		sessionId: sessionId ?? undefined,
		images: images?.length ? images : undefined,
		noteContext: noteReferences?.length ? { rawPaths: noteReferences.map((note) => note.rawPath) } : undefined,
	}, signal);
}

/**
 * Explicitly tell the backend to abort the currently running prompt. Best-effort:
 * connection-close from aborting the SSE fetch is unreliable through dev proxies,
 * so the UI calls this to deterministically release the server's prompt queue.
 */
export async function abortChat(): Promise<void> {
	try {
		await fetch("/api/chat/abort", { method: "POST" });
	} catch {
		// best-effort — the SSE close handler is a fallback
	}
}

/**
 * Reconnect to an in-progress session's event stream. Returns silently
 * if the session has no active stream (404).
 */
export function streamSessionEvents(sessionId: string, signal?: AbortSignal): AsyncGenerator<ChatStreamEvent> {
	return streamSSEGet<ChatStreamEvent>(`/api/chat/events/${encodeURIComponent(sessionId)}`, signal);
}
