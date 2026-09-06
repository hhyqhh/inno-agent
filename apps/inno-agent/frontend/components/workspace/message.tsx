"use client";

import { useState } from "react";
import { ChevronsUpDown, ArrowRight, Image as ImageIcon } from "lucide-react";
import type { SessionMessageSummary } from "@/lib/api/types";
import { BrandMark } from "@/components/layout/brand-logo";
import { Markdown } from "./markdown";
import { ToolStatus, type ToolLike } from "./tool-status";
import { FileCard } from "./file-card";
import { formatDuration } from "@/lib/format";

const SUGGESTIONS = ["下一步该做什么", "下一步该做什么引导词"];

function headerMs(tools: ToolLike[] | undefined): number | null {
  if (!tools || tools.length === 0) return null;
  const total = tools.reduce((acc, t) => acc + (t.durationMs ?? 0), 0);
  if (total <= 0) return null;
  return total;
}

/**
 * One chat message (prototype 展开工作区). The assistant bubble shows a
 * collapsible tool-status header, the markdown body, attachment file cards and
 * (for planning turns) 下一步建议 links.
 */
export function Message({
  message,
  workspaceId,
  onPreview,
}: {
  message: SessionMessageSummary;
  workspaceId?: string;
  onPreview?: (path: string) => void;
}) {
  // Rule of hooks: call all hooks before any early return.
  const [expanded, setExpanded] = useState(true);

  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[78%] rounded-2xl rounded-br-md bg-[#eef1ff] px-4 py-3 text-[15px] leading-6 text-foreground dark:bg-primary/15">
          {message.content}
          {message.images?.length ? (
            <ImageIcon className="mt-1 size-5 text-muted-foreground" />
          ) : null}
        </div>
      </div>
    );
  }

  const tools = message.tools ?? [];
  const duration = headerMs(tools);
  const attachments = message.attachments?.loose ?? [];
  const showSuggestions = tools.length > 0 && attachments.length === 0;

  return (
    <div className="flex gap-3">
      <BrandMark className="mt-1 size-8 rounded-xl" />
      <div className="min-w-0 flex-1">
        {duration != null && tools.length > 0 && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="mb-1 flex items-center gap-1 rounded-full border border-border/70 bg-card px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted"
          >
            已运行 {formatDuration(duration)}
            <ChevronsUpDown className="size-3.5" />
          </button>
        )}

        {expanded && tools.length > 0 && (
          <div className="mb-1 flex flex-col">
            {tools.map((t) => (
              <ToolStatus key={t.id} tool={t} />
            ))}
          </div>
        )}

        <Markdown content={message.content} />

        {attachments.length > 0 && (
          <div className="mt-3 flex flex-col gap-2">
            {attachments.map((a, i) => (
              <FileCard
                key={`${a.path}-${i}`}
                path={a.path}
                kind={a.kind}
                workspaceId={workspaceId}
                onPreview={onPreview}
              />
            ))}
          </div>
        )}

        {showSuggestions && (
          <div className="mt-3 flex flex-col gap-1.5">
            {SUGGESTIONS.map((s) => (
              <a
                key={s}
                href="#"
                onClick={(e) => e.preventDefault()}
                className="inline-flex w-fit items-center gap-1 rounded-lg px-1 py-0.5 text-sm text-muted-foreground hover:text-primary"
              >
                {s}
                <ArrowRight className="size-4" />
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
