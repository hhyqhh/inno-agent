"use client";

import {
  User,
  Bot,
  Globe,
  Info,
  MessageSquare,
  LogOut,
  Settings,
} from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuthStore } from "@/lib/store/auth-store";

const MENU_ITEMS = [
  { id: "account", label: "账号管理", icon: User },
  { id: "assistant", label: "智能助手", icon: Bot },
  { id: "website", label: "启创官网", icon: Globe, external: true },
  { id: "about", label: "关于启创", icon: Info },
  { id: "feedback", label: "意见反馈", icon: MessageSquare },
];

/**
 * Bottom avatar + the dropdown it opens (首页（已登录）-2). 官方网站 opens an
 * external link; the rest are placeholders. 退出登录 clears the local login.
 */
export function AvatarMenu() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

  return (
    <div className="flex items-center gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-2 rounded-xl px-2 py-1.5 text-sm hover:bg-muted"
          >
            <Avatar className="size-8">
              <AvatarFallback className="bg-gradient-to-br from-[#6366F1] to-[#8b5cf6] text-[13px] font-medium text-white">
                {user?.name?.slice(0, 1) ?? "格"}
              </AvatarFallback>
            </Avatar>
            <span className="font-medium text-foreground">{user?.name ?? "格格"}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-52">
          {MENU_ITEMS.map((item) =>
            item.external ? (
              <DropdownMenuItem key={item.id} asChild>
                <a
                  href="https://innospark.example.com"
                  target="_blank"
                  rel="noreferrer"
                  className="w-full"
                >
                  <item.icon className="size-4" />
                  {item.label}
                </a>
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem key={item.id}>
                <item.icon className="size-4" />
                {item.label}
              </DropdownMenuItem>
            ),
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={logout}
            className="text-destructive focus:text-destructive"
          >
            <LogOut className="size-4" />
            退出登录
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <button
        type="button"
        aria-label="设置"
        className="rounded-xl p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <Settings className="size-5" />
      </button>
    </div>
  );
}
