import { apiGet, apiPost, apiPatch, apiDelete } from "./client";
import type { WorkspaceWithSessions, WorkspaceMeta } from "./types";

export function listWorkspaces(): Promise<WorkspaceWithSessions[]> {
  return apiGet<WorkspaceWithSessions[]>("/workspaces");
}

export function createWorkspace(body: {
  name?: string;
  isTemp?: boolean;
}): Promise<WorkspaceMeta> {
  return apiPost<WorkspaceMeta>("/workspaces", body);
}

export function renameWorkspace(
  id: string,
  name: string,
): Promise<WorkspaceMeta> {
  return apiPatch<WorkspaceMeta>(`/workspaces/${id}`, { name });
}

export function deleteWorkspace(
  id: string,
  removeFiles?: boolean,
): Promise<{ id: string; deleted: true; removedFiles: boolean }> {
  return apiDelete<{ id: string; deleted: true; removedFiles: boolean }>(
    `/workspaces/${id}${removeFiles ? "?removeFiles=1" : ""}`,
  );
}
