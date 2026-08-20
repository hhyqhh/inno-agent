import { PassThrough } from "node:stream";
import type { IncomingMessage as HttpReq } from "node:http";
import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_BODY_BYTES, HttpError, readBody } from "./http-helpers.js";

/**
 * Unit tests for the readBody size cap and HttpError plumbing
 * (issue #162: unbounded body accumulation allowed memory DoS).
 */

function fakeReq(headers: Record<string, string> = {}): HttpReq & PassThrough {
	const stream = new PassThrough() as HttpReq & PassThrough;
	stream.headers = headers;
	return stream;
}

async function expectHttpError(promise: Promise<unknown>, statusCode: number): Promise<void> {
	await expect(promise).rejects.toSatisfy(
		(err) => err instanceof HttpError && err.statusCode === statusCode,
	);
}

describe("readBody", () => {
	it("parses a valid JSON body", async () => {
		const req = fakeReq();
		const body = readBody(req);
		req.end(JSON.stringify({ hello: "world" }));
		await expect(body).resolves.toEqual({ hello: "world" });
	});

	it("preserves a UTF-8 character split across request chunks", async () => {
		const req = fakeReq();
		const body = readBody(req);
		const expected = { message: "证据定位" };
		const encoded = Buffer.from(JSON.stringify(expected), "utf8");
		const characterStart = encoded.indexOf(Buffer.from("证", "utf8"));

		expect(characterStart).toBeGreaterThanOrEqual(0);
		req.write(encoded.subarray(0, characterStart + 1));
		req.end(encoded.subarray(characterStart + 1));

		await expect(body).resolves.toEqual(expected);
	});

	it("resolves to {} for an empty body", async () => {
		const req = fakeReq();
		const body = readBody(req);
		req.end();
		await expect(body).resolves.toEqual({});
	});

	it("rejects with HttpError 400 on invalid JSON", async () => {
		const req = fakeReq();
		const body = readBody(req);
		req.end("not json{");
		await expectHttpError(body, 400);
	});

	it("rejects with HttpError 413 when declared Content-Length exceeds the cap", async () => {
		const req = fakeReq({ "content-length": String(DEFAULT_MAX_BODY_BYTES + 1) });
		const body = readBody(req);
		await expectHttpError(body, 413);
	});

	it("rejects with HttpError 413 mid-stream and stops consuming", async () => {
		const req = fakeReq();
		const body = readBody(req);
		// First chunk under the cap, second pushes the total over it.
		req.write(Buffer.alloc(DEFAULT_MAX_BODY_BYTES, "a"));
		req.write(Buffer.alloc(1, "a"));
		await expectHttpError(body, 413);
		// After the cap trips, further data must not accumulate or crash.
		req.write(Buffer.alloc(16, "b"));
		req.end();
	});

	it("honours a per-call maxBytes override", async () => {
		const req = fakeReq();
		const body = readBody(req, { maxBytes: 16 });
		req.end(JSON.stringify({ payload: "this is definitely longer than sixteen bytes" }));
		await expectHttpError(body, 413);
	});
});
