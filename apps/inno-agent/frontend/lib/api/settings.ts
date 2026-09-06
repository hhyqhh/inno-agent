import { apiGet, apiPut, apiPatch } from "./client";
import type { SafeSettings } from "./types";

export function getSettings(): Promise<SafeSettings> {
  return apiGet<SafeSettings>("/settings");
}

export function setDefaultModel(
  defaultModel: string,
): Promise<SafeSettings> {
  return apiPut<SafeSettings>("/settings/model", { defaultModel });
}

export function updateMemory(
  body: { l1Enabled?: boolean; l2Enabled?: boolean; l3Enabled?: boolean },
): Promise<SafeSettings> {
  return apiPut<SafeSettings>("/settings/memory", body);
}

export function updateTheme(theme: string): Promise<SafeSettings> {
  return apiPatch<SafeSettings>("/settings/theme", { theme });
}

export function toggleSimpleMode(
  enabled: boolean,
): Promise<SafeSettings> {
  return apiPut<SafeSettings>("/settings/simple-mode", { enabled });
}
