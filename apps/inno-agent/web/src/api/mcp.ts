import { apiFetch } from "./client.js";
import type { McpOverview, McpServerEntry } from "../types/mcp.js";

export async function getMcpOverview(): Promise<McpOverview> {
	return apiFetch<McpOverview>("/api/mcp");
}

export async function upsertMcpServer(name: string, entry: McpServerEntry): Promise<McpOverview> {
	return apiFetch<McpOverview>(`/api/mcp/servers/${encodeURIComponent(name)}`, {
		method: "PUT",
		body: JSON.stringify(entry),
	});
}

export async function setMcpServerDisabled(name: string, disabled: boolean): Promise<McpOverview> {
	return apiFetch<McpOverview>(`/api/mcp/servers/${encodeURIComponent(name)}`, {
		method: "PATCH",
		body: JSON.stringify({ disabled }),
	});
}

export async function deleteMcpServer(name: string): Promise<McpOverview> {
	return apiFetch<McpOverview>(`/api/mcp/servers/${encodeURIComponent(name)}`, {
		method: "DELETE",
	});
}
