"use client";

import { useState } from "react";
import { useWorkspaceStore } from "@/lib/store/workspace-store";
import { cn } from "@/lib/utils";
import { ArtifactsPanel } from "./artifacts-panel";
import { ChatRecords } from "./chat-records";

type Tab = "chat" | "artifacts";

/**
 * Right column (prototype 展开工作区 / 展开工作区-2). Toggles between 聊天记录
 * and 工作区产物; the artifact tab lists the workspace files and drives the
 * doc-preview column.
 */
export function RightPanel({ onPreview }: { onPreview?: (path: string) => void }) {
  const tree = useWorkspaceStore((s) => s.tree);
  const messages = useWorkspaceStore((s) => s.messages);
  const selectedPath = useWorkspaceStore((s) => s.selectedPath);
  const [tab, setTab] = useState<Tab>("artifacts");

  const fileCount =
    tree?.type === "directory"
      ? (tree.children ?? []).filter((c) => c.type === "file").length
      : 0;

  return (
    <div className="flex h-full w-72 shrink-0 flex-col border-l border-border/70 bg-background">
      <div className="flex shrink-0 items-center justify-between px-3 pt-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setTab("chat")}
            className={cn(
              "rounded-lg px-2 py-1 text-xs font-medium transition-colors",
              tab === "chat"
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            聊天记录
          </button>
          <button
            type="button"
            onClick={() => setTab("artifacts")}
            className={cn(
              "rounded-lg px-2 py-1 text-xs font-medium transition-colors",
              tab === "artifacts"
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            工作区产物
          </button>
        </div>
        {tab === "artifacts" && (
          <span className="text-xs text-muted-foreground">{fileCount}个文件</span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "chat" ? (
          <ChatRecords messages={messages} />
        ) : (
          <ArtifactsPanel
            tree={tree}
            selectedPath={selectedPath}
            onPreview={onPreview}
          />
        )}
      </div>
    </div>
  );
}
