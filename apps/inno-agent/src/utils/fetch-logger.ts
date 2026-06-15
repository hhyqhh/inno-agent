/**
 * Lightweight fetch wrapper that logs HTTP requests to LLM providers.
 *
 * Installed once at startup via {@link installFetchLogger}. It wraps
 * `globalThis.fetch` so that any SDK (OpenAI, Anthropic, etc.) that uses
 * `fetch` under the hood will have its request URL and body logged through
 * the shared Pino logger.
 */

import { logger } from "../logger.js";

/** URL path segments that identify an LLM API call. */
const LLM_API_PATTERNS = [
  "/chat/completions",   // OpenAI & OpenAI-compatible providers
  "/messages",           // Anthropic Messages API
  "/api/stream",         // PI proxy mode
];

/** Maximum characters of the request body to log (avoid blowing up log files). */
const MAX_BODY_LENGTH = 8000;

type FetchFn = typeof globalThis.fetch;

/**
 * Wrap `globalThis.fetch` to log POST requests whose URL matches a known
 * LLM API pattern. The original `fetch` is called transparently so this
 * wrapper has no effect on request behaviour.
 */
export function installFetchLogger(): void {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async function (
    input: Parameters<FetchFn>[0],
    init?: Parameters<FetchFn>[1],
  ): ReturnType<FetchFn> {
    const url = resolveURL(input);
    const method = (init?.method ?? "GET").toString().toUpperCase();

    if (method === "POST" && LLM_API_PATTERNS.some((p) => url.includes(p))) {
      let bodyStr = extractBodyString(init?.body);
      if (bodyStr.length > MAX_BODY_LENGTH) {
        bodyStr = bodyStr.slice(0, MAX_BODY_LENGTH) + "...[truncated]";
      }
      logger.info(
        { url, requestBody: bodyStr },
        `LLM HTTP request: POST ${url}`,
      );
    }

    return originalFetch.call(globalThis, input, init) as ReturnType<FetchFn>;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveURL(input: Parameters<FetchFn>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  // Request object — check .url before falling back to string coercion.
  if (input != null && typeof input === "object" && "url" in input) {
    return String((input as { url: unknown }).url);
  }
  return String(input);
}

function extractBodyString(
  body: NonNullable<Parameters<FetchFn>[1]>["body"],
): string {
  if (body == null) return "";
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
    return new TextDecoder().decode(body);
  }
  // ReadableStream / FormData / URLSearchParams / Blob — skip.
  return "[non-text body]";
}
