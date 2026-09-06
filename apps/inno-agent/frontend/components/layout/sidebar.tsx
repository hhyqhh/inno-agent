"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useMemo, useState } from "react";
import {
  Plus,
  Library,
  Sparkles,
  UserRound,
  PanelLeft,
  LogIn,
  PanelLeftClose,
  Folder,
  Square,
  MoreHorizontal,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { BrandLogo } from "./brand-logo";
import { AvatarMenu } from "./avatar-menu";
import { useUiStore } from "@/lib/store/ui-store";
import { useAuthStore } from "@/lib/store/auth-store";
import { useSessionsStore } from "@/lib/store/sessions-store";
import type { SessionSummary } from "@/lib/api/types";

const NAV_ITEMS = [
  { id: "knowledge", label: "知识库", icon: Library },
  { id: "skills", label: "技能仓库", icon: Sparkles },
  { id: "learner", label: "学习看画像", icon: UserRound },
];

function SectionLabel({ label, collapsed }: { label: string; collapsed: boolean }) {
  if (collapsed) return <div className="mx-2 my-2 h-px bg-border" />;
  return (
    <div className="px-3 pb-1 pt-5 text-xs font-medium text-muted-foreground">
      {label}
    </div>
  );
}

/**
 * Left drawer navigation (prototypes). Collapses to an icon rail in the
 * workspace view via ui-store. Two bottom states: logged-out login strip,
 * logged-in avatar menu + workspace/session list.
 */
export function Sidebar() {
  const router = useRouter();
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggle = useUiStore((s) => s.toggleSidebar);
  const user = useAuthStore((s) => s.user);
  const login = useAuthStore((s) => s.login);
  const sessions = useSessionsStore((s) => s.sessions);
  const workspaces = useSessionsStore((s) => s.workspaces);
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);
  const setActiveSession = useSessionsStore((s) => s.setActiveSession);

  // 工作区 = 一级「任务/工作区」→ 二级该任务下每个会話（prototype 即可见的是
  // 任务名作为分组头，会话折叠在下面）。collapsed 时收起为图标栏，不显示分组头。
  const sessionById = useMemo(
    () => new Map(sessions.map((s) => [s.id, s])),
    [sessions],
  );
  const groups = useMemo(
    () =>
      workspaces
        .map((ws) => ({
          workspace: ws,
          items: ws.sessionIds
            .map((id) => sessionById.get(id))
            .filter((s): s is SessionSummary => Boolean(s)),
        })),
    [workspaces, sessionById],
  );

  const [collapsedTasks, setCollapsedTasks] = useState<Record<string, boolean>>({});
  const toggleTask = (id: string) =>
    setCollapsedTasks((prev) => ({ ...prev, [id]: !prev[id] }));

  return (
    <aside
      className={cn(
        "flex h-full shrink-0 flex-col border-r border-border bg-sidebar transition-[width] duration-200",
        collapsed ? "w-16" : "w-64",
      )}
    >
      {/* Logo + collapse toggle */}
      <div className="flex items-center justify-between gap-2 px-3 py-4">
        {collapsed ? (
          <Link href="/" className="mx-auto">
            <BrandLogo text={false} />
          </Link>
        ) : (
          <Link href="/" className="px-1">
            <BrandLogo />
          </Link>
        )}
        <button
          type="button"
          aria-label="收起侧栏"
          onClick={toggle}
          className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {collapsed ? (
            <PanelLeft className="size-4" />
          ) : (
            <PanelLeftClose className="size-4" />
          )}
        </button>
      </div>

      {/* 新建任务 */}
      <div className="px-3 pb-2">
        <button
          type="button"
          onClick={() => router.push("/")}
          className={cn(
            "flex w-full items-center gap-2 rounded-xl border border-border/60 bg-background px-3 py-2.5 text-sm font-medium text-foreground shadow-sm transition-colors hover:bg-muted/60",
            collapsed && "justify-center px-2",
          )}
        >
          <Plus className="size-4 text-primary" />
          {!collapsed && "新建任务"}
        </button>
      </div>

      {/* 工作台 nav */}
      <SectionLabel label="工作台" collapsed={collapsed} />
      <nav className="flex flex-col gap-0.5 px-3">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            title={collapsed ? item.label : undefined}
            className={cn(
              "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
              collapsed && "justify-center px-2",
            )}
          >
            <item.icon className="size-4 shrink-0" />
            {!collapsed && item.label}
          </button>
        ))}
      </nav>

      {/* 任务区 sessions (logged in) — two-level: task -> sessions */}
      {user && (
        <>
          <SectionLabel label="任务区" collapsed={collapsed} />
          {collapsed ? (
            // Collapsed rail: show each session as a flat icon button.
            <div className="flex flex-1 flex-col items-center gap-0.5 overflow-y-auto px-3 pb-3">
              {sessions.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  title={s.name}
                  onClick={() => {
                    setActiveSession(s.id);
                    router.push(`/workspace?session=${encodeURIComponent(s.id)}`);
                  }}
                  className={cn(
                    "flex items-center justify-center rounded-lg p-2 transition-colors hover:bg-muted",
                    activeSessionId === s.id
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  <Square className="size-4 shrink-0 text-muted-foreground/70" />
                </button>
              ))}
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto px-3 pb-3">
              {groups.map(({ workspace, items }) => {
                const collapsedTask = collapsedTasks[workspace.id] === true;
                return (
                  <div key={workspace.id} className="flex flex-col">
                    {/* Level 1 — task / workspace header (prototype: folder + name +
                        count pill when expanded, ellipsis when collapsed) */}
                    <button
                      type="button"
                      onClick={() => toggleTask(workspace.id)}
                      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      <Folder className="size-4 shrink-0" />
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-5 text-foreground/90">
                        {workspace.name}
                      </span>
                      {collapsedTask ? (
                        <MoreHorizontal className="size-4 shrink-0 text-muted-foreground" />
                      ) : (
                        items.length > 0 && (
                          <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[11px] leading-none text-primary">
                            {items.length}
                          </span>
                        )
                      )}
                    </button>

                    {/* Level 2 — sessions under this task */}
                    {!collapsedTask && (
                      <div className="ml-3 mt-0.5 flex flex-col gap-0.5">
                        {items.length === 0 && (
                          <span className="px-2 py-1 text-[11px] text-muted-foreground/60">
                            该任务暂无会话
                          </span>
                        )}
                        {items.map((s) => (
                          <button
                            key={s.id}
                            type="button"
                            title={s.name}
                            onClick={() => {
                              setActiveSession(s.id);
                              router.push(`/workspace?session=${encodeURIComponent(s.id)}`);
                            }}
                            className={cn(
                              "group flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted",
                              activeSessionId === s.id
                                ? "bg-muted"
                                : "text-muted-foreground",
                            )}
                          >
                            <Square className="size-4 shrink-0 text-muted-foreground/80" />
                            <span
                              className={cn(
                                "min-w-0 flex-1 truncate text-[13px] leading-5 text-foreground/90",
                                activeSessionId === s.id && "font-medium text-foreground",
                              )}
                            >
                              {s.name}
                            </span>
                            {s.messageCount > 0 && (
                              <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[11px] leading-none text-primary">
                                {s.messageCount}
                              </span>
                            )}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* Bottom: login strip (out) / avatar (in) */}
      <div className="border-t border-border/60 p-3">
        {user ? (
          <div className={cn("flex items-center justify-between", collapsed && "justify-center")}>
            <AvatarMenu />
          </div>
        ) : (
          <div
            className={cn(
              "flex flex-col gap-2",
              collapsed && "items-center justify-center",
            )}
          >
            {!collapsed && (
              <p className="text-center text-[11px] text-muted-foreground">
                登录后使用完整功能
              </p>
            )}
            <button
              type="button"
              onClick={() => login("格格")}
              className={cn(
                "brand-gradient flex items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-medium text-white shadow-sm transition-opacity hover:opacity-90",
                collapsed && "size-9 rounded-full p-0",
              )}
            >
              <LogIn className="size-4" />
              {!collapsed && "登录"}
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
