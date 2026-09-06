import {
  apiGet,
  apiPost,
  apiPatch,
  apiDelete,
} from "./client";
import type { SessionSummary, SessionDetail } from "./types";

export function listSessions(): Promise<SessionSummary[]> {
  return apiGet<SessionSummary[]>("/sessions");
}

export function getSession(id: string): Promise<SessionDetail> {
  return apiGet<SessionDetail>(`/sessions/${id}`);
}

export interface CreateSessionBody {
  workspaceId?: string;
  presetId?: string;
  newWorkspace?: { name?: string; isTemp?: boolean };
}

export interface CreateSessionResult {
  id: string;
  active: boolean;
  workspaceId: string;
}

export function createSession(body: CreateSessionBody): Promise<CreateSessionResult> {
  return apiPost<CreateSessionResult>("/sessions", body);
}

export function updateSessionName(
  id: string,
  body: { name: string; generated?: boolean },
): Promise<SessionSummary> {
  return apiPatch<SessionSummary>(`/sessions/${id}`, body);
}

export function archiveSession(id: string): Promise<{ id: string; archived: true }> {
  return apiPost<{ id: string; archived: true }>(`/sessions/${id}/archive`);
}

export function activateSession(id: string): Promise<{ id: string; active: boolean }> {
  return apiPost<{ id: string; active: boolean }>(`/sessions/${id}/activate`);
}

export function deleteSession(id: string): Promise<{ id: string; deleted: true; newActiveId: string | null }> {
  return apiDelete<{ id: string; deleted: true; newActiveId: string | null }>(
    `/sessions/${id}`,
  );
}

export function exportSessionMarkdown(id: string): Promise<string> {
  return apiGet<string>(`/sessions/${id}/export.md`);
}
