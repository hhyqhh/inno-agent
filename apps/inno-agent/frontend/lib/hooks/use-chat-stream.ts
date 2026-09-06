"use client";

import { useCallback, useRef, useState } from "react";
import { streamChat } from "@/lib/api/chat";
import { useChatStore } from "@/lib/store/chat-store";
import { useWorkspaceStore } from "@/lib/store/workspace-store";

/**
 * Drives one streaming chat turn (docs/frontend-rewrite-plan.md §4.3).
 * Iterates the SSE stream, folds each envelope into chat-store via
 * `applyEvent`, and on `done` re-loads the persisted session to replace the
 * transient turn. `cancel()` aborts the underlying strict-mode-safe stream.
 */
export function useChatStream(sessionId: string | null) {
  const startTurn = useChatStore((s) => s.startTurn);
  const applyEvent = useChatStore((s) => s.applyEvent);
  const resetTurn = useChatStore((s) => s.resetTurn);
  const refreshMessages = useWorkspaceStore((s) => s.refreshMessages);
  const abortRef = useRef<AbortController | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = useCallback(
    async (prompt: string) => {
      if (!sessionId || !prompt.trim()) return;
      const clientRequestId = `req-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      startTurn("", clientRequestId, prompt);
      setSending(true);
      setError(null);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const stream = streamChat(
          { prompt, sessionId, clientRequestId },
          { signal: controller.signal },
        );
        for await (const env of stream) {
          applyEvent(env);
        }
        // `done`/`[DONE]` → replace the transient turn with persisted history.
        // An `error`/`aborted` envelope leaves chat-store in a terminal state;
        // resetTurn() would wipe that (and the error banner reads the store),
        // so only reset a cleanly-finished turn and otherwise keep the banner.
        const transient = useChatStore.getState();
        if (!transient.error && !transient.aborted) {
          await refreshMessages(sessionId);
          resetTurn();
        } else {
          if (transient.error) setError(transient.error);
          useChatStore.setState({
            streaming: false,
            queued: false,
            streamingText: "",
            streamingThinking: "",
            activeTools: [],
            completedTools: [],
            prompt: null,
          });
        }
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        const msg = (e as Error).message;
        setError(msg);
        useChatStore.setState({ error: msg, streaming: false });
      } finally {
        setSending(false);
        abortRef.current = null;
      }
    },
    [sessionId, applyEvent, refreshMessages, resetTurn, startTurn],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { send, cancel, sending, error };
}
