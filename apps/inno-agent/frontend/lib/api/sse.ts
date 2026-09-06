/**
 * SSE stream readers (docs/frontend-rewrite-plan.md §4.3).
 *
 * - `openStream(path, body)` — POST with a JSON body (chat/stream).
 * - `openRawStream(path)` — GET (chat/events replay, reconnect).
 *
 * Both yield well-formed `StreamEnvelope`s and route through lib/mock/* in
 * mock mode. `normalizeFrame` tolerates both the backend's documented
 * `{ seq, event }` frames and the richer reconnect envelope shape.
 */
import { resolveBaseURL, mocksEnabled } from "./config";
import { ApiError } from "./client";
import { mockStream } from "@/lib/mock/stream";
import type { StreamEnvelope, ChatEvent } from "./types";

function normalizeFrame(
  raw: string,
  fallback: { sessionId: string; turnId: string; clientRequestId: string },
): StreamEnvelope | null {
  if (!raw || raw === "[DONE]") return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;
  const event = (obj.event ?? obj) as ChatEvent;
  if (!event || typeof event !== "object") return null;

  const isEnvelope =
    typeof obj.eventId === "number" &&
    typeof obj.sessionId === "string" &&
    typeof obj.turnId === "string";

  return {
    eventId: isEnvelope
      ? (obj.eventId as number)
      : typeof obj.seq === "number"
        ? (obj.seq as number)
        : 0,
    sessionId: (obj.sessionId as string) || fallback.sessionId,
    turnId: (obj.turnId as string) || fallback.turnId,
    clientRequestId:
      (obj.clientRequestId as string) || fallback.clientRequestId,
    traceId: obj.traceId as string | undefined,
    occurredAt: obj.occurredAt as string | undefined,
    event:
      obj.event && typeof obj.event === "object"
        ? (obj.event as ChatEvent)
        : (obj as unknown as ChatEvent),
  };
}

async function* readResponse(
  res: Response,
  fallback: { sessionId: string; turnId: string; clientRequestId: string },
): AsyncGenerator<StreamEnvelope> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const frame = normalizeFrame(trimmed.slice(5).trim(), fallback);
        if (frame) yield frame;
      }
    }
    const tail = buffer.trim();
    if (tail.startsWith("data:")) {
      const frame = normalizeFrame(tail.slice(5).trim(), fallback);
      if (frame) yield frame;
    }
  } finally {
    reader.releaseLock();
  }
}

/** POST a JSON body and read an SSE response. */
export async function* openStream(
  path: string,
  body: unknown,
  opts: {
    signal?: AbortSignal;
    headers?: Record<string, string>;
  } = {},
): AsyncGenerator<StreamEnvelope> {
  const fallback = {
    sessionId: (body as { sessionId?: string })?.sessionId ?? "",
    turnId: "",
    clientRequestId:
      (body as { clientRequestId?: string })?.clientRequestId ?? "",
  };

  if (mocksEnabled()) {
    yield* mockStream(path, body, fallback, opts.signal);
    return;
  }

  const res = await fetch(`${resolveBaseURL()}/api${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(opts.headers ?? {}),
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!res.ok || !res.body) {
    throw new ApiError(`流式请求失败 (${res.status})`, res.status);
  }
  yield* readResponse(res, fallback);
}

/** GET an SSE response (chat/events replay). */
export async function* openRawStream(
  path: string,
  opts: { signal?: AbortSignal } = {},
): AsyncGenerator<StreamEnvelope> {
  const isMock = mocksEnabled();
  if (isMock) {
    yield* mockStream(path, {}, { sessionId: "", turnId: "", clientRequestId: "" }, opts.signal);
    return;
  }
  const res = await fetch(`${resolveBaseURL()}/api${path}`, {
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    throw new ApiError(`流式请求失败 (${res.status})`, res.status);
  }
  yield* readResponse(res, { sessionId: "", turnId: "", clientRequestId: "" });
}
