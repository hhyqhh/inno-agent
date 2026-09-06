"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Plus, ArrowUp, Zap, ChevronDown, Lock } from "lucide-react";
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
    <div className="shrink-0">
      <form
        onSubmit={submit}
        className="flex items-center gap-2.5 rounded-full border border-primary/20 bg-background py-2 pl-2.5 pr-2 shadow-sm transition-colors focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/15"
      >
        <button
          type="button"
          aria-label="附件"
          className="ml-1 rounded-full p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Plus className="size-5" />
        </button>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="继续对话，例如：把这节课延伸成群文阅读"
          className="min-w-0 flex-1 bg-transparent py-2 text-base text-foreground outline-none placeholder:text-muted-foreground"
        />
        <button
          type="submit"
          aria-label="发送"
          disabled={sending || disabled || !value.trim()}
          className="flex size-11 shrink-0 items-center justify-center rounded-full bg-foreground text-background transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          <ArrowUp className="size-5" />
        </button>
      </form>

      <div className="mt-2 flex items-center justify-between px-0.5">
        <div className="flex items-center gap-1.5">
          <NewWorkspaceMenu onSelect={changeWorkspace} trigger="pill" />
          <Select value={permission} onValueChange={setPermission}>
            <SelectTrigger className="h-8 gap-1 rounded-full border border-border/60 bg-background px-2.5 text-xs text-muted-foreground shadow-none hover:bg-muted">
              <Lock className="size-3.5 text-muted-foreground" />
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
          className="flex items-center gap-1 rounded-full border border-border/60 bg-background px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-muted"
        >
          <Zap className="size-3.5" />
          快速生成
          <ChevronDown className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
