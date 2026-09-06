"use client";

import { FileText, PanelRight, PanelRightClose } from "lucide-react";
import { useUiStore } from "@/lib/store/ui-store";
import { useWorkspaceStore } from "@/lib/store/workspace-store";
import { shortWorkspaceName } from "@/lib/format";

/**
 * Workspace top bar (prototype 展开工作区): session title, the workspace pill,
 * and the right-panel collapse toggle. A file glyph prefix appears when a doc
 * is open for preview.
 */
export function Topbar({ sessionName }: { sessionName: string }) {
  const selectedPath = useWorkspaceStore((s) => s.selectedPath);
  const workspaceName = useWorkspaceStore((s) => s.workspaceName);
  const rightPanelOpen = useUiStore((s) => s.rightPanelOpen);
  const toggleRightPanel = useUiStore((s) => s.toggleRightPanel);

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border/70 px-4">
      <div className="flex min-w-0 items-center gap-2.5">
        {selectedPath && <FileText className="size-4 shrink-0 text-muted-foreground" />}
        <span className="truncate text-[15px] font-medium text-foreground">
          {sessionName}
        </span>
        <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-border/60 bg-background px-3 py-1 text-xs text-muted-foreground">
          <span className="size-1.5 rounded-full bg-primary" />
          {shortWorkspaceName(workspaceName)}
        </span>
      </div>
      <button
        type="button"
        aria-label={rightPanelOpen ? "收起右侧面板" : "展开右侧面板"}
        onClick={toggleRightPanel}
        className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        {rightPanelOpen ? (
          <PanelRightClose className="size-4" />
        ) : (
          <PanelRight className="size-4" />
        )}
      </button>
    </header>
  );
}
