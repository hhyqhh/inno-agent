import { listRemotePresets } from "../api/presets.js";
import type { PresetMeta } from "../types/presets.js";

const PRESET_CACHE_STORAGE_KEY = "inno.contentHub.preset-library.v2";
let memoryCache: PresetMeta[] | null = null;
let listRequest: Promise<PresetMeta[]> | null = null;

function isPresetMeta(value: unknown): value is PresetMeta {
	if (!value || typeof value !== "object") return false;
	const item = value as Record<string, unknown>;
	return typeof item.id === "string" && typeof item.name === "string" && typeof item.description === "string";
}

/** Read the last successful list so the Simple Mode cards can render instantly. */
export function readCachedPresets(): PresetMeta[] | null {
	if (memoryCache !== null) return memoryCache;
	if (typeof window === "undefined") return null;
	try {
		const raw = window.localStorage.getItem(PRESET_CACHE_STORAGE_KEY);
		if (!raw) return null;
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed) || !parsed.every(isPresetMeta)) return null;
		memoryCache = parsed;
		return memoryCache;
	} catch {
		return null;
	}
}

function writeCachedPresets(items: PresetMeta[]): void {
	memoryCache = items;
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(PRESET_CACHE_STORAGE_KEY, JSON.stringify(items));
	} catch {
		// A full or unavailable localStorage must not block the remote catalog.
	}
}

/** Remove a preset that the server confirmed is no longer published. */
export function removeCachedPreset(id: string): void {
	const cached = readCachedPresets();
	if (cached === null) return;
	writeCachedPresets(cached.filter((preset) => preset.id !== id));
}

/** Return cached data when available; only explicit refresh bypasses it. */
export async function fetchPresetList(forceRefresh: boolean): Promise<PresetMeta[]> {
	if (!forceRefresh) {
		const cached = readCachedPresets();
		if (cached !== null) return cached;
		if (listRequest) return listRequest;
	}
	const request = listRemotePresets(forceRefresh).then((items) => {
		writeCachedPresets(items);
		return items;
	});
	if (!forceRefresh) listRequest = request;
	try {
		return await request;
	} finally {
		if (!forceRefresh && listRequest === request) listRequest = null;
	}
}
