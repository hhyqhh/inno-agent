import { create } from "zustand";
import { listSessions, listWorkspaces, createSession as apiCreateSession } from "@/lib/api";
import type { SessionSummary, WorkspaceWithSessions } from "@/lib/api/types";

interface SessionsState {
  sessions: SessionSummary[];
  workspaces: WorkspaceWithSessions[];
  activeSessionId: string | null;
  activeWorkspaceId: string | null;
  loading: boolean;
  creating: boolean;
  error: string | null;
  load: () => Promise<void>;
  refresh: () => Promise<void>;
  setActiveSession: (sessionId: string | null, workspaceId?: string | null) => void;
  createSession: (body: {
    workspaceId?: string;
    newWorkspace?: { name?: string; isTemp?: boolean };
  }) => Promise<{ id: string; workspaceId: string }>;
}

export const useSessionsStore = create<SessionsState>((set, get) => ({
  sessions: [],
  workspaces: [],
  activeSessionId: null,
  activeWorkspaceId: null,
  loading: false,
  creating: false,
  error: null,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const [sessions, workspaces] = await Promise.all([
        listSessions(),
        listWorkspaces(),
      ]);
      set({ sessions, workspaces, loading: false });
    } catch (e) {
      set({ error: (e as Error).message, loading: false });
    }
  },

  refresh: async () => {
    try {
      const [sessions, workspaces] = await Promise.all([
        listSessions(),
        listWorkspaces(),
      ]);
      set({ sessions, workspaces });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  setActiveSession: (sessionId, workspaceId = null) =>
    set({ activeSessionId: sessionId, activeWorkspaceId: workspaceId }),

  createSession: async (body) => {
    if (get().creating) {
      // Guard: only fire once per gesture (the UI should retry on 409).
      throw new Error("正在创建会话");
    }
    set({ creating: true });
    try {
      const res = await apiCreateSession(body);
      await get().refresh();
      return res;
    } finally {
      set({ creating: false });
    }
  },
}));
