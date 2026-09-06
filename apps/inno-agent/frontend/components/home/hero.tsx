"use client";

import { useState, type FormEvent } from "react";
import { Plus, Zap, Sparkles } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { NewWorkspaceMenu, type WorkspaceChoice } from "./new-workspace-menu";
import { useAuthStore } from "@/lib/store/auth-store";

const PERMISSION_OPTIONS = ["自动", "只读", "读写"];

export function Hero({
  loggedIn,
  onSend,
}: {
  loggedIn: boolean;
  onSend: (prompt: string, choice: WorkspaceChoice | null) => void;
}) {
  const name = useAuthStore((s) => s.user?.name) ?? "格格";
  const [value, setValue] = useState("");
  const [choice, setChoice] = useState<WorkspaceChoice | null>(null);
  const [permission, setPermission] = useState("自动");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const prompt = value.trim();
    if (!prompt) return;
    onSend(prompt, choice);
    setValue("");
  };

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col items-center px-4 pt-[16vh]">
      <div className="w-full">
        <h1 className="mb-8 text-center text-3xl font-semibold tracking-tight text-foreground md:text-4xl">
          {name}，说出你的教育需求
        </h1>

        <form onSubmit={submit} className="w-full">
          {/* search / command input */}
          <div className="flex items-center gap-2 rounded-full border border-border bg-card/90 py-2 pl-3 pr-2 shadow-lg shadow-primary/5 backdrop-blur transition-shadow focus-within:shadow-xl focus-within:ring-2 focus-within:ring-primary/20">
            <button
              type="button"
              aria-label="附件"
              className="rounded-full p-2 text-muted-foreground hover:bg-muted"
            >
              <Plus className="size-5" />
            </button>
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="描述你的教学任务，例如：为初二物理《浮力》设计一节课探究课"
              className="min-w-0 flex-1 bg-transparent py-2 text-[15px] text-foreground outline-none placeholder:text-muted-foreground"
            />
            <button
              type="submit"
              aria-label="发送"
              className="flex size-8 items-center justify-center rounded-full bg-foreground text-background transition-opacity hover:opacity-90"
            >
              <Sparkles className="size-4" />
            </button>
          </div>

          {/* workspace + permission + quick generate */}
          <div className="mt-3 flex items-center justify-between gap-2 pl-1">
            <div className="flex items-center gap-2">
              <NewWorkspaceMenu onSelect={setChoice} />
              {loggedIn && (
                <Select
                  value={permission}
                  onValueChange={setPermission}
                >
                  <SelectTrigger className="h-9 w-36 gap-1.5 rounded-xl border-border/60 text-sm shadow-sm">
                    <SelectValue placeholder="默认权限" />
                  </SelectTrigger>
                  <SelectContent>
                    {PERMISSION_OPTIONS.map((p) => (
                      <SelectItem key={p} value={p}>
                        {p}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            {loggedIn && (
              <button
                type="button"
                className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
              >
                <Zap className="size-4" />
                快速生成
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
