import { apiFetch } from "./client.js";
import type { RunRecord, TerminalSessionInfo } from "../types/terminal.js";

export async function createTerminalSession(input: {
	sessionId: string;
	workspaceId?: string;
	cols?: number;
	rows?: number;
}): Promise<TerminalSessionInfo> {
	return apiFetch<TerminalSessionInfo>("/api/terminal/sessions", {
		method: "POST",
		body: JSON.stringify(input),
	});
}

export async function closeTerminalSession(id: string): Promise<void> {
	await apiFetch(`/api/terminal/sessions/${encodeURIComponent(id)}/close`, { method: "POST" });
}

export function terminalWsUrl(id: string): string {
	const proto = location.protocol === "https:" ? "wss:" : "ws:";
	return `${proto}//${location.host}/api/terminal/sessions/${encodeURIComponent(id)}/ws`;
}

export async function listRuns(sessionId: string, limit = 20): Promise<RunRecord[]> {
	return apiFetch<RunRecord[]>(`/api/runs?sessionId=${encodeURIComponent(sessionId)}&limit=${limit}`);
}

export async function getRun(runId: string, lines = 200): Promise<RunRecord> {
	return apiFetch<RunRecord>(`/api/runs/${encodeURIComponent(runId)}?lines=${lines}`);
}

export interface ArchiveRunResult {
	path: string;
	title: string;
	runId: string;
}

export async function archiveRun(runId: string, input: { title?: string; note?: string } = {}): Promise<ArchiveRunResult> {
	return apiFetch<ArchiveRunResult>(`/api/runs/${encodeURIComponent(runId)}/archive`, {
		method: "POST",
		body: JSON.stringify(input),
	});
}
