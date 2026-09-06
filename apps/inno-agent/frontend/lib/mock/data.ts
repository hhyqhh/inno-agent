/**
 * Mock fixtures aligned to docs/backend-api.md DTOs and mirroring the content
 * of prototype/*.png. Used when NEXT_PUBLIC_USE_MOCKS !== "0" so `next dev`
 * works with no backend and the UI matches the screenshots.
 */
import type {
  SessionSummary,
  SessionDetail,
  SessionMessageSummary,
  WorkspaceWithSessions,
  WorkspaceTreeNode,
  WorkspaceTreeResponse,
  WorkspaceFileDetail,
  SafeSettings,
  PublicStreamSnapshot,
  Tool,
  StreamEnvelope,
  ChatEvent,
} from "@/lib/api/types";

const now = Date.now();
const iso = (offsetMs: number) =>
  new Date(now - offsetMs).toISOString();

const wsId = "ws-xiaoshitanji";
const sessionId = "sess-xiaoshitanji";

// ---------------------------------------------------------------- sessions

export const MOCK_SESSIONS: SessionSummary[] = [
  {
    id: sessionId,
    name: "课件设计：柳宗元《小石潭记》",
    preview: "帮我为八年级下册《小石潭记》设计一节新课授课课件……",
    messageCount: 6,
    createdAt: iso(2 * 60 * 60 * 1000),
    updatedAt: iso(30 * 60 * 1000),
    channels: [],
    origin: "web",
    hasTopic: true,
    archived: false,
  },
  {
    id: "sess-dili-chanpin",
    name: "我是8年级地理教师，帮我…",
    preview: "了解一下当前知识库的内容",
    messageCount: 3,
    createdAt: iso(26 * 60 * 60 * 1000),
    updatedAt: iso(3 * 60 * 60 * 1000),
    channels: [],
    origin: "web",
    hasTopic: false,
    archived: false,
  },
  {
    id: "sess-wenyan-qingdan",
    name: "查看一下当前知识库的内容",
    preview: "我是8年级地理教师，帮我整理文言知识清单",
    messageCount: 2,
    createdAt: iso(50 * 60 * 60 * 1000),
    updatedAt: iso(8 * 60 * 60 * 1000),
    channels: [],
    origin: "web",
    hasTopic: false,
    archived: false,
  },
];

// -------------------------------------------------------------- workspaces

export const MOCK_WORKSPACES: WorkspaceWithSessions[] = [
  {
    id: wsId,
    name: "《小石潭记》备课工作区",
    relPath: "workspace/xiaoshitanji",
    createdAt: iso(2 * 60 * 60 * 1000),
    updatedAt: iso(30 * 60 * 1000),
    isTemp: false,
    sessionIds: [sessionId],
  },
  {
    id: "ws-temp-geo",
    name: "临时任务",
    relPath: "workspace/temp-geo",
    createdAt: iso(26 * 60 * 60 * 1000),
    updatedAt: iso(3 * 60 * 60 * 1000),
    isTemp: true,
    sessionIds: ["sess-dili-chanpin", "sess-wenyan-qingdan"],
  },
];

// -------------------------------------------------------------- file tree

export const MOCK_TREE: WorkspaceTreeResponse = {
  root: "workspace/xiaoshitanji",
  workspaceId: wsId,
  tree: {
    name: "《小石潭记》备课工作区",
    path: "",
    type: "directory",
    size: 186_000_000,
    updatedAt: iso(30 * 60 * 1000),
    children: [
      node("xianfa", "《小石潭记》新课授课课件.pptx", "file", 592_000, "ppt"),
      node("dili", "八年级地理《各地物产》分层练习题.docx", "file", 3_400_000, "doc"),
      node("wenyan", "文言知识清单.docx", "file", ones("184"), "doc"),
      node("huodong", "古诗朗诵活动单.docx", "file", ones("138"), "doc"),
      node("miaoxie", "景物描写素材.docx", "file", ones("206"), "doc"),
      node("favicon", "课件封面.png", "file", ones("82"), "image"),
      {
        name: "素材",
        path: "素材",
        type: "directory",
        size: ones("160"),
        updatedAt: iso(60 * 60 * 1000),
        children: [
          node("mt", "小石潭记·朗读音频.mp3", "file", ones("92")),
          node("img", "石潭实景图.jpg", "file", ones("68")),
        ],
      },
    ],
  },
};

function node(
  _id: string,
  name: string,
  type: "file" | "directory",
  size: number,
  ext = "",
): WorkspaceTreeNode {
  return {
    name,
    path: name,
    type,
    size,
    updatedAt: iso(30 * 60 * 1000),
    children: type === "directory" ? [] : undefined,
    ...(ext ? { mimeType: mimeFor(ext) } : {}),
  } as WorkspaceTreeNode & { mimeType?: string };
}

function mimeFor(ext: string): string {
  switch (ext) {
    case "ppt":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case "doc":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "xls":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case "image":
      return "image/png";
    default:
      return "application/octet-stream";
  }
}

