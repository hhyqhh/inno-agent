import { apiFetch } from "./client.js";
import type { WorkspaceFileDetail, WorkspaceTree, WorkspaceTreeNode } from "../types/workspace.js";

function qs(workspaceId?: string): string {
	return workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
}

function withWorkspace<T extends Record<string, unknown>>(body: T, workspaceId?: string): T & { workspaceId?: string } {
	return workspaceId ? { ...body, workspaceId } : body;
}

export async function getWorkspaceTree(workspaceId?: string): Promise<WorkspaceTree> {
	return apiFetch<WorkspaceTree>(`/api/workspace/tree${qs(workspaceId)}`);
}

export async function getWorkspaceFile(path: string, workspaceId?: string): Promise<WorkspaceFileDetail> {
	const params = new URLSearchParams({ path });
	if (workspaceId) params.set("workspaceId", workspaceId);
	return apiFetch<WorkspaceFileDetail>(`/api/workspace/file?${params.toString()}`);
}

export async function createWorkspaceItem(path: string, type: "file" | "directory", workspaceId?: string): Promise<WorkspaceTreeNode> {
	return apiFetch<WorkspaceTreeNode>("/api/workspace/create", {
		method: "POST",
		body: JSON.stringify(withWorkspace({ path, type }, workspaceId)),
	});
}

export async function renameWorkspaceItem(oldPath: string, newPath: string, workspaceId?: string): Promise<WorkspaceTreeNode> {
	return apiFetch<WorkspaceTreeNode>("/api/workspace/rename", {
		method: "POST",
		body: JSON.stringify(withWorkspace({ oldPath, newPath }, workspaceId)),
	});
}

export async function deleteWorkspaceItem(path: string, workspaceId?: string): Promise<{ deleted: boolean; path: string }> {
	return apiFetch<{ deleted: boolean; path: string }>("/api/workspace/delete", {
		method: "POST",
		body: JSON.stringify(withWorkspace({ path }, workspaceId)),
	});
}

export async function moveWorkspaceItem(sourcePath: string, targetDir: string, workspaceId?: string): Promise<WorkspaceTreeNode> {
	return apiFetch<WorkspaceTreeNode>("/api/workspace/move", {
		method: "POST",
		body: JSON.stringify(withWorkspace({ sourcePath, targetDir }, workspaceId)),
	});
}

export async function saveWorkspaceFile(path: string, content: string, workspaceId?: string): Promise<{ path: string; saved: boolean; size: number; updatedAt: string }> {
	return apiFetch("/api/workspace/file", {
		method: "PUT",
		body: JSON.stringify(withWorkspace({ path, content }, workspaceId)),
	});
}

export async function uploadWorkspaceFiles(files: Array<{ path: string; dataBase64: string }>, workspaceId?: string): Promise<{ uploaded: WorkspaceTreeNode[] }> {
	return apiFetch<{ uploaded: WorkspaceTreeNode[] }>("/api/workspace/upload", {
		method: "POST",
		body: JSON.stringify(withWorkspace({ files }, workspaceId)),
	});
}
