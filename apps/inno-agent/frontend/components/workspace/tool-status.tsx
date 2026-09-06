"use client";

import type { ReactNode } from "react";
import {
  BookOpen,
  Terminal,
  FilePen,
  Globe,
  FileText,
  Loader2,
  Wrench,
} from "lucide-react";
import { formatDuration } from "@/lib/format";

/**
 * Structural shape shared by the stream's `Tool` and a persisted message's
 * `ToolCall` so one renderer covers both.
 */
export interface ToolLike {
  id: string;
  name: string;
  target?: string;
  summary?: string;
  detail?: string;
  result?: string;
  output?: string;
  status?: "pending" | "running" | "waiting" | "failed" | "error" | "done";
  durationMs?: number;
}

/** Map a registered tool name to a human action noun (浏览/运行/编辑…). */
function actionFor(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("recall")) return "浏览";
  if (n.includes("search") || n.includes("web")) return "检索";
  if (n.includes("run") || n.includes("command")) return "运行";
  if (n.includes("edit")) return "编辑";
  if (n.includes("write") || n.includes("create")) return "写入";
  if (n.includes("read")) return "读取";
  if (n.includes("question")) return "询问";
  return "运行";
}

function iconFor(name: string): ReactNode {
  const n = name.toLowerCase();
  if (n.includes("recall") || n.includes("search") || n.includes("web"))
    return <BookOpen className="size-3.5" />;
  if (n.includes("run") || n.includes("command")) return <Terminal className="size-3.5" />;
  if (n.includes("edit") || n.includes("write") || n.includes("create"))
    return <FilePen className="size-3.5" />;
  if (n.includes("read")) return <FileText className="size-3.5" />;
  if (n.includes("web")) return <Globe className="size-3.5" />;
  return <Wrench className="size-3.5" />;
}

/**
 * One tool row in an assistant message (prototype: 已浏览 121个搜索结果…).
 * When `live` it shows a running indicator and 正在… prefix; otherwise the
 * completed prefix (已运行…) from the persisted tool.
 */
export function ToolStatus({ tool, live }: { tool: ToolLike; live?: boolean }) {
  const action = actionFor(tool.name);
  const detail =
    tool.summary || tool.result || tool.output || tool.detail || tool.target;
  const prefix = live ? `正在${action}` : `已${action}`;
  const failed = tool.status === "failed" || tool.status === "error";

  return (
    <div className="flex min-w-0 items-center gap-1.5 py-0.5 text-xs text-muted-foreground">
      {live ? (
        <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
      ) : (
        <span className="text-muted-foreground">{iconFor(tool.name)}</span>
      )}
      <span className={failed ? "text-destructive" : ""}>{prefix}</span>
      <span className="min-w-0 flex-1 truncate">{detail}</span>
      {tool.durationMs != null && !live && (
        <span className="shrink-0 tabular-nums">{formatDuration(tool.durationMs)}</span>
      )}
    </div>
  );
}
