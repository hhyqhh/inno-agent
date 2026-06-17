import { apiFetch } from "./client.js";
import type { InnoSettings, UpsertProviderRequest, ChannelsSettingsPayload } from "../types/settings.js";

export async function getSettings(): Promise<InnoSettings> {
	return apiFetch<InnoSettings>("/api/settings");
}

export async function switchBackendModel(provider: string, model: string): Promise<Pick<InnoSettings, "defaultProvider" | "defaultModel">> {
	return apiFetch<Pick<InnoSettings, "defaultProvider" | "defaultModel">>("/api/settings/model", {
		method: "POST",
		body: JSON.stringify({ provider, model }),
	});
}

export async function upsertProvider(payload: UpsertProviderRequest): Promise<InnoSettings> {
	return apiFetch<InnoSettings>("/api/settings/providers", {
		method: "PUT",
		body: JSON.stringify(payload),
	});
}

export async function deleteProviderApi(providerId: string): Promise<InnoSettings> {
	return apiFetch<InnoSettings>(`/api/settings/providers/${encodeURIComponent(providerId)}`, {
		method: "DELETE",
	});
}

export async function saveChannelsSettings(payload: ChannelsSettingsPayload): Promise<InnoSettings> {
	return apiFetch<InnoSettings>("/api/settings/channels", {
		method: "PUT",
		body: JSON.stringify(payload),
	});
}

export interface MemorySettingsPatch {
	l1Enabled?: boolean;
	l2Enabled?: boolean;
	l3Enabled?: boolean;
}

export async function saveMemorySettings(patch: MemorySettingsPatch): Promise<InnoSettings> {
	return apiFetch<InnoSettings>("/api/settings/memory", {
		method: "PUT",
		body: JSON.stringify(patch),
	});
}

export async function saveGithubSettings(token: string): Promise<InnoSettings> {
	return apiFetch<InnoSettings>("/api/settings/github", {
		method: "PUT",
		body: JSON.stringify({ token }),
	});
}

export async function wechatQrLogin(): Promise<{ qrId: string; qrUrl: string }> {
	return apiFetch<{ qrId: string; qrUrl: string }>("/api/channels/wechat/qr-login", {
		method: "POST",
	});
}

export async function wechatQrStatus(qrId: string): Promise<{ status: string; botId?: string }> {
	return apiFetch<{ status: string; botId?: string }>(`/api/channels/wechat/qr-status?qrId=${encodeURIComponent(qrId)}`);
}

export async function wechatStatus(): Promise<{ configured: boolean; connected: boolean; botId?: string; loggedIn?: boolean }> {
	return apiFetch<{ configured: boolean; connected: boolean; botId?: string; loggedIn?: boolean }>("/api/channels/wechat/status");
}
