import { apiGet, apiPost } from "./client";

// Preset metadata is loosely typed (see backend-api.md PresetMeta).
export interface PresetMeta {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  category?: string;
}

export function listPresets(): Promise<PresetMeta[]> {
  return apiGet<PresetMeta[]>("/presets");
}

export function openPreset(id: string): Promise<{ id: string; workspaceId: string }> {
  return apiPost<{ id: string; workspaceId: string }>(`/presets/${id}/open`);
}
