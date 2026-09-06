"use client";

import { useEffect, useRef, useState } from "react";
import { getChatStatus, replayChatEvents } from "@/lib/api/chat";
import { useChatStore } from "@/lib/store/chat-store";
import { useWorkspaceStore } from "@/lib/store/workspace-store";

/**
 * Resume an in-progress turn when the workspace mounts (docs/frontend-rewrite-
 * plan.md §4.3 / 重连). If `GET /api/chat/status/:sessionId` shows queued or
 * running, it re-opens `GET /api/chat/events/:sessionId?turnId=<t>&after=<n>`
 * and replays from the last applied event, then reloads the persisted session.
 *
 * `reconnectOwner` backoff is intentionally left to a caller (the plan notes a
 * 250/500/1000/2000ms poll until clientRequestId matches); this hook replays
 * in one pass and is a no-op when the turn is already complete.
 */
export function useSseReconnect(sessionId: string | null) {
  const applyEvent = useChatStore((s) => s.applyEvent);
  const startTurn = useChatStore((s) => s.startTurn);
  const resetTurn = useChatStore((s) => s.resetTurn);
  const refreshMessages = useWorkspaceStore((s) => s.refreshMessages);
  const [reconnected, setReconnected] = useState(false);
  const ranRef = useRef(false);

  useEffect(() => {
    if (!sessionId) return;
    if (ranRef.current) return;
    ranRef.current = true;

    const controller = new AbortController();
    let cancelled = false;

    (async () => {
      try {
        const status = await getChatStatus(sessionId);
        if (cancelled) return;
        const stream = status.stream;
        if (
          status.found &&
          stream &&
          (stream.status === "queued" || stream.status === "running")
        ) {
          startTurn(stream.turnId, stream.clientRequestId);
          const gen = replayChatEvents(sessionId, stream.turnId, stream.lastEventId, {
            signal: controller.signal,
          });
          for await (const env of gen) applyEvent(env);
          await refreshMessages(sessionId);
          // Replaying refills the transient turn; clear it once the persisted
          // history has been reloaded, otherwise chat-view renders a leftover
          // streaming bubble (`active || streamingText`) duplicate alongside the
          // now-persisted assistant message.
          resetTurn();
        }
      } catch {
        /* reconnect is best-effort; the UI still loads persisted history */
      } finally {
        if (!cancelled) setReconnected(true);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [sessionId, applyEvent, refreshMessages, startTurn, resetTurn]);

  return { reconnected };
}
