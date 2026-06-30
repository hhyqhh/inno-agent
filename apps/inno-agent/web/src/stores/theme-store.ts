import { EventEmitter } from "./event-emitter.js";

export type ThemeId = "innospark";

export const THEME_IDS: ThemeId[] = ["innospark"];
const DARK_THEMES: Set<ThemeId> = new Set();
const STORAGE_KEY = "inno.theme";

/** Preview swatch colors for the theme picker UI. */
export const THEME_PREVIEW_COLORS: Record<ThemeId, string> = {
	innospark: "#555aff",
};

interface ThemeStoreEvents {
	change: void;
}

function isValidTheme(v: string | null): v is ThemeId {
	return v !== null && THEME_IDS.includes(v as ThemeId);
}

function getInitialTheme(): ThemeId {
	const saved = localStorage.getItem(STORAGE_KEY);
	if (isValidTheme(saved)) return saved;
	return "innospark";
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
	apply(id: ThemeId): void {
		if (!isValidTheme(id)) return;
		this.current = id;
		applyThemeToDOM(id);
		localStorage.setItem(STORAGE_KEY, id);
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
