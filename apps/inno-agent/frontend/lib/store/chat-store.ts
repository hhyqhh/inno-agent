import { create } from "zustand";
import type {
  StreamEnvelope,
  Tool,
} from "@/lib/api/types";

interface PendingQuestion {
  questionId: string;
  params: unknown;
}

interface ChatState {
  turnId: string | null;
  streaming: boolean;
  queued: boolean;
  streamingText: string;
  streamingThinking: string;
  activeTools: Tool[];
  completedTools: Tool[];
  pendingQuestion: PendingQuestion | null;
  error: string | null;
  aborted: boolean;
  lastEventId: number;
  lastWorkspaceChange: string[];
  clientRequestId: string | null;
  /** The prompt currently being streamed (rendered as a transient user bubble). */
  prompt: string | null;

  /** SSE case-reducer: fold one envelope into the transient turn. */
  applyEvent: (env: StreamEnvelope) => void;
  startTurn: (turnId: string, clientRequestId: string, prompt?: string) => void;
  resetTurn: () => void;
}

const statusLabel: Tool["status"] = "pending";

function mergeTool(list: Tool[], tool: Tool): Tool[] {
  const idx = list.findIndex((t) => t.id === tool.id);
  if (idx === -1) return [...list, tool];
  const next = list.slice();
  next[idx] = { ...next[idx], ...tool };
  return next;
}

export const useChatStore = create<ChatState>((set, get) => ({
  turnId: null,
  streaming: false,
  queued: false,
  streamingText: "",
  streamingThinking: "",
  activeTools: [],
  completedTools: [],
  pendingQuestion: null,
  error: null,
  aborted: false,
  lastEventId: 0,
  lastWorkspaceChange: [],
  clientRequestId: null,
  prompt: null,

  startTurn: (turnId, clientRequestId, prompt = "") =>
    set({
      turnId,
      clientRequestId,
      prompt: prompt || null,
      streaming: true,
      queued: false,
      streamingText: "",
      streamingThinking: "",
      activeTools: [],
      completedTools: [],
      pendingQuestion: null,
      error: null,
      aborted: false,
      lastEventId: 0,
      lastWorkspaceChange: [],
    }),

  resetTurn: () =>
    set({
      turnId: null,
      streaming: false,
      queued: false,
      streamingText: "",
      streamingThinking: "",
      activeTools: [],
      completedTools: [],
      pendingQuestion: null,
      error: null,
      aborted: false,
      lastEventId: 0,
      lastWorkspaceChange: [],
      clientRequestId: null,
      prompt: null,
    }),

  applyEvent: (env) => {
    const { event, eventId } = env;
    if (eventId > get().lastEventId) set({ lastEventId: eventId });
    // Adopt the server's turnId once we see a frame that carries one.
    if (env.turnId && !get().turnId) set({ turnId: env.turnId });

    switch (event.type) {
      case "stream_state":
        set({ streaming: event.state === "running", queued: event.state === "queued" });
        break;
      case "text_start":
        set({ streaming: true });
        break;
      case "text_delta":
        set({ streamingText: get().streamingText + event.text });
        break;
      case "text_end":
        break;
      case "thinking_start":
        break;
      case "thinking_delta":
        set({ streamingThinking: get().streamingThinking + event.text });
        break;
      case "thinking_end":
        break;
      case "tool_call_start":
        set({
          activeTools: mergeTool(get().activeTools, {
            id: event.id,
            name: event.name,
            target: event.name,
            status: statusLabel,
          }),
        });
        break;
      case "tool_call_delta":
      case "tool_call_end":
        break;
      case "tool_start":
        set({
          activeTools: mergeTool(get().activeTools, {
            ...event.tool,
            status: event.tool.status ?? "running",
          }),
          completedTools: get().completedTools.filter(
            (t) => t.id !== event.tool.id,
          ),
        });
        break;
      case "tool_update":
        set({
          activeTools: mergeTool(get().activeTools, {
            ...event.tool,
            status: event.tool.status ?? "running",
          }),
        });
        break;
      case "tool_end": {
        const doneTool: Tool = { ...(event.tool ?? {}), status: event.tool?.status ?? "done" } as Tool;
        const id = doneTool.id;
        set({
          activeTools: get().activeTools.filter((t) => t.id !== id),
          completedTools: mergeTool(
            get().completedTools.filter((t) => t.id !== id),
            doneTool,
          ),
        });
        break;
      }
      case "workspace_change":
        set({ lastWorkspaceChange: event.files });
        break;
      case "question":
        set({ pendingQuestion: { questionId: event.questionId, params: event.params } });
        break;
      case "question_resolved":
        set({ pendingQuestion: null });
        break;
      case "done":
        set({ streaming: false, queued: false, aborted: false });
        break;
      case "error":
        set({ streaming: false, error: event.error, aborted: false });
        break;
      case "aborted":
        set({ streaming: false, aborted: true, queued: false });
        break;
      case "skill_loaded":
      case "skill_invoked":
      case "system_event":
        break;
      default:
        break;
    }
  },
}));
