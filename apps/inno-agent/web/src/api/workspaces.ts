import { apiFetch } from "./client.js";
import { arrayBufferToBase64 } from "./uploads.js";

export interface WorkspaceMeta {
	id: string;
	name: string;
	relPath: string;
	createdAt: string;
	updatedAt: string;
	isTemp: boolean;
	sessionIds?: string[];
}

export type WorkspaceFileAccess = "read" | "write" | "read_write";

export interface WorkspaceSwitchFile {
	path: string;
	access: WorkspaceFileAccess;
	exists: boolean;
	selectable: boolean;
}

export interface WorkspaceSwitchPreview {
	sourceWorkspace: WorkspaceMeta;
	targetWorkspace: WorkspaceMeta;
	files: WorkspaceSwitchFile[];
	trackingIncomplete: boolean;
}

export type WorkspaceSwitchFileAction = "move" | "copy" | "none";

export type WorkspaceSwitchFileStatus = "moved" | "copied" | "conflict" | "missing" | "failed";

export interface WorkspaceSwitchFileResult {
	path: string;
	access: WorkspaceFileAccess;
	action: Exclude<WorkspaceSwitchFileAction, "none">;
	status: WorkspaceSwitchFileStatus;
	error?: string;
	copied?: boolean;
}

export interface WorkspaceSwitchResult {
	switched: boolean;
	sessionId: string;
	sourceWorkspace: WorkspaceMeta;
	targetWorkspace: WorkspaceMeta;
	files: WorkspaceSwitchFileResult[];
	statistics: {
		success: number;
		conflicts: number;
		failures: number;
		missing: number;
		selected: number;
	};
	trackingIncomplete: boolean;
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

/** Import a workspace from a .zip archive (e.g. an exported preset workspace bundle). */
export async function importWorkspaceZip(file: File, name?: string): Promise<WorkspaceMeta> {
	const dataBase64 = arrayBufferToBase64(await file.arrayBuffer());
	return apiFetch<WorkspaceMeta>("/api/workspaces/import", {
		method: "POST",
		body: JSON.stringify({ fileName: file.name, dataBase64, name }),
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

export async function getWorkspaceSwitchPreview(sessionId: string, targetWorkspaceId: string): Promise<WorkspaceSwitchPreview> {
	return apiFetch<WorkspaceSwitchPreview>(
		`/api/sessions/${encodeURIComponent(sessionId)}/workspace/switch-preview?targetWorkspaceId=${encodeURIComponent(targetWorkspaceId)}`,
	);
}

export async function switchSessionWorkspace(
	sessionId: string,
	input: { targetWorkspaceId: string; fileActions: Record<string, WorkspaceSwitchFileAction> },
): Promise<WorkspaceSwitchResult> {
	return apiFetch<WorkspaceSwitchResult>(`/api/sessions/${encodeURIComponent(sessionId)}/workspace/switch`, {
		method: "POST",
		body: JSON.stringify(input),
	});
}
