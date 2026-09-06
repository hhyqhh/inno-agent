import { apiGet, apiPost, apiPut } from "./client";
import { buildUrl } from "./client";
import type {
  WorkspaceTreeResponse,
  WorkspaceFileDetail,
  OfficePreview,
  PptxPreview,
  WorkspaceTreeNode,
} from "./types";

export function getWorkspaceTree(
  workspaceId?: string,
): Promise<WorkspaceTreeResponse> {
  return apiGet<WorkspaceTreeResponse>("/workspace/tree", {
    workspaceId,
  });
}

export function getWorkspaceFile(
  workspaceId: string | undefined,
  path: string,
): Promise<WorkspaceFileDetail> {
  return apiGet<WorkspaceFileDetail>("/workspace/file", {
    workspaceId,
    path,
  });
}

export function saveWorkspaceFile(
  workspaceId: string | undefined,
  path: string,
  content: string,
): Promise<{ path: string; saved: true; size: number; updatedAt: string }> {
  return apiPut<{ path: string; saved: true; size: number; updatedAt: string }>(
    "/workspace/file",
    { workspaceId, path, content },
  );
}

export function createWorkspaceNode(
  workspaceId: string | undefined,
  path: string,
  type: "file" | "directory",
): Promise<WorkspaceTreeNode> {
  return apiPost<WorkspaceTreeNode>("/workspace/create", {
    workspaceId,
    path,
    type,
  });
}

export function uploadWorkspaceFiles(
  workspaceId: string | undefined,
  files: { path: string; dataBase64: string }[],
): Promise<{ uploaded: WorkspaceTreeNode[] }> {
  return apiPost<{ uploaded: WorkspaceTreeNode[] }>("/workspace/upload", {
    workspaceId,
    files,
  });
}

export function getOfficePreview(
  workspaceId: string | undefined,
  path: string,
): Promise<OfficePreview> {
  return apiGet<OfficePreview>("/workspace/office-preview", {
    workspaceId,
    path,
  });
}

export function getPptxPreview(
  workspaceId: string | undefined,
  path: string,
): Promise<PptxPreview> {
  return apiGet<PptxPreview>("/workspace/pptx-preview", {
    workspaceId,
    path,
  });
}

// --- raw download / preview URLs -----------------------------------------

/** Absolute URL to the raw bytes of a workspace file. */
export function rawUrl(
  workspaceId: string | undefined,
  path: string,
  download = false,
): string {
  return buildUrl("/workspace/raw", {
    workspaceId,
    path,
    ...(download ? { download: 1 } : {}),
  });
}

export function downloadFolderUrl(
  workspaceId: string | undefined,
  path?: string,
): string {
  return buildUrl("/workspace/download-folder", { workspaceId, path });
}
