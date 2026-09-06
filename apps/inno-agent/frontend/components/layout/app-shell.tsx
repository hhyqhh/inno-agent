"use client";

import type { ReactNode } from "react";
import { Sidebar } from "./sidebar";

/**
 * Two-column chrome shared by the home and workspace views: collapsible left
 * drawer + the main content column.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen w-full overflow-hidden bg-background">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">{children}</main>
    </div>
  );
}
