"use client";

import type { SessionMessageSummary } from "@/lib/api/types";
import { formatClock } from "@/lib/format";

/**
 * The 聊天记录 tab (docs/frontend-rewrite-plan.md §4.4 right panel): a compact
 * transcript of the current session.
 */
export function ChatRecords({ messages }: { messages: SessionMessageSummary[] }) {
  if (messages.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-xs text-muted-foreground">
        暂无聊天记录。
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-3">
      {messages.map((m) => (
        <div key={m.entryId} className="flex gap-2.5">
          <span
            className={[
              "mt-1 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium",
              m.role === "user"
                ? "bg-primary/10 text-primary"
                : "bg-muted text-muted-foreground",
            ].join(" ")}
          >
            {m.role === "user" ? "我" : "AI"}
          </span>
          <div className="min-w-0 flex-1">
            <p className="line-clamp-3 text-[13px] leading-5 text-foreground/90">
              {m.content}
            </p>
            <span className="text-[11px] text-muted-foreground">
              {formatClock(m.timestamp)}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
