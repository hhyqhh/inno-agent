declare global {
	interface Window {
		/**
		 * Injected by the server into index.html only when `server.token` is
		 * configured (see serveIndexHtml in server.ts). Absent by default —
		 * this project has no multi-user auth model, this only guards the
		 * single-user deployment's own API surface.
		 */
		__INNO_API_TOKEN__?: string;
	}
}

export class ApiError extends Error {
	constructor(
		public status: number,
		message: string,
		/** Parsed error response body, when the server sent one (e.g. 409 session_busy carries `blocking`). */
		public data?: Record<string, unknown>,
	) {
		super(message);
		this.name = "ApiError";
	}
}

const BASE_URL = ""; // Same origin — Vite proxy in dev

/**
 * The injected token, or undefined outside a browser (SSR-less here, but
 * also plain Node test environments that mock fetch without a DOM/window).
 */
function apiToken(): string | undefined {
	return typeof window !== "undefined" ? window.__INNO_API_TOKEN__ : undefined;
}

/** `Authorization` header for the optional server.token, when the server injected one. */
function authHeaders(): Record<string, string> {
	const token = apiToken();
	return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Append `?token=`/`&token=` for URLs the browser renders directly
 * (`<img src>`, `<iframe src>`, download links, the terminal WebSocket) —
 * these can't carry an Authorization header, so the server also accepts the
 * token as a query param on those routes. No-op when no token is configured.
 */
export function withApiToken(url: string): string {
	const token = apiToken();
	if (!token) return url;
	return `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
}

export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
	const res = await fetch(`${BASE_URL}${path}`, {
		headers: { "Content-Type": "application/json", ...authHeaders(), ...options?.headers },
		...options,
	});
	if (!res.ok) {
		const body = await res.json().catch(() => ({}));
		throw new ApiError(res.status, (body as Record<string, string>).error || res.statusText, body as Record<string, unknown>);
	}
	// 204 No Content
	if (res.status === 204) return undefined as T;
	return res.json() as Promise<T>;
}

/** Reject with `message` if the promise doesn't settle within `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(message)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Shared SSE body-reading loop. Yields parsed JSON objects from `data:` lines.
 * When the signal is aborted the generator returns normally.
 *
 * Connection hygiene: when the caller aborts (e.g. via detach()), we
 * proactively cancel the reader via an abort listener so the underlying TCP
 * connection is released immediately, rather than waiting for the pending
 * reader.read() to reject on the next chunk. Without this, rapidly switching
 * sessions can accumulate stale SSE connections that exhaust Chromium's
 * 6-connection-per-origin pool, causing all subsequent fetch() calls to hang.
 */
async function* readSSEStream<T>(res: Response, signal?: AbortSignal): AsyncGenerator<T> {
	const reader = res.body!.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	const onAbort = () => { void reader.cancel().catch(() => {}); };
	signal?.addEventListener("abort", onAbort);

	try {
		while (true) {
			let chunk: ReadableStreamReadResult<Uint8Array>;
			try {
				chunk = await reader.read();
			} catch (err) {
				if (signal?.aborted) return;
				throw err;
			}
			if (chunk.done) break;
			buffer += decoder.decode(chunk.value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop()!;
			for (const line of lines) {
				if (line.startsWith("data: ")) {
					const json = line.slice(6).trim();
					if (json === "[DONE]") return;
					try {
						yield JSON.parse(json) as T;
					} catch {
						// skip malformed lines
					}
				}
			}
		}
	} finally {
		signal?.removeEventListener("abort", onAbort);
		try {
			await reader.cancel();
		} catch {
			// already closed
		}
	}
}

/**
 * SSE stream parser. Yields parsed JSON objects from `data:` lines.
 * Pass an AbortSignal to allow callers to stop the stream early (e.g. user
 * clicks Stop). When aborted the generator returns normally instead of
 * surfacing the underlying AbortError.
 */
export async function* streamSSE<T>(url: string, body: unknown, signal?: AbortSignal): AsyncGenerator<T> {
	let res: Response;
	try {
		res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...authHeaders() },
			body: JSON.stringify(body),
			signal,
		});
	} catch (err) {
		if (signal?.aborted) return;
		throw err;
	}
	if (!res.ok) {
		const errBody = await res.json().catch(() => ({}));
		throw new ApiError(res.status, (errBody as Record<string, string>).error || res.statusText);
	}
	yield* readSSEStream<T>(res, signal);
}

/**
 * SSE stream via GET. Returns silently on 404 (no active stream).
 * Yields parsed JSON objects from `data:` lines.
 */
export async function* streamSSEGet<T>(url: string, signal?: AbortSignal, options: { allowNotFound?: boolean } = {}): AsyncGenerator<T> {
	let res: Response;
	try {
		res = await fetch(url, { method: "GET", headers: authHeaders(), signal });
	} catch (err) {
		if (signal?.aborted) return;
		throw err;
	}
	if (res.status === 404) {
		// Consume the body so the connection is returned to the pool immediately
		// rather than lingering until GC. A 404 here is expected (no active
		// backend stream for this session) but the response still holds a socket.
		void res.body?.cancel().catch(() => {});
		if (options.allowNotFound !== false) return;
		throw new ApiError(404, "Stream not found");
	}
	if (!res.ok) {
		const errBody = await res.json().catch(() => ({}));
		throw new ApiError(res.status, (errBody as Record<string, string>).error || res.statusText);
	}
	yield* readSSEStream<T>(res, signal);
}