function ones(label: string): number {
  return Number(label);
}

// ------------------------------------------------------------ file details

export function mockFileDetail(path: string): WorkspaceFileDetail {
  const name = path.split("/").pop() || path;
  const kind = kindOf(name);
  const isText = kind === "text" || kind === "markdown" || kind === "code";
  return {
    path,
    name,
    kind,
    mimeType: mimeForExt(name),
    size: 18_600,
    updatedAt: iso(30 * 60 * 1000),
    ...(isText
      ? { content: textContentFor(name) }
      : { url: `/mock/raw/${encodeURIComponent(path)}`, previewUrl: `/mock/raw/${encodeURIComponent(path)}` }),
  };
}

function kindOf(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "md":
      return "markdown";
    case "txt":
    case "csv":
      return "text";
    case "py":
    case "ts":
    case "tsx":
    case "js":
      return "code";
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "webp":
      return "image";
    case "pdf":
      return "pdf";
    case "docx":
      return "doc";
    case "xlsx":
      return "xls";
    case "pptx":
      return "ppt";
    case "html":
      return "html";
    default:
      return "file";
  }
}

function mimeForExt(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "md":
    case "txt":
      return "text/plain";
    case "csv":
      return "text/csv";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "pdf":
      return "application/pdf";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case "pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case "html":
      return "text/html";
    default:
      return "application/octet-stream";
  }
}

function textContentFor(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".md")) {
    return "# 《小石潭记》备课要点\n\n## 寓情于景\n\n柳宗元借小石潭的幽静景物，寄托自己被贬后孤寂、悲凉的心境。\n\n> 潭中鱼可百许头，皆若空游无所依。\n\n## 教学环节\n\n1. 导入\n2. 朗读\n3. 赏析\n4. 迁移\n";
  }
  return "这是一段示例文本内容（mock）。\n\n当前为 mock 模式，真实的后端会返回工作区文件内容。\n";
}

// ------------------------------------------------------------- messages

export const MOCK_MESSAGES: SessionMessageSummary[] = [
  {
    role: "user",
    content:
      "帮我为八年级下册《小石潭记》设计一节新课授课课件，文言文，重点突出「寓情于景」的写法。",
    timestamp: now - 40 * 60 * 1000,
    entryId: "e1",
    attachments: null,
  },
  {
    role: "assistant",
    content:
      "以下是一个简单的基于 PyTorch 的大型语言模型（LLM）代码示例，包含注意力机制和前馈网络的核心结构。这个示例展示了 LLM 的关键组件，适合学习基础原理：\n\n```python\n{\"field1\": \"value1\",\n \"field2\": \"value2\",\n \"nestedObject\": { \"subField1\": \"subValue1\",\n                    \"subField2\": 123 }\n}\n```\n",
    timestamp: now - 20 * 60 * 1000,
    entryId: "e2",
    thinking:
      "我来理解一下用户的意图。用户想要一节关于《小石潭记》的授课课件，重点是寓情于景的写法。我需要先浏览一下知识库和素材。",
    tools: [
      {
        id: "t1",
        name: "l3_recall",
        input: "小石潭记 教学素材",
        result: "121个搜索结果、1个列表",
        durationMs: 134_000,
        status: "done",
      },
      {
        id: "t2",
        name: "run_command",
        input: "git status -short",
        result: "已运行",
        durationMs: 1_200,
        status: "done",
      },
    ],
    attachments: null,
  },
  {
    role: "user",
    content:
      "第三部分的古诗朗诵活动，改成小组竞赛的形式，再配一张课堂活动单。",
    timestamp: now - 12 * 60 * 1000,
    entryId: "e3",
    attachments: null,
  },
  {
    role: "assistant",
    content:
      "已调整。第 12-14 页改为「朗读挑战赛」，小组抽签决定朗读段落，从字音、节奏、情感三个维度互评打分，课件内已加入评分表和计时器占位。配套的活动单也做好了，A4 单面可直接打印：\n",
    timestamp: now - 5 * 60 * 1000,
    entryId: "e4",
    tools: [
      {
        id: "t3",
        name: "edit_file",
        input: "《小石潭记》新课授课课件.pptx",
        result: "已更新 3 页",
        durationMs: 3_600,
        status: "done",
      },
    ],
    attachments: {
      bindings: [],
      loose: [
        {
          path: "《小石潭记》新课授课课件.pptx",
          kind: "ppt",
          source: "workspace",
        },
      ],
    },
  },
];

