import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, apiFetch, apiFetchResponse } from "./client.js";

describe("API client errors", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("keeps legacy string errors displayable", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
			JSON.stringify({ error: "Legacy request failed" }),
			{ status: 409, statusText: "Conflict", headers: { "Content-Type": "application/json" } },
		)));

		await expect(apiFetch("/api/legacy")).rejects.toMatchObject({
			name: "ApiError",
			status: 409,
			message: "Legacy request failed",
			code: undefined,
			details: undefined,
		});
	});

	it("exposes structured error codes and details", async () => {
		const data = {
			error: "Source changed",
			code: "source_revision_mismatch",
			details: { retryable: false },
		};
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
			JSON.stringify(data),
			{ status: 412, statusText: "Precondition Failed", headers: { "Content-Type": "application/json" } },
		)));

		try {
			await apiFetch("/api/structured");
			expect.unreachable("request should fail");
		} catch (error) {
			expect(error).toBeInstanceOf(ApiError);
			expect(error).toMatchObject({
				status: 412,
				message: "Source changed",
				code: "source_revision_mismatch",
				details: { retryable: false },
				data,
			});
		}
	});

	it("never turns a non-string error payload into an object string", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
			JSON.stringify({ error: { secret: "not display text" } }),
			{ status: 400, statusText: "Bad Request", headers: { "Content-Type": "application/json" } },
		)));

		await expect(apiFetch("/api/object-error")).rejects.toMatchObject({
			message: "Bad Request",
		});
	});

	it("returns an unconsumed successful response", async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response("raw bytes", {
			status: 200,
			headers: { ETag: '"sha256:abc"' },
		}));
		vi.stubGlobal("fetch", fetchMock);

		const response = await apiFetchResponse("/api/raw", {
			headers: { "If-Match": '"sha256:abc"' },
		});

		expect(await response.text()).toBe("raw bytes");
		expect(response.headers.get("ETag")).toBe('"sha256:abc"');
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("/api/raw");
		expect(new Headers(init.headers).get("If-Match")).toBe('"sha256:abc"');
	});
});
