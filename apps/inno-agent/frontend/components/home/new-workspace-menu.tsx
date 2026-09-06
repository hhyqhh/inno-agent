"use client";

import { Folder, FilePlus2, Briefcase, ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useSessionsStore } from "@/lib/store/sessions-store";

export type WorkspaceChoice =
  | { kind: "existing"; workspaceId: string }
  | { kind: "new" }
  | { kind: "temp" };

/**
 * 「新工作区」dropdown (首页（已登录）/ 展开工作区). Draft state only — the
 * session is actually created on first send (see hero.composer flow). Picking
 * an existing workspace binds to it; new/temp create one on send.
 */
export function NewWorkspaceMenu({
  onSelect,
  trigger = "button",
}: {
  onSelect: (choice: WorkspaceChoice) => void;
  trigger?: "button" | "text";
}) {
  const workspaces = useSessionsStore((s) => s.workspaces);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex items-center gap-1.5 rounded-xl text-sm text-foreground transition-colors hover:bg-muted",
            trigger === "button"
              ? "border border-border/60 bg-background px-3 py-2 font-medium shadow-sm"
              : "px-2 py-1.5 text-muted-foreground",
          )}
        >
          <Briefcase className="size-4 text-muted-foreground" />
          新工作区
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Folder className="size-4" />
            已有工作区
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-56">
            {workspaces.map((w) => (
              <DropdownMenuItem
                key={w.id}
                onSelect={() => onSelect({ kind: "existing", workspaceId: w.id })}
              >
                <span className="min-w-0 flex-1 truncate">{w.name}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem onSelect={() => onSelect({ kind: "new" })}>
          <FilePlus2 className="size-4" />
          新建工作区
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onSelect({ kind: "temp" })}>
          <Briefcase className="size-4" />
          <span className="flex-1">临时工作区</span>
          <span className="text-[11px] text-muted-foreground">用完即弃</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
