"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { WorkspaceApp } from "@/components/workspace/workspace-app";

/**
 * /workspace → the expanded three-column workspace. `useSearchParams` must sit
 * inside a <Suspense> for `output: "export"`; the session is read from the
 * ?session= query the home screen navigates with.
 */
function WorkspaceInner() {
  const params = useSearchParams();
  return <WorkspaceApp sessionId={params.get("session")} />;
}

export default function WorkspacePage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">
          正在载入工作区…
        </div>
      }
    >
      <WorkspaceInner />
    </Suspense>
  );
}
