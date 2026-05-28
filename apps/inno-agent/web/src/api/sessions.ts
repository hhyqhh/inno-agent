import { apiFetch } from "./client.js";
import type { ChatMessage } from "../types/chat.js";

export type SessionChannel = "cli" | "web" | "feishu" | "qq" | "wechat" | "scheduler" | "unknown";

export interface SessionMeta {
	id: string;
	name: string;
	createdAt: string;
	updatedAt: string;
	messageCount: number;
	preview: string;
	channels: SessionChannel[];
	archived?: boolean;
}

export interface SessionDetail extends SessionMeta {
	messages: ChatMessage[];
}

export interface SessionActivationResult {
	id: string;
	active: boolean;
}

export interface NewSessionResult {
	id: string;
	active: boolean;
	workspaceId?: string;
}

export interface CreateSessionInput {
	workspaceId?: string;
	newWorkspace?: {
		name?: string;
		isTemp?: boolean;
	};
}

export async function listSessions(): Promise<SessionMeta[]> {
	return apiFetch<SessionMeta[]>("/api/sessions");
}

export async function getSession(id: string): Promise<SessionDetail> {
	return apiFetch<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}`);
}

export async function activateSession(id: string): Promise<SessionActivationResult> {
	return apiFetch<SessionActivationResult>(`/api/sessions/${encodeURIComponent(id)}/activate`, {
		method: "POST",
	});
}

export async function createSession(input: CreateSessionInput = {}): Promise<NewSessionResult> {
	return apiFetch<NewSessionResult>("/api/sessions", {
		method: "POST",
		body: JSON.stringify(input),
	});
}

export async function updateSessionName(id: string, name: string, generated = false): Promise<SessionMeta> {
	return apiFetch<SessionMeta>(`/api/sessions/${encodeURIComponent(id)}`, {
		method: "PATCH",
		body: JSON.stringify({ name, generated }),
	});
}

export async function generateSessionName(id: string): Promise<SessionMeta> {
	return apiFetch<SessionMeta>(`/api/sessions/${encodeURIComponent(id)}/generate-topic`, {
		method: "POST",
	});
}

export interface DeleteSessionResult {
	id: string;
	deleted: boolean;
	newActiveId: string | null;
}

export async function deleteSession(id: string): Promise<DeleteSessionResult> {
	return apiFetch<DeleteSessionResult>(`/api/sessions/${encodeURIComponent(id)}`, {
		method: "DELETE",
	});
}

export async function archiveSession(id: string): Promise<{ id: string; archived: boolean }> {
	return apiFetch<{ id: string; archived: boolean }>(`/api/sessions/${encodeURIComponent(id)}/archive`, {
		method: "POST",
	});
}

export async function unarchiveSession(id: string): Promise<{ id: string; archived: boolean }> {
	return apiFetch<{ id: string; archived: boolean }>(`/api/sessions/${encodeURIComponent(id)}/unarchive`, {
		method: "POST",
	});
}
