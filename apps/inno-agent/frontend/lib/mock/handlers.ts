/**
 * In-memory mock backend router (docs/frontend-rewrite-plan.md §3.1).
 * `mockHandle(path, init)` maps a method+path to a fixture from data.ts so
 * the SPA works with `NEXT_PUBLIC_USE_MOCKS !== "0"` and no real backend.
 */
import { ApiError } from "@/lib/api/client";
import {
  MOCK_SESSIONS,
  MOCK_WORKSPACES,
  MOCK_TREE,
  MOCK_SESSION_DETAIL,
  MOCK_STREAM_STATUS,
  MOCK_SETTINGS,
  mockFileDetail,
} from "./data";
import type {
  SessionSummary,
  WorkspaceWithSessions,
  SafeSettings,
} from "@/lib/api/types";

interface Parsed {
  method: string;
  pathname: string;
  query: URLSearchParams;
  body: Record<string, unknown>;
}

function parse(path: string, init: RequestInit): Parsed {
  const method = (init.method || "GET").toUpperCase();
  const url = new URL(path, "http://mock.local");
  let body: Record<string, unknown> = {};
  if (init.body && typeof init.body === "string") {
    try {
      body = JSON.parse(init.body) as Record<string, unknown>;
    } catch {
      body = {};
    }
  }
  return { method, pathname: url.pathname, query: url.searchParams, body };
}

let created: number = 0;

/** Typical latency so loading states are visible but not annoying. */
const delay = (ms = 120) => new Promise((r) => setTimeout(r, ms));

export async function mockHandle(
  path: string,
  init: RequestInit,
): Promise<unknown> {
  await delay();
  const { method, pathname, query, body } = parse(path, init);

  // Sessions -------------------------------------------------------------
  if (method === "GET" && pathname === "/sessions") {
    return MOCK_SESSIONS as SessionSummary[];
  }

  if (method === "POST" && pathname === "/sessions") {
    const newWorkspace = (body.newWorkspace as { name?: string } | undefined) ?? {};
    const workspaceId = (body.workspaceId as string) || `ws-${++created}`;
    const id = `sess-${++created}`;
    // Register the created session so a later GET /sessions (refresh) shows it —
    // otherwise the sidebar/topbar fall back to a generic name.
    MOCK_SESSIONS.unshift({
      id,
      name: newWorkspace.name || "新的教育任务",
      preview: "开始新的教学任务",
      messageCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      channels: [],
      origin: "web",
      hasTopic: false,
      archived: false,
    });
    return { id, active: true, workspaceId };
  }

  const sessionMatch = pathname.match(/^\/sessions\/([^/]+)$/);
  if (method === "GET" && sessionMatch) {
    return { ...MOCK_SESSION_DETAIL, id: decodeURIComponent(sessionMatch[1]) };
  }

  // Workspaces ------------------------------------------------------------
  if (method === "GET" && pathname === "/workspaces") {
    return MOCK_WORKSPACES as WorkspaceWithSessions[];
  }

  if (method === "POST" && pathname === "/workspaces") {
    const name = (body.name as string) || "新工作区";
    return {
      id: `ws-${++created}`,
      name,
      relPath: `workspace/${name}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      isTemp: Boolean(body.isTemp),
    };
  }

  // Workspace files -------------------------------------------------------
  if (method === "GET" && pathname === "/workspace/tree") {
    return MOCK_TREE;
  }

  if (method === "GET" && pathname === "/workspace/file") {
    return mockFileDetail((query.get("path") as string) || "sample.md");
  }

  if (method === "GET" && pathname === "/workspace/office-preview") {
    const path = (query.get("path") as string) || "";
    const name = decodeURIComponent(path.split("/").pop() || "");
    return {
      name,
      pageCount: 2,
      text:
        "柳宗元借小石潭的幽静景物，寄托自己被贬后孤寂、悲凉的心境。潭中鱼可百许头，皆若空游无所依。",
      pages: [
        { index: 1, text: "第一页：从小丘西行百二十步……" },
        { index: 2, text: "第二页：潭中鱼可百许头……" },
      ],
    };
  }

  if (method === "GET" && pathname === "/workspace/pptx-preview") {
    return {
      name: "《小石潭记》新课授课课件",
      slideCount: 14,
      canvasPx: [960, 540],
      slides: Array.from({ length: 14 }, (_, i) => ({
        index: i + 1,
        svg: `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><rect width="960" height="540" fill="white"/><text x="40" y="80" font-size="28" fill="#333">第 ${i + 1} 页 · 小石潭记</text><rect x="40" y="120" width="880" height="340" rx="12" fill="#f3f0ff"/><text x="60" y="170" font-size="18" fill="#5b21b6">示例幻灯片内容（mock）</text></svg>`,
      })),
    };
  }

  if (method === "POST" && pathname === "/workspace/upload") {
    return { uploaded: [] };
  }

  // Chat -----------------------------------------------------------------
  if (method === "GET" && pathname.startsWith("/chat/status/")) {
    const sessId = pathname.split("/").pop();
    return { found: true, stream: { ...MOCK_STREAM_STATUS, sessionId: sessId } };
  }

  if (method === "POST" && pathname.includes("/abort")) {
    return { status: "aborted", cancelRequested: true };
  }

  // Settings and misc -----------------------------------------------------
  if (method === "GET" && pathname === "/settings") {
    return MOCK_SETTINGS as SafeSettings;
  }

  if (method === "PUT" && pathname === "/settings/memory") {
    return { ...MOCK_SETTINGS, memory: body };
  }

  if (method === "PATCH" && pathname === "/settings/theme") {
    return { ...MOCK_SETTINGS, ui: { ...MOCK_SETTINGS.ui, theme: body.theme } };
  }

  if (method === "GET" && pathname === "/skills") return [];
  if (method === "GET" && pathname === "/skill-library") return [];
  if (method === "GET" && pathname === "/presets") return [];
  if (method === "GET" && pathname === "/learner/profile") {
    return { name: "格格", _rev: "mock-rev-1" };
  }

  throw new ApiError(`mock: 未实现的接口 ${method} ${pathname}`, 404);
}
