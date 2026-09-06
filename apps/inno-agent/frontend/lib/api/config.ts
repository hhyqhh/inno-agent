/**
 * Single source of truth for the backend base URL (docs/frontend-rewrite-plan.md
 * §3.5). This module is deliberately pure: it only resolves the base URL and
 * owns no state/cache. The client (lib/api/client.ts) joins it onto every
 * request, so switching between same-origin and cross-origin is a one-line
 * change in resolution priority.
 *
 * Resolution precedence:
 *   1. `window.__INNO_BACKEND_URL__`  — runtime injection (Electron preload).
 *   2. `process.env.NEXT_PUBLIC_BACKEND_URL` — build-time env (static host).
 *   3. `""` — same-origin: request relative `/api`.
 *
 * `baseURL === ''` means same-origin (the backend, or an Electron host, serves
 * the SPA itself) — no CORS. An absolute `baseURL` is cross-origin and needs a
 * backend CORS header or a `/api → :3000` host proxy.
 */

const BACKEND_URL_KEYS: string[] = ["__INNO_BACKEND_URL__"];

export function resolveBaseURL(): string {
  if (typeof window !== "undefined") {
    for (const key of BACKEND_URL_KEYS) {
      const injected = (window as unknown as Record<string, unknown>)[key];
      if (typeof injected === "string" && injected.trim()) {
        return stripTrailingSlash(injected);
      }
    }
  }

  const env = process.env.NEXT_PUBLIC_BACKEND_URL;
  if (env && env.trim()) return stripTrailingSlash(env);

  return "";
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * True when the client should route through lib/mock/* instead of the
 * network. Default is ON so `next dev` works with no backend; set
 * `NEXT_PUBLIC_USE_MOCKS=0` (in .env.local) to hit the real backend.
 *
 * Note: this is a plain function (not a React hook, so no `use` prefix).
 */
export function mocksEnabled(): boolean {
  return process.env.NEXT_PUBLIC_USE_MOCKS !== "0";
}
