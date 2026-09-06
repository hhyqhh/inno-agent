"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Plus,
  Library,
  Sparkles,
  UserRound,
  PanelLeft,
  LogIn,
  MessageSquare,
  PanelLeftClose,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { BrandLogo } from "./brand-logo";
import { AvatarMenu } from "./avatar-menu";
import { useUiStore } from "@/lib/store/ui-store";
import { useAuthStore } from "@/lib/store/auth-store";
import { useSessionsStore } from "@/lib/store/sessions-store";

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
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);
  const setActiveSession = useSessionsStore((s) => s.setActiveSession);

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

      {/* 工作区 sessions (logged in) */}
      {user && (
        <>
          <SectionLabel label="工作区" collapsed={collapsed} />
          <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-3 pb-3">
            {sessions.map((s) => (
              <button
                key={s.id}
                type="button"
                title={collapsed ? s.name : undefined}
                onClick={() => {
                  setActiveSession(s.id);
                  router.push(`/workspace?session=${encodeURIComponent(s.id)}`);
                }}
                className={cn(
                  "group flex items-start gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-muted",
                  activeSessionId === s.id
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground",
                  collapsed && "justify-center px-1.5",
                )}
              >
                <MessageSquare className="mt-0.5 size-4 shrink-0 text-muted-foreground/70" />
                {!collapsed && (
                  <>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] leading-5 text-foreground/90">
                        {s.name}
                      </span>
                      <span className="block truncate text-[11px] leading-4 text-muted-foreground">
                        {s.preview}
                      </span>
                    </span>
                    {s.messageCount > 0 && (
                      <span className="rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground">
                        {s.messageCount}
                      </span>
                    )}
                  </>
                )}
              </button>
            ))}
          </div>
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
