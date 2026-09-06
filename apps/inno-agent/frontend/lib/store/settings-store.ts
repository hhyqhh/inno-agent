import { create } from "zustand";
import { getSettings } from "@/lib/api/settings";
import type { SafeSettings } from "@/lib/api/types";
import { useThemeStore } from "./theme-store";

interface SettingsState {
  settings: SafeSettings | null;
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
  setModel: (provider: string, model: string) => void;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: null,
  loading: false,
  error: null,
  load: async () => {
    if (get().settings) return;
    set({ loading: true, error: null });
    try {
      const settings = await getSettings();
      set({ settings, loading: false });
      const theme = settings.ui?.theme;
      if (theme === "dark" || theme === "light") {
        useThemeStore.getState().setTheme(theme);
      }
    } catch (e) {
      set({ error: (e as Error).message, loading: false });
    }
  },
  setModel: (provider, model) => {
    const settings = get().settings;
    if (!settings) return;
    set({
      settings: { ...settings, defaultProvider: provider, defaultModel: model },
    });
  },
}));
