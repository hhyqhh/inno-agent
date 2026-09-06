/**
 * DTO shapes aligned to docs/backend-api.md (the backend is apps/inno-agent/src,
 * HTTP on :3000, prefix /api). The frontend never imports backend code — these
 * are the wire contracts the two sides agree on.
 */

// ---------------------------------------------------------------- sessions

export interface SessionSummary {
  id: string;
  name: string;
  preview: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  channels: string[];
  origin: string;
  hasTopic: boolean;
  archived: boolean;
}

export interface SessionDetail extends SessionSummary {
  messages: SessionMessageSummary[];
  messageCount: number;
  sessionRevision: string;
  pendingQuestion?: PersistedQuestion | null;
}

export interface SessionMessageSummary {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  entryId: string;
  parentEntryId?: string | null;
  thinking?: string;
  tools?: ToolCall[];
  channel?: string;
  images?: ImageRef[];
  attachments?: ChatAttachments | null;
}

export interface ToolCall {
  id: string;
  name: string;
  input?: string;
  output?: string;
  result?: string;
  error?: string | null;
  durationMs?: number;
  status?: "running" | "done" | "error" | "waiting";
}

export interface ImageRef {
  path: string;
  url?: string;
  mediaType?: string;
}

export interface ChatAttachments {
  bindings: AttachmentBinding[];
  loose: AttachmentRef[];
}

export interface AttachmentBinding {
  word: string;
  wordIndex: number;
  files: AttachmentRef[];
}

export interface AttachmentRef {
  path: string;
  kind: "pdf" | "doc" | "xls" | "ppt" | "image" | "file";
  source: "workspace" | "upload";
}

export interface PersistedQuestion {
  questionId: string;
  sessionId: string;
  turnId: string;
  params: unknown;
  createdAt: string;
}

export interface QuestionBridgeResult {
  answers: Answer[];
  cancelled: boolean;
  error?: string;
}

export interface Answer {
  id: string;
  value: string;
}

// ------------------------------------------------------------- workspaces

export interface WorkspaceTreeNode {
  name: string;
  path: string;
  type: "file" | "directory";
  size: number;
  updatedAt: string;
  children?: WorkspaceTreeNode[];
}

export interface WorkspaceMeta {
  id: string;
  name: string;
  relPath: string;
  createdAt: string;
  updatedAt: string;
  isTemp: boolean;
}

export interface WorkspaceWithSessions extends WorkspaceMeta {
  sessionIds: string[];
}

export interface WorkspaceFileDetail {
  path: string;
  name: string;
  kind: string;
  format?: string;
  mimeType: string;
  size: number;
  updatedAt: string;
  content?: string;
  url?: string;
  previewUrl?: string;
}

export interface WorkspaceTreeResponse {
  root: string;
  workspaceId: string;
  tree: WorkspaceTreeNode;
}

export interface OfficePreview {
  name: string;
  pageCount?: number;
  text: string;
  pages?: { index: number; text: string }[];
}

export interface PptxPreview {
  name: string;
  slideCount: number;
  slides: { index: number; svg: string }[];
  canvasPx?: [number, number];
}

// ---------------------------------------------------------------- settings

export interface RuntimeModel {
  id: string;
  label?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  description?: string;
}

export interface ProjectSkill {
  name: string;
  description: string;
  category?: string;
  enabled: boolean;
  loaded: boolean;
  filePath: string;
  size: number;
  updatedAt: string;
  diagnostics?: string[];
}

export interface SafeSettings {
  defaultProvider: string;
  defaultModel: string;
  providers: Record<string, unknown>;
  configuredModels: RuntimeModel[];
  availableModels: RuntimeModel[];
  server?: { port?: number };
  memory?: { l1Enabled?: boolean; l2Enabled?: boolean; l3Enabled?: boolean };
  simpleMode?: { enabled?: boolean };
  ui?: { theme?: string };
  [key: string]: unknown;
}

// ------------------------------------------------------------------- chat

export type StreamStatus =
  | "queued"
  | "running"
  | "completed"
  | "error"
  | "aborted";

export interface Tool {
  id: string;
  name: string;
  target?: string;
  summary?: string;
  detail?: string;
  status: "pending" | "running" | "waiting" | "failed" | "done";
  durationMs?: number;
  startedAt?: number;
}

export interface PublicStreamSnapshot {
  sessionId: string;
  turnId: string;
  clientRequestId: string;
  workspaceId: string;
  status: StreamStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  inputSnapshot?: unknown;
  activeTools?: Tool[];
  completedTools?: Tool[];
  pendingQuestion?: unknown;
  lastEventId: number;
  cancelRequested: boolean;
  terminalReason?: string;
  persisted?: boolean;
  finalMessageCount?: number;
  finalSessionRevision?: string;
}

export interface StreamStatusResponse {
  found: boolean;
  stream?: PublicStreamSnapshot;
}

// The SSE frame is an envelope; `event` is a discriminated union on `type`.
export interface StreamEnvelope<
  E extends ChatEvent = ChatEvent
> {
  eventId: number;
  sessionId: string;
  turnId: string;
  clientRequestId: string;
  traceId?: string;
  occurredAt?: string;
  event: E;
}

export type ChatEvent =
  | { type: "stream_state"; state: "queued" | "running" }
  | { type: "text_start" }
  | { type: "text_delta"; text: string }
  | { type: "text_end"; text?: string }
  | { type: "thinking_start" }
  | { type: "thinking_delta"; text: string }
  | { type: "thinking_end"; text?: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; text?: string }
  | { type: "tool_call_end"; id: string }
  | { type: "tool_start"; tool: Tool }
  | { type: "tool_update"; tool: Tool }
  | { type: "tool_end"; tool?: Tool }
  | { type: "workspace_change"; files: string[] }
  | { type: "question"; questionId: string; params: unknown }
  | { type: "question_resolved"; questionId: string }
  | { type: "done"; sessionRevision?: string }
  | { type: "error"; error: string }
  | { type: "aborted" }
  | { type: "skill_loaded"; skill: string }
  | { type: "skill_invoked"; skill: string }
  | { type: "system_event"; message: string };
