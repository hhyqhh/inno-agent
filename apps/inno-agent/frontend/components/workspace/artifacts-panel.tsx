"use client";

import type { WorkspaceTreeNode } from "@/lib/api/types";
import { formatBytes, formatClock } from "@/lib/format";
import { kindFromName, kindIcon, kindTint } from "./file-card";

/**
 * The 工作区产物 tab (prototype 展开工作区 right panel): the workspace's files
 * as compact cards. Clicking a file opens it in the doc preview column.
 */
export function ArtifactsPanel({
  tree,
  selectedPath,
  onPreview,
}: {
  tree: WorkspaceTreeNode | null;
  selectedPath: string | null;
  onPreview?: (path: string) => void;
}) {
  const files =
    tree?.type === "directory"
      ? (tree.children ?? []).filter((c) => c.type === "file")
      : [];

  if (files.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-xs text-muted-foreground">
        暂无工作区文件。
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5 p-3">
      {files.map((f) => {
        const kind = kindFromName(f.name);
        const active = selectedPath === f.path;
        const cap = kind.toUpperCase();
        return (
          <button
            key={f.path}
            type="button"
            onClick={() => onPreview?.(f.path)}
            className={[
              "flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left",
              active
                ? "border-primary/40 bg-primary/5"
                : "border-transparent hover:border-border/70 hover:bg-muted/50",
            ].join(" ")}
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
              <span className={kindTint(kind)}>{kindIcon(kind)}</span>
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-foreground">
                {f.name}
              </span>
              <span className="block truncate text-[11px] text-muted-foreground">
                {cap} · {formatBytes(f.size)} · {formatClock(Date.parse(f.updatedAt))}生成
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
