import { apiFetch } from "./client.js";
import type { SkillInfo, SkillLibraryItem } from "../types/skills.js";
import type { WorkspaceTreeNode, WorkspaceFileDetail } from "../types/workspace.js";

export async function listSkills(): Promise<SkillInfo[]> {
	return apiFetch<SkillInfo[]>("/api/skills");
}

export async function listSkillLibrary(forceRefresh = false): Promise<SkillLibraryItem[]> {
	return apiFetch<SkillLibraryItem[]>(`/api/skill-library${forceRefresh ? "?refresh=1" : ""}`);
}

export async function importSkillFromLibrary(name: string): Promise<SkillInfo> {
	return apiFetch<SkillInfo>("/api/skill-library/import", {
		method: "POST",
		body: JSON.stringify({ name }),
	});
}

export async function uploadSkill(file: File): Promise<SkillInfo> {
	const dataBase64 = await new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const result = String(reader.result ?? "");
			resolve(result.includes(",") ? result.split(",")[1] : result);
		};
		reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
		reader.readAsDataURL(file);
	});

	return apiFetch<SkillInfo>("/api/skills/upload", {
		method: "POST",
		body: JSON.stringify({
			fileName: file.name,
			mimeType: file.type || "text/markdown",
			dataBase64,
		}),
	});
}

export async function updateSkill(name: string, enabled: boolean): Promise<SkillInfo> {
	return apiFetch<SkillInfo>(`/api/skills/${encodeURIComponent(name)}`, {
		method: "PATCH",
		body: JSON.stringify({ enabled }),
	});
}

export async function deleteSkill(name: string): Promise<void> {
	await apiFetch(`/api/skills/${encodeURIComponent(name)}`, { method: "DELETE" });
}

export async function reloadSkills(): Promise<{ reloaded: boolean; skills: SkillInfo[] }> {
	return apiFetch<{ reloaded: boolean; skills: SkillInfo[] }>("/api/skills/reload", { method: "POST" });
}

export async function getSkillContent(name: string): Promise<{ name: string; content: string }> {
	return apiFetch<{ name: string; content: string }>(`/api/skills/${encodeURIComponent(name)}/content`);
}

export async function saveSkillContent(name: string, content: string): Promise<{ name: string; saved: boolean }> {
	return apiFetch<{ name: string; saved: boolean }>(`/api/skills/${encodeURIComponent(name)}/content`, {
		method: "PUT",
		body: JSON.stringify({ content }),
	});
}

export async function getSkillTree(name: string): Promise<{ name: string; children: WorkspaceTreeNode[] }> {
	return apiFetch<{ name: string; children: WorkspaceTreeNode[] }>(`/api/skills/${encodeURIComponent(name)}/tree`);
}

export async function getSkillFile(name: string, path: string): Promise<WorkspaceFileDetail> {
	return apiFetch<WorkspaceFileDetail>(`/api/skills/${encodeURIComponent(name)}/file?path=${encodeURIComponent(path)}`);
}

export async function saveSkillFile(name: string, path: string, content: string): Promise<{ path: string; saved: boolean }> {
	return apiFetch<{ path: string; saved: boolean }>(`/api/skills/${encodeURIComponent(name)}/file`, {
		method: "PUT",
		body: JSON.stringify({ path, content }),
	});
}

export function skillRawUrl(name: string, path: string): string {
	return `/api/skills/${encodeURIComponent(name)}/raw?path=${encodeURIComponent(path)}`;
}
