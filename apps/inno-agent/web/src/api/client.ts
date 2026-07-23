export class ApiError extends Error {
	constructor(
		public status: number,
		message: string,
	) {
		super(message);
		this.name = "ApiError";
	}
}

const BASE_URL = ""; // Same origin — Vite proxy in dev

/**
 * Timeout for regular (non-streaming) API calls. Prevents indefinite hangs
 * when Chromium's per-origin connection pool (6 slots for HTTP/1.1) is
 * exhausted by lingering SSE connections — the fetch would otherwise queue
 * forever behind those connections.
 */
const API_TIMEOUT_MS = 15_000;

export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
	try {
		const res = await fetch(`${BASE_URL}${path}`, {
			...options,
			headers: { "Content-Type": "application/json", ...options?.headers },
			signal: controller.signal,
		});
		if (!res.ok) {
			const body = await res.json().catch(() => ({}));
			throw new ApiError(res.status, (body as Record<string, string>).error || res.statusText);
		}
		// 204 No Content
		if (res.status === 204) return undefined as T;
		return res.json() as Promise<T>;
	} finally {
		clearTimeout(timer);
	}
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
			headers: { "Content-Type": "application/json" },
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
export async function* streamSSEGet<T>(url: string, signal?: AbortSignal): AsyncGenerator<T> {
	let res: Response;
	try {
		res = await fetch(url, { method: "GET", signal });
	} catch (err) {
		if (signal?.aborted) return;
		throw err;
	}
	if (res.status === 404) {
		// Consume the body so the connection is returned to the pool immediately
		// rather than lingering until GC. A 404 here is expected (no active
		// backend stream for this session) but the response still holds a socket.
		void res.body?.cancel().catch(() => {});
		return;
	}
	if (!res.ok) {
		const errBody = await res.json().catch(() => ({}));
		throw new ApiError(res.status, (errBody as Record<string, string>).error || res.statusText);
	}
	yield* readSSEStream<T>(res, signal);
}
