import { apiGet, apiPost } from "./client";
import { openStream, openRawStream } from "./sse";
import type { StreamEnvelope, StreamStatusResponse } from "./types";

export interface ChatRequestBody {
  prompt: string;
  sessionId: string;
  clientRequestId: string;
  images?: unknown[];
  attachments?: { bindings: unknown[]; loose: unknown[] };
}

/** Non-streaming chat (rarely used; the UI streams). */
export function sendChat(body: {
  prompt: string;
  sessionId?: string;
}): Promise<{ response: string }> {
  return apiPost<{ response: string }>("/chat", body);
}

/** Open a streaming chat turn; yields normalized SSE envelopes. */
export function streamChat(
  body: ChatRequestBody,
  opts: { signal?: AbortSignal } = {},
): AsyncGenerator<StreamEnvelope> {
  return openStream("/chat/stream", body, opts);
}

export function getChatStatus(
  sessionId: string,
): Promise<StreamStatusResponse> {
  return apiGet<StreamStatusResponse>(`/chat/status/${sessionId}`);
}

/** Resolve a pending question card. */
export function respondToQuestion(body: {
  sessionId: string;
  turnId: string;
  questionId: string;
  result: { answers: { id: string; value: string }[]; cancelled: boolean };
}): Promise<{ accepted: boolean }> {
  return apiPost<{ accepted: boolean }>("/chat/question-response", body);
}

/** Replay stream events from `after` for a turn (reconnect). */
export function replayChatEvents(
  sessionId: string,
  turnId: string,
  after: number,
  opts: { signal?: AbortSignal } = {},
): AsyncGenerator<StreamEnvelope> {
  const path = `/chat/events/${encodeURIComponent(sessionId)}?turnId=${encodeURIComponent(
    turnId,
  )}&after=${after}`;
  return openRawStream(path, opts);
}

/** Abort a running turn. */
export function abortTurn(
  sessionId: string,
  turnId: string,
): Promise<{ status: string; cancelRequested: boolean }> {
  return apiPost<{ status: string; cancelRequested: boolean }>(
    `/chat/${encodeURIComponent(sessionId)}/${encodeURIComponent(turnId)}/abort`,
  );
}
