"use client";

import { useEffect, useMemo } from "react";
import { AppShell } from "@/components/layout/app-shell";
import { useSessionsStore } from "@/lib/store/sessions-store";
import { useWorkspaceStore } from "@/lib/store/workspace-store";
import { useUiStore } from "@/lib/store/ui-store";
import { useChatStream } from "@/lib/hooks/use-chat-stream";
import { useSseReconnect } from "@/lib/hooks/use-sse-reconnect";
import { formatBytes } from "@/lib/format";
import { Topbar } from "./topbar";
import { ChatView } from "./chat-view";
import { DocPreview } from "./doc-preview";
import { RightPanel } from "./right-panel";

/**
 * Expanded workspace (prototypes 展开工作区 / 展开工作区-2): top bar, the chat
 * column, an optional doc-preview column, and the right 聊天记录/工作区产物
 * panel, plus the workspace-size footer.
 */
export function WorkspaceApp({ sessionId }: { sessionId: string | null }) {
  const openSession = useWorkspaceStore((s) => s.openSession);
  const loading = useWorkspaceStore((s) => s.loading);
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);
  const workspaceName = useWorkspaceStore((s) => s.workspaceName);
  const selectedPath = useWorkspaceStore((s) => s.selectedPath);
  const setSelectedPath = useWorkspaceStore((s) => s.setSelectedPath);
  const workspaceSize = useWorkspaceStore((s) => s.workspaceSize());
  const setActiveSession = useSessionsStore((s) => s.setActiveSession);
  const sessions = useSessionsStore((s) => s.sessions);
  const rightPanelOpen = useUiStore((s) => s.rightPanelOpen);

  const { send, sending } = useChatStream(sessionId);
  useSseReconnect(sessionId);

  useEffect(() => {
    setActiveSession(sessionId);
    void openSession(sessionId);
  }, [sessionId, openSession, setActiveSession]);

  const sessionName = useMemo(
    () => sessions.find((s) => s.id === sessionId)?.name ?? "未命名会话",
    [sessions, sessionId],
  );

  const togglePreview = (path: string) =>
    setSelectedPath(selectedPath === path ? null : path);

  if (loading && !workspaceId) {
    return (
      <AppShell>
        <Topbar sessionName={sessionName} />
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          正在载入工作区…
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <Topbar sessionName={sessionName} />

      <div className="flex min-h-0 flex-1">
        <ChatView
          sessionId={sessionId}
          onSend={send}
          sending={sending}
          onPreview={togglePreview}
        />
        {rightPanelOpen && <DocPreview />}
        {rightPanelOpen && <RightPanel onPreview={togglePreview} />}
      </div>

      <footer className="flex h-8 shrink-0 items-center justify-end gap-1 border-t border-border/60 px-4 text-xs text-muted-foreground">
        <span className="truncate">{workspaceName || "未命名工作区"}</span>
        {workspaceSize > 0 && <span>· 共 {formatBytes(workspaceSize)}</span>}
      </footer>
    </AppShell>
  );
}
