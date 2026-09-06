/**
 * Uniform backend client (docs/frontend-rewrite-plan.md §3.1).
 *
 * - `apiFetch`/`apiGet`/`apiPost`/... route through lib/mock/* when
 *   NEXT_PUBLIC_USE_MOCKS !== "0" (default), else hit the real backend
 *   resolved by lib/api/config.ts.
 * - `buildUrl` produces an absolute URL (img/iframe/download hrefs).
 * - `openStream` (re-exported from ./sse) yields StreamEnvelopes.
 */
import { resolveBaseURL, mocksEnabled } from "./config";
import { mockHandle } from "@/lib/mock/handlers";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

type Query = Record<string, string | number | boolean | undefined | null>;

export function buildQuery(params?: Query): string {
  if (!params) return "";
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

/** Absolute `/api` URL for a path + query (used for download / preview hrefs). */
export function buildUrl(path: string, params?: Query): string {
  return `${resolveBaseURL()}/api${path}${buildQuery(params)}`;
}

const MOCK = mocksEnabled();

export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  if (MOCK) return mockHandle(path, init) as Promise<T>;

  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const res = await fetch(`${resolveBaseURL()}/api${path}`, {
    ...init,
    headers,
  });

  if (!res.ok) {
    let msg = `请求失败 (${res.status})`;
    try {
      const text = await res.text();
      if (text) msg = text;
    } catch {
      /* ignore */
    }
    throw new ApiError(msg, res.status);
  }

  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    return (await res.json()) as T;
  }
  return (await res.text()) as unknown as T;
}

export function apiGet<T>(path: string, params?: Query): Promise<T> {
  return apiFetch<T>(`${path}${buildQuery(params)}`);
}

export function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: "PATCH",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function apiPut<T>(path: string, body?: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: "PUT",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function apiDelete<T>(path: string): Promise<T> {
  return apiFetch<T>(path, { method: "DELETE" });
}

export { openStream, openRawStream } from "./sse";
