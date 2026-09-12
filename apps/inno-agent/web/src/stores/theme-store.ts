import { EventEmitter } from "./event-emitter.js";

export type ThemeId = "light" | "dark";

export const THEME_IDS: ThemeId[] = ["light", "dark"];
const DARK_THEMES: Set<ThemeId> = new Set(["dark"]);
const STORAGE_KEY = "inno.theme";

/** Preview swatch colors for the theme picker UI. */
export const THEME_PREVIEW_COLORS: Record<ThemeId, string> = {
	light: "#f8fafd",
	dark: "#131415",
};

/** Retired themes (warm/ocean/innospark) migrate to light. */
const LEGACY_THEMES = new Set(["warm", "ocean", "innospark"]);

interface ThemeStoreEvents {
	change: void;
}

/**
 * Normalize any stored/remote value to a valid ThemeId. Legacy theme ids and
 * unknown values both fall back to "light" — this covers localStorage, the
 * backend-sync path in App.tsx, and hand-edited config.json files.
 */
export function normalizeThemeId(v: string | null | undefined): ThemeId {
	if (v === "dark") return "dark";
	if (v === "light") return "light";
	if (v && LEGACY_THEMES.has(v)) return "light";
	return "light";
}

function getInitialTheme(): ThemeId {
	return normalizeThemeId(localStorage.getItem(STORAGE_KEY));
}

function applyThemeToDOM(id: ThemeId): void {
	const html = document.documentElement;
	html.setAttribute("data-theme", id);
	if (DARK_THEMES.has(id)) {
		html.classList.add("dark");
	} else {
		html.classList.remove("dark");
	}
}

class ThemeStoreImpl extends EventEmitter<ThemeStoreEvents> {
	current: ThemeId = getInitialTheme();
	isSaving = false;

	/** Apply theme locally (DOM + localStorage) without persisting to backend. */
	apply(id: string): void {
		const next = normalizeThemeId(id);
		this.current = next;
		applyThemeToDOM(next);
		localStorage.setItem(STORAGE_KEY, next);
		this.emit("change", undefined);
	}

	/** Apply + persist to backend (best-effort). */
	async save(id: ThemeId): Promise<void> {
		this.apply(id);
		this.isSaving = true;
		this.emit("change", undefined);
		try {
			const { saveThemeSettings } = await import("../api/settings.js");
			await saveThemeSettings(id);
		} catch {
			// best-effort — localStorage is the real source of truth
		} finally {
			this.isSaving = false;
			this.emit("change", undefined);
		}
	}

	/** Returns true if the given theme is a dark variant. */
	isDark(id?: ThemeId): boolean {
		return DARK_THEMES.has(id ?? this.current);
	}
}

export const themeStore = new ThemeStoreImpl();

// Apply immediately on module load (before first render)
applyThemeToDOM(themeStore.current);
