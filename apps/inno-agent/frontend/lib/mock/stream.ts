/**
 * Mock SSE generator for the chat stream (`/chat/stream`) and replay
 * (`/chat/events/:id?after=N`). Emits a plausible streamed turn so the UI can
 * be exercised without a backend.
 */
import { buildMockStream, toEnvelope } from "./data";
import type { StreamEnvelope } from "@/lib/api/types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isAborted(signal?: AbortSignal): boolean {
  return !!signal?.aborted;
}

function shouldAbort(signal?: AbortSignal): boolean {
  return isAborted(signal);
}

export async function* mockStream(
  path: string,
  body: unknown,
  fallback: { sessionId: string; turnId: string; clientRequestId: string },
  signal?: AbortSignal,
): AsyncGenerator<StreamEnvelope> {
  const payload = (body ?? {}) as Record<string, unknown>;
  const sessionId = (payload.sessionId as string) || fallback.sessionId || "sess-mock";
  const clientRequestId =
    (payload.clientRequestId as string) || fallback.clientRequestId || "req-mock";
  const turnId = fallback.turnId || `turn-mock-${Math.random().toString(36).slice(2, 8)}`;

  // Replay path: emit from `after` onward and stop.
  const isReplay = path.startsWith("/chat/events/");
  let seq = 0;
  const events = buildMockStream(sessionId, turnId, clientRequestId);

  for (const event of events) {
    seq += 1;
    if (isReplay) {
      const u = new URL(path, "http://mock.local");
      const after = Number(u.searchParams.get("after") || 0);
      if (seq <= after) continue;
    }
    yield toEnvelope(event, seq, sessionId, turnId, clientRequestId);
    if (shouldAbort(signal)) return;
    await sleep(isReplay ? 10 : 60);
  }
}
