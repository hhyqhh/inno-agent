"use client";

import { useEffect, useRef } from "react";
import {
  Loader2,
  HelpCircle,
  ArrowRight,
  X,
} from "lucide-react";
import { useWorkspaceStore } from "@/lib/store/workspace-store";
import { useChatStore } from "@/lib/store/chat-store";
import { BrandMark } from "@/components/layout/brand-logo";
import { Message } from "./message";
import { Markdown } from "./markdown";
import { ToolStatus } from "./tool-status";
import { Composer } from "./composer";

/**
 * Center chat column (prototype 展开工作区): the persisted message list plus the
 * in-progress streaming turn, sitting above the composer.
 */
export function ChatView({
  sessionId,
  onSend,
  sending,
  onPreview,
}: {
  sessionId: string | null;
  onSend: (prompt: string) => void;
  sending: boolean;
  onPreview?: (path: string) => void;
}) {
  const messages = useWorkspaceStore((s) => s.messages);
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);
  const pendingQuestion = useWorkspaceStore((s) => s.pendingQuestion);
  const streaming = useChatStore((s) => s.streaming);
  const queued = useChatStore((s) => s.queued);
  const prompt = useChatStore((s) => s.prompt);
  const streamingText = useChatStore((s) => s.streamingText);
  const streamingThinking = useChatStore((s) => s.streamingThinking);
  const activeTools = useChatStore((s) => s.activeTools);
  const completedTools = useChatStore((s) => s.completedTools);
  const error = useChatStore((s) => s.error);
  const aborted = useChatStore((s) => s.aborted);

  const scrollRef = useRef<HTMLDivElement>(null);

  const active = streaming || queued;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, streamingText, active]);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-8">
          {messages.map((m) => (
            <Message
              key={m.entryId}
              message={m}
              workspaceId={workspaceId ?? undefined}
              onPreview={onPreview}
            />
          ))}

          {active && prompt && (
            <div className="flex justify-end">
              <div className="max-w-[78%] rounded-2xl rounded-br-md bg-[#eef1ff] px-4 py-3 text-[15px] leading-6 text-foreground dark:bg-primary/15">
                {prompt}
              </div>
            </div>
          )}

          {(active || streamingText) && (
            <div className="flex gap-3">
              <BrandMark className="mt-1 size-8 rounded-xl" />
              <div className="min-w-0 flex-1">
                {queued && (
                  <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" />
                    排队中…
                  </div>
                )}
                {activeTools.length > 0 && (
                  <div className="mb-1 flex flex-col">
                    {activeTools.map((t) => (
                      <ToolStatus key={t.id} tool={t} live />
                    ))}
                  </div>
                )}
                {completedTools.length > 0 && (
                  <div className="mb-1 flex flex-col">
                    {completedTools.map((t) => (
                      <ToolStatus key={t.id} tool={t} />
                    ))}
                  </div>
                )}
                {streamingThinking && (
                  <div className="mb-1 rounded-lg border border-border/60 bg-muted/40 px-3 py-2 text-xs leading-5 text-muted-foreground">
                    {streamingThinking}
                  </div>
                )}
                <Markdown content={streamingText} />
              </div>
            </div>
          )}

          {pendingQuestion && (
            <div className="flex items-start gap-3">
              <BrandMark className="mt-1 size-8 rounded-xl" />
              <div className="flex-1 rounded-xl border border-primary/30 bg-primary/5 p-3">
                <div className="mb-1 flex items-center gap-1.5 text-sm font-medium text-foreground">
                  <HelpCircle className="size-4 text-primary" />
                  需要你确认
                </div>
                <div className="text-xs text-muted-foreground">
                  请选择或输入答案后继续会话。
                </div>
              </div>
            </div>
          )}

          {error && (
            <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <X className="size-4" />
              {error}
              <span className="ml-auto flex items-center gap-1 text-xs opacity-80">
                重试
                <ArrowRight className="size-3" />
              </span>
            </div>
          )}

          {aborted && (
            <div className="text-center text-xs text-muted-foreground">已停止生成</div>
          )}
        </div>
      </div>

      <div className="shrink-0 px-6 pb-3">
        <div className="mx-auto w-full max-w-2xl">
          <Composer onSend={onSend} sending={sending} disabled={!sessionId} />
        </div>
      </div>
    </div>
  );
}
