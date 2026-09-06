import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface AuthUser {
  name: string;
}

interface AuthState {
  user: AuthUser | null;
  login: (name?: string) => void;
  logout: () => void;
}

/**
 * Pure frontend login (docs/frontend-rewrite-plan.md §4.1 / 附录). The backend
 * has no auth; the only "user" is the example persona 格格. Persisted to
 * localStorage so it survives refresh.
 */
export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      login: (name = "格格") => set({ user: { name } }),
      logout: () => set({ user: null }),
    }),
    { name: "inno.auth", partialize: (s) => ({ user: s.user }) },
  ),
);
