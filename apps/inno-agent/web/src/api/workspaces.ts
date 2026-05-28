import { apiFetch } from "./client.js";

export interface WorkspaceMeta {
	id: string;
	name: string;
	relPath: string;
	createdAt: string;
	updatedAt: string;
	isTemp: boolean;
	sessionIds?: string[];
}

export interface CreateWorkspaceInput {
	name?: string;
	isTemp?: boolean;
}

export async function listWorkspaces(): Promise<WorkspaceMeta[]> {
	return apiFetch<WorkspaceMeta[]>("/api/workspaces");
}

export async function createWorkspace(input: CreateWorkspaceInput): Promise<WorkspaceMeta> {
	return apiFetch<WorkspaceMeta>("/api/workspaces", {
		method: "POST",
		body: JSON.stringify(input),
	});
}

export async function renameWorkspace(id: string, name: string): Promise<WorkspaceMeta> {
	return apiFetch<WorkspaceMeta>(`/api/workspaces/${encodeURIComponent(id)}`, {
		method: "PATCH",
		body: JSON.stringify({ name }),
	});
}

export async function deleteWorkspace(id: string, removeFiles = false): Promise<{ id: string; deleted: boolean; removedFiles: boolean }> {
	const q = removeFiles ? "?removeFiles=1" : "";
	return apiFetch(`/api/workspaces/${encodeURIComponent(id)}${q}`, {
		method: "DELETE",
	});
}

export async function getSessionWorkspace(sessionId: string): Promise<{ sessionId: string; workspaceId: string; workspace: WorkspaceMeta | null }> {
	return apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/workspace`);
}

export async function bindSessionWorkspace(sessionId: string, workspaceId: string): Promise<{ sessionId: string; workspaceId: string }> {
	return apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/workspace`, {
		method: "PUT",
		body: JSON.stringify({ workspaceId }),
	});
}
