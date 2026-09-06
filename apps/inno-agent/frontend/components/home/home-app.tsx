"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { AppShell } from "@/components/layout/app-shell";
import { Hero } from "./hero";
import { SkillCards } from "./skill-card";
import type { WorkspaceChoice } from "./new-workspace-menu";
import { useAuthStore } from "@/lib/store/auth-store";
import { useSessionsStore } from "@/lib/store/sessions-store";

/**
 * Home view (prototypes 首页（未登录）/首页（已登录）). Renders the hero search +
 * skill cards. On send, creates a session (bind to an existing workspace, or a
 * fresh / temp one) then routes into the workspace. 409 会话繁忙 is retried by
 * the user gesture — the store's `creating` guard already suppresses duplicates.
 */
export function HomeApp() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const createSession = useSessionsStore((s) => s.createSession);
  const load = useSessionsStore((s) => s.load);
  const [error, setError] = useState<string | null>(null);

  // Load workspaces/sessions so the sidebar + 已有工作区 submenu populate in
  // both auth states (mock fixtures are auth-independent).
  useEffect(() => {
    void load();
  }, [load]);

  const handleSend = async (prompt: string, choice: WorkspaceChoice | null) => {
    setError(null);

    const workspaceId = choice?.kind === "existing" ? choice.workspaceId : undefined;
    const newWorkspace =
      choice?.kind === "new"
        ? { name: prompt.slice(0, 20) || "新工作区", isTemp: false }
        : choice?.kind === "temp"
          ? { isTemp: true }
          : undefined;

    try {
      const session = await createSession({ workspaceId, newWorkspace });
      router.push(`/workspace?session=${encodeURIComponent(session.id)}`);
    } catch (e) {
      const err = e as { status?: number; message?: string };
      if (err?.status === 409) {
        setError("该工作区已有会话在进行中，请稍后重试");
      } else {
        setError(err?.message ?? "创建会话失败");
      }
    }
  };

  return (
    <AppShell>
      <div className="hero-backdrop flex flex-1 flex-col overflow-y-auto">
        <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col px-4 pb-24">
          <Hero loggedIn={!!user} onSend={handleSend} />

          {/* Skill cards pinned near the bottom; 更多技能 above them, right-aligned. */}
          <div className="mt-auto pt-14">
            <div className="mb-3 flex justify-end">
              <button
                type="button"
                className="flex items-center gap-0.5 text-sm text-muted-foreground hover:text-foreground"
              >
                更多技能
                <ChevronRight className="size-4" />
              </button>
            </div>
            <SkillCards />
          </div>

          {error && (
            <div className="mx-auto mt-4 w-full max-w-md rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-center text-sm text-destructive">
              {error}
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}
