import { create } from "zustand";
import {
  getSession,
  getWorkspaceTree,
} from "@/lib/api";
import type {
  SessionMessageSummary,
  WorkspaceTreeNode,
  PersistedQuestion,
} from "@/lib/api/types";
import { useSessionsStore } from "./sessions-store";

interface WorkspaceState {
  workspaceId: string | null;
  workspaceName: string;
  rootPath: string;
  tree: WorkspaceTreeNode | null;
  messages: SessionMessageSummary[];
  sessionRevision: string;
  pendingQuestion: PersistedQuestion | null;
  selectedPath: string | null;
  loading: boolean;
  error: string | null;
  openSession: (sessionId: string | null, workspaceId?: string | null) => Promise<void>;
  refreshMessages: (sessionId: string) => Promise<void>;
  loadTree: (workspaceId: string) => Promise<void>;
  setSelectedPath: (path: string | null) => void;
  /** Recursive sum of `children[].size` — root size is directory metadata, not a total. */
  workspaceSize: () => number;
  reset: () => void;
}

/** Recursive total of every file node's size under `node`. */
function sumTree(node: WorkspaceTreeNode | null): number {
  if (!node) return 0;
  if (node.type === "directory") {
    return (node.children ?? []).reduce((acc, c) => acc + sumTree(c), 0);
  }
  return node.size;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaceId: null,
  workspaceName: "",
  rootPath: "",
  tree: null,
  messages: [],
  sessionRevision: "",
  pendingQuestion: null,
  selectedPath: null,
  loading: false,
  error: null,

  openSession: async (sessionId, workspaceId = null) => {
    set({ loading: true, error: null });

    // Resolve the workspace the session lives in. For a freshly created
    // session the caller passes `workspaceId`; for an existing session we
    // reverse-lookup it from the workspaces registry.
    let wsId = workspaceId;
    if (!wsId && sessionId) {
      // A refresh / deep-link mounts /workspace without going through the home
      // screen, so the sessions+workspaces registry may not be loaded yet.
      // Ensure it is before reverse-looking-up the workspace this session is in.
      const state = useSessionsStore.getState();
      if (state.workspaces.length === 0) await state.load();
      const { workspaces } = useSessionsStore.getState();
      const ws = workspaces.find((w) => w.sessionIds.includes(sessionId));
      wsId = ws?.id ?? null;
    }

    try {
      const [detail, treeRes] = await Promise.all([
        sessionId ? getSession(sessionId) : Promise.resolve(null),
        wsId ? getWorkspaceTree(wsId) : Promise.resolve(null),
      ]);

      set({
        workspaceId: wsId,
        messages: detail?.messages ?? [],
        sessionRevision: detail?.sessionRevision ?? "",
        pendingQuestion: detail?.pendingQuestion ?? null,
        tree: treeRes?.tree ?? null,
        rootPath: treeRes?.root ?? "",
        loading: false,
      });
      // Workspace display name from the registry, else from tree root.
      const { workspaces } = useSessionsStore.getState();
      const ws = workspaces.find((w) => w.id === wsId);
      set({ workspaceName: ws?.name ?? treeRes?.tree?.name ?? "" });
    } catch (e) {
      set({ error: (e as Error).message, loading: false });
    }
  },

  refreshMessages: async (sessionId) => {
    try {
      const detail = await getSession(sessionId);
      set({
        messages: detail.messages,
        sessionRevision: detail.sessionRevision,
        pendingQuestion: detail.pendingQuestion ?? null,
      });
    } catch {
      /* leave existing messages */
    }
  },

  loadTree: async (workspaceId) => {
    try {
      const treeRes = await getWorkspaceTree(workspaceId);
      set({ tree: treeRes.tree, rootPath: treeRes.root, workspaceId });
    } catch {
      /* ignore */
    }
  },

  setSelectedPath: (path) => set({ selectedPath: path }),

  workspaceSize: () => sumTree(get().tree),

  reset: () =>
    set({
      workspaceId: null,
      workspaceName: "",
      rootPath: "",
      tree: null,
      messages: [],
      sessionRevision: "",
      pendingQuestion: null,
      selectedPath: null,
      error: null,
    }),
}));
