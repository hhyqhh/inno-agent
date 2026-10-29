import { EventEmitter } from "./event-emitter.js";
import { saveThemeSettings } from "../api/settings.js";

export type ThemeId = "light" | "dark";
export type ThemePreference = ThemeId | "system";
export const THEME_IDS: ThemeId[] = ["light", "dark"];
const STORAGE_KEY = "inno.theme";

/** Preview swatch colors for the theme picker UI. */
export const THEME_PREVIEW_COLORS: Record<ThemeId, string> = {
	light: "#f8fafd",
	dark: "#171717",
};

interface ThemeStoreEvents {
	change: void;
}

/** Retired and unknown theme preferences keep the existing light fallback. */
export function normalizeThemeId(value: string | null | undefined): ThemePreference {
	return value === "dark" || value === "system" ? value : "light";
}

const systemTheme = window.matchMedia?.("(prefers-color-scheme: dark)");
function resolveTheme(preference: ThemePreference): ThemeId {
	return preference === "system" ? (systemTheme?.matches ? "dark" : "light") : preference;
}

function applyThemeToDOM(id: ThemeId): void {
	const html = document.documentElement;
	html.setAttribute("data-theme", id);
	html.classList.toggle("dark", id === "dark");
	html.style.colorScheme = id;
}

class ThemeStoreImpl extends EventEmitter<ThemeStoreEvents> {
	// Keep the saved preference separate from the effective two-color theme:
	// editors/terminals still receive light or dark, never a third palette.
	preference: ThemePreference = normalizeThemeId(localStorage.getItem(STORAGE_KEY));
	current: ThemeId = resolveTheme(this.preference);
	isSaving = false;

	private applyResolved(id: ThemeId): void {
		this.current = id;
		applyThemeToDOM(id);
		this.emit("change", undefined);
	}

	/** One owner applies the preference to web content and native chrome. */
	apply(id: string): void {
		const next = normalizeThemeId(id);
		this.preference = next;
		localStorage.setItem(STORAGE_KEY, next);
		this.applyResolved(resolveTheme(next));
		// macOS otherwise keeps its system-dark frame around a light renderer.
		// Returning to system can change matchMedia only after the native override
		// is removed; use the IPC result for the initial resolved appearance too.
		void window.innoDesktop?.setThemePreference?.(next).then((resolved) => {
			if (this.preference === next && (resolved === "light" || resolved === "dark")) this.applyResolved(resolved);
		}).catch(() => undefined);
	}

	refreshSystemTheme(): void {
		if (this.preference === "system") this.applyResolved(resolveTheme("system"));
	}

	/** Apply + persist through the existing theme settings endpoint. */
	async save(id: ThemePreference): Promise<void> {
		this.apply(id);
		this.isSaving = true;
		this.emit("change", undefined);
		try {
			await saveThemeSettings(id);
		} catch {
			// best-effort — localStorage is the real source of truth
		} finally {
			this.isSaving = false;
			this.emit("change", undefined);
		}
	}

	isDark(id: ThemeId = this.current): boolean {
		return id === "dark";
	}
}

export const themeStore = new ThemeStoreImpl();
systemTheme?.addEventListener("change", () => themeStore.refreshSystemTheme());
// The main and search windows share one preference without separate writers.
window.addEventListener("storage", (event) => {
	if (event.key === STORAGE_KEY) themeStore.apply(event.newValue ?? "light");
});
// Apply before first React render, including native window appearance.
themeStore.apply(themeStore.preference);
