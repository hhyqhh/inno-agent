import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";

/**
 * Shared HTTP helpers for the server route domains.
 * Extracted verbatim from server.ts during the P2 route split — behavior
 * unchanged. Route modules under server/routes/ import from here instead of
 * re-defining their own copies.
 */

/**
 * Error carrying a client-facing HTTP status code. The server catch-all
 * honours `statusCode`/`message` instead of collapsing to a bare 500.
 */
export class HttpError extends Error {
	readonly statusCode: number;
	constructor(statusCode: number, message: string) {
		super(message);
		this.name = "HttpError";
		this.statusCode = statusCode;
	}
}

/**
 * Default request body cap (32 MB). Chat messages carry base64-encoded
 * images and skill/L2 uploads carry base64-encoded archives, so the limit
 * must be generous — but unbounded accumulation lets any client exhaust
 * server memory with a single oversized POST.
 */
export const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;

/**
 * Raised cap for the base64 upload endpoints (skill zip upload, L2 raw
 * document upload). Base64 inflates the payload by 4/3, so 192 MB on the
 * wire covers source files up to ~128 MB — large PDFs/Office docs are
 * legitimate inputs there, unlike on the chat/CRUD endpoints.
 */
export const UPLOAD_MAX_BODY_BYTES = 192 * 1024 * 1024;

export function readBody(req: HttpReq, options?: { maxBytes?: number }): Promise<unknown> {
	const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BODY_BYTES;
	return new Promise((resolve, reject) => {
		// Stop consuming without destroying the socket: the catch-all still
		// needs to write the 413 response on this connection. The response is
		// sent with `Connection: close` and the socket is torn down after the
		// response flushes (an unconsumed body makes keep-alive unsafe).
		const tooLarge = (): void => {
			req.removeAllListeners("data");
			req.pause();
			reject(new HttpError(413, `Request body too large (limit ${maxBytes} bytes)`));
		};

		// Reject early when the declared size already exceeds the cap.
		const declared = Number.parseInt(req.headers["content-length"] ?? "", 10);
		if (Number.isFinite(declared) && declared > maxBytes) {
			tooLarge();
			return;
		}

		let data = "";
		let received = 0;
		req.on("data", (chunk: Buffer) => {
			received += chunk.length;
			if (received > maxBytes) {
				tooLarge();
				return;
			}
			data += chunk.toString();
		});
		req.on("end", () => {
			try {
				resolve(data ? JSON.parse(data) : {});
			} catch (err) {
				reject(new HttpError(400, "Invalid JSON body"));
			}
		});
		req.on("error", reject);
	});
}

export function json(res: ServerResponse, status: number, data: unknown): void {
	const body = data !== null ? JSON.stringify(data) : "";
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(body),
	});
	res.end(body);
}

/** Constant-time `Authorization: Bearer <token>` check. */
export function bearerTokenMatches(authHeader: string | undefined, token: string): boolean {
	if (!authHeader) return false;
	const expected = Buffer.from(`Bearer ${token}`, "utf-8");
	const actual = Buffer.from(authHeader, "utf-8");
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Extract the API token from a request: the Authorization header, or the
 * `?token=` query parameter (browser WebSocket connections cannot set
 * headers, so the terminal WS carries it in the URL).
 */
export function requestToken(req: HttpReq): string | null {
	const auth = req.headers.authorization;
	if (auth?.startsWith("Bearer ")) return auth.slice("Bearer ".length);
	try {
		const url = new URL(req.url ?? "/", "http://localhost");
		return url.searchParams.get("token");
	} catch {
		return null;
	}
}

/** Constant-time check of a request against the configured server token. */
export function requestTokenMatches(req: HttpReq, token: string): boolean {
	const presented = requestToken(req);
	if (presented === null) return false;
	const expected = Buffer.from(token, "utf-8");
	const actual = Buffer.from(presented, "utf-8");
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Cross-origin defense for the loopback-bound server: when a request carries
 * an Origin header (i.e. it comes from a browser page), the Origin's host
 * must match the request's Host header. This blocks cross-site form POSTs
 * (drive-by CSRF against localhost) and DNS-rebinding reads, while leaving
 * non-browser clients (curl, sidecars — no Origin header) untouched.
 */
export function originMatchesHost(req: HttpReq): boolean {
	const origin = req.headers.origin;
	if (!origin) return true;
	const host = req.headers.host;
	if (!host) return false;
	try {
		return new URL(origin).host === host;
	} catch {
		return false;
	}
}

/**
 * Simple route matching with :param support.
 * Returns params object or null if no match.
 */
export function matchRoute(
	method: string,
	reqMethod: string,
	reqUrl: string,
	pattern: string,
): Record<string, string> | null {
	if (reqMethod !== method) return null;
	const url = reqUrl.split("?")[0];
	const patternParts = pattern.split("/");
	const urlParts = url.split("/");
	if (patternParts.length !== urlParts.length) return null;

	const params: Record<string, string> = {};
	for (let i = 0; i < patternParts.length; i++) {
		if (patternParts[i].startsWith(":")) {
			try {
				params[patternParts[i].slice(1)] = decodeURIComponent(urlParts[i]);
			} catch (err) {
				params[patternParts[i].slice(1)] = urlParts[i];
			}
		} else if (patternParts[i] !== urlParts[i]) {
			return null;
		}
	}
	return params;
}
