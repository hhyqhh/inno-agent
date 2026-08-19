import { apiFetch } from "./client.js";
import type { PresetMeta } from "../types/presets.js";

/** Live preset catalog from the remote content hub (Simple Mode cards). */
export async function listRemotePresets(forceRefresh = false): Promise<PresetMeta[]> {
	return apiFetch<PresetMeta[]>(`/api/preset-library${forceRefresh ? "?refresh=1" : ""}`);
}
