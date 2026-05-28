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

export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
	const res = await fetch(`${BASE_URL}${path}`, {
		headers: { "Content-Type": "application/json", ...options?.headers },
		...options,
	});
	if (!res.ok) {
		const body = await res.json().catch(() => ({}));
		throw new ApiError(res.status, (body as Record<string, string>).error || res.statusText);
	}
	// 204 No Content
	if (res.status === 204) return undefined as T;
	return res.json() as Promise<T>;
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
	const reader = res.body!.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

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
		try {
			await reader.cancel();
		} catch {
			// already closed
		}
	}
}
