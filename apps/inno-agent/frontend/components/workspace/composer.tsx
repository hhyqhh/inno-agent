"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Plus, ArrowUp, Zap } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { NewWorkspaceMenu } from "@/components/home/new-workspace-menu";

const PERMISSION_OPTIONS = ["自动", "只读", "读写"];

/**
 * The workspace composer (prototype): a filled input row + the helper row
 * 新工作区 / 默认权限 / 快速生成. On Enter it drives a turn in the current
 * session via `onSend`.
 */
export function Composer({
  onSend,
  sending,
  disabled,
}: {
  onSend: (prompt: string) => void;
  sending: boolean;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [permission, setPermission] = useState("自动");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const prompt = value.trim();
    if (!prompt || sending || disabled) return;
    onSend(prompt);
    setValue("");
  };

  const changeWorkspace = () => {
    // Starting a fresh task always returns to the home picker.
    router.push("/");
  };

  return (
    <div className="shrink-0 px-4 pb-3">
      <form onSubmit={submit} className="rounded-2xl border border-border/70 bg-muted/40 shadow-sm focus-within:border-primary/30 focus-within:ring-2 focus-within:ring-primary/20">
        <div className="flex items-center gap-2 px-3 py-2.5">
          <button
            type="button"
            aria-label="附件"
            className="rounded-full p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Plus className="size-5" />
          </button>
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="继续对话，例如：把这节课延伸成群文阅读"
            className="min-w-0 flex-1 bg-transparent py-1 text-[15px] text-foreground outline-none placeholder:text-muted-foreground"
          />
          <button
            type="submit"
            aria-label="发送"
            disabled={sending || disabled || !value.trim()}
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-foreground text-background transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            <ArrowUp className="size-4" />
          </button>
        </div>
      </form>

      <div className="mt-1.5 flex items-center justify-between px-1">
        <div className="flex items-center gap-2">
          <NewWorkspaceMenu onSelect={changeWorkspace} trigger="text" />
          <Select value={permission} onValueChange={setPermission}>
            <SelectTrigger className="h-8 gap-1 rounded-lg border-transparent px-1.5 text-xs text-muted-foreground shadow-none hover:bg-muted">
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
        </div>
        <button
          type="button"
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <Zap className="size-3.5" />
          快速生成
        </button>
      </div>
    </div>
  );
}