// A docx/pdf sample that also shows the right-panel 聊天记录 list.
export const MOCK_CHAT_RECORD_ATTACHMENTS = {
  bindings: [
    {
      word: "地理",
      wordIndex: 2,
      files: [
        {
          path: "八年级地理《各地物产》分层练习题.docx",
          kind: "doc",
          source: "workspace" as const,
        },
      ],
    },
    {
      word: "课件",
      wordIndex: 8,
      files: [
        {
          path: "《小石潭记》新课授课课件.pptx",
          kind: "ppt",
          source: "workspace" as const,
        },
      ],
    },
    {
      word: "清单",
      wordIndex: 1,
      files: [
        {
          path: "文言知识清单.docx",
          kind: "doc",
          source: "upload" as const,
        },
      ],
    },
  ],
  loose: [
    { path: "文言知识清单.docx", kind: "doc" as const, source: "upload" as const },
    { path: "古诗朗诵活动单.docx", kind: "doc" as const, source: "workspace" as const },
  ],
};

export const MOCK_SESSION_DETAIL: SessionDetail = {
  ...MOCK_SESSIONS[0],
  messages: MOCK_MESSAGES,
  sessionRevision: "rev-1",
  messageCount: MOCK_MESSAGES.length,
};

// -------------------------------------------------------------- status shot

export const MOCK_STREAM_STATUS: PublicStreamSnapshot = {
  sessionId,
  turnId: "turn-mock",
  clientRequestId: "req-mock",
  workspaceId: wsId,
  status: "completed",
  createdAt: iso(30 * 60 * 1000),
  startedAt: iso(29 * 60 * 1000),
  finishedAt: iso(28 * 60 * 1000),
  activeTools: [],
  completedTools: [
    {
      id: "t1",
      name: "l3_recall",
      target: "小石潭记",
      summary: "121个搜索结果",
      status: "done",
      durationMs: 134_000,
    },
  ] as Tool[],
  lastEventId: 40,
  cancelRequested: false,
  persisted: true,
};

// -------------------------------------------------------------- settings

export const MOCK_SETTINGS: SafeSettings = {
  defaultProvider: "innospark",
  defaultModel: "claude-sonnet-4-6",
  providers: {},
  configuredModels: [
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { id: "claude-opus-5", label: "Claude Opus 5" },
  ],
  availableModels: [
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { id: "claude-opus-5", label: "Claude Opus 5" },
  ],
  memory: { l1Enabled: true, l2Enabled: true, l3Enabled: true },
  simpleMode: { enabled: false },
  ui: { theme: "light" },
};

// ---------------------------------------------------------- stream events

/** A plausible streamed turn (matches the first assistant message). */
export function buildMockStream(
  _sessionId: string,
  _turnId: string,
  _clientRequestId: string,
): ChatEvent[] {
  return [
    { type: "stream_state", state: "running" },
    { type: "tool_start", tool: { id: "t1", name: "l3_recall", target: "小石潭记 教学素材", status: "running", startedAt: Date.now() } },
    { type: "tool_update", tool: { id: "t1", name: "l3_recall", target: "小石潭记 教学素材", summary: "121个搜索结果、1个列表", status: "running", durationMs: 134_000 } },
    { type: "tool_end", tool: { id: "t1", name: "l3_recall", summary: "121个搜索结果、1个列表", status: "done", durationMs: 134_000 } },
    { type: "tool_start", tool: { id: "t2", name: "run_command", detail: "git status -short", status: "running", startedAt: Date.now() } },
    { type: "tool_end", tool: { id: "t2", name: "run_command", detail: "git status -short", status: "done", durationMs: 1_200 } },
    { type: "thinking_start" },
    { type: "thinking_delta", text: "理解用户意图：一节关于《小石潭记》的新课课件，重点是寓情于景。" },
    { type: "thinking_end" },
    { type: "text_start" },
    { type: "text_delta", text: "以下是一个简单的基于 PyTorch 的大型语言模型（LLM）代码示例，包含注意力机制和前馈网络的核心结构。这个示例展示了 LLM 的关键组件，适合学习基础原理：" },
    { type: "text_delta", text: "\n\n```python\n" },
    { type: "text_delta", text: "{\"field1\": \"value1\",\n \"field2\": \"value2\",\n \"nestedObject\": { \"subField1\": \"subValue1\", \"subField2\": 123 }\n}\n" },
    { type: "text_delta", text: "```\n\n" },
    { type: "text_delta", text: "下一步建议什么？" },
    { type: "text_end" },
    { type: "done" },
  ];
}

export function toEnvelope(
  event: ChatEvent,
  seq: number,
  sessionId: string,
  turnId: string,
  clientRequestId: string,
): StreamEnvelope {
  return {
    eventId: seq,
    sessionId,
    turnId,
    clientRequestId,
    occurredAt: new Date().toISOString(),
    event,
  };
}

export const MOCK_SKILL_CARDS = [
  { id: "beike", title: "备课", desc: "课件生成、教学设计、试题命制一站完成" },
  { id: "xuexi", title: "学习", desc: "个性化学习路径、答疑伴学与难题拆解" },
  { id: "pingjia", title: "评价", desc: "学情诊断、课堂分析与评价量规设计" },
  { id: "keyan", title: "科研", desc: "文献检索、课题研究与知识体系分析" },
];
