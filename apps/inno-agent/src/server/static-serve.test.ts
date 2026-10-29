import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serveStatic } from "./static-serve.js";

function fakeReq(acceptEncoding?: string | string[], method = "GET"): HttpReq & PassThrough {
	const stream = new PassThrough() as HttpReq & PassThrough;
	stream.headers = { "accept-encoding": acceptEncoding } as HttpReq["headers"];
	stream.method = method;
	stream.end();
	return stream;
}

function fakeRes(): ServerResponse & {
	headers: Record<string, string | number>;
	ended: boolean;
	body: () => Buffer | undefined;
} {
	let body: Buffer | undefined;
	const res = {
		statusCode: 0,
		headers: {},
		ended: false,
		writeHead(status: number, headers: Record<string, string | number>) {
			res.statusCode = status;
			res.headers = headers;
			return res;
		},
		end(chunk?: Buffer) {
			body = chunk;
			res.ended = true;
			return res;
		},
		body: () => body,
	} as unknown as ReturnType<typeof fakeRes>;
	return res;
}

let dir: string;
let staticRoot: string;
let filePath: string;
const source = Buffer.from("console.log('静态文件');\n");
const brotli = brotliCompressSync(source);
const gzip = gzipSync(source);

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "static-serve-"));
	staticRoot = join(dir, "web");
	mkdirSync(join(staticRoot, "assets"), { recursive: true });
	filePath = join(staticRoot, "assets", "index-Abcd1234.js");
	writeFileSync(filePath, source);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("serveStatic", () => {
	it.each([
		["index.html", "text/html; charset=utf-8", "no-cache"],
		["assets/index-Abcd1234.html", "text/html; charset=utf-8", "no-cache"],
		["assets/index-Abcd1234.js", "application/javascript; charset=utf-8", "public, max-age=31536000, immutable"],
		["assets/harfbuzz-Abcd1234.wasm", "application/wasm", "public, max-age=31536000, immutable"],
		["font.otf", "font/otf", "no-cache"],
		["notes.txt", "application/octet-stream", "no-cache"],
	])("preserves content and cache headers for %s", async (name, contentType, cacheControl) => {
		const path = join(staticRoot, name);
		writeFileSync(path, source);
		const res = fakeRes();

		expect(await serveStatic(fakeReq(), res, path, undefined, staticRoot)).toBe(true);
		expect(res.statusCode).toBe(200);
		expect(res.headers).toEqual({
			"Content-Type": contentType,
			"Content-Length": source.length,
			"Cache-Control": cacheControl,
		});
		expect(res.body()).toEqual(source);
	});

	it.each([
		["br", ".br", brotli],
		["gzip", ".gz", gzip],
	] as const)("serves the %s sibling with encoding and vary headers", async (encoding, suffix, content) => {
		writeFileSync(`${filePath}${suffix}`, content);
		const res = fakeRes();

		expect(await serveStatic(fakeReq(encoding), res, filePath, true, staticRoot)).toBe(true);
		expect(res.statusCode).toBe(200);
		expect(res.headers).toEqual({
			"Content-Type": "application/javascript; charset=utf-8",
			"Content-Length": content.length,
			"Cache-Control": "public, max-age=31536000, immutable",
			"Content-Encoding": encoding,
			Vary: "Accept-Encoding",
		});
		expect(res.body()).toEqual(content);
	});

	it.each([
		["br, gzip", "br", brotli],
		[["gzip", "br"], "br", brotli],
		["br;q=0, gzip", "gzip", gzip],
		["*;q=1", "br", brotli],
		["br;q=0, gzip;q=0", undefined, source],
	] as const)("preserves encoding negotiation for %s", async (acceptEncoding, encoding, content) => {
		writeFileSync(`${filePath}.br`, brotli);
		writeFileSync(`${filePath}.gz`, gzip);
		const res = fakeRes();
		const header = typeof acceptEncoding === "string" ? acceptEncoding : [...acceptEncoding];

		expect(await serveStatic(fakeReq(header), res, filePath, true, staticRoot)).toBe(true);
		expect(res.headers["Content-Encoding"]).toBe(encoding);
		expect(res.headers.Vary).toBe(encoding ? "Accept-Encoding" : undefined);
		expect(res.headers["Content-Length"]).toBe(content.length);
		expect(res.body()).toEqual(content);
	});

	it.each([
		[undefined, undefined, source],
		["br", ".br", brotli],
		["gzip", ".gz", gzip],
	] as const)("keeps HEAD content length without a body for %s", async (encoding, suffix, content) => {
		if (suffix) writeFileSync(`${filePath}${suffix}`, content);
		const res = fakeRes();

		expect(await serveStatic(fakeReq(encoding, "HEAD"), res, filePath, false, staticRoot)).toBe(true);
		expect(res.statusCode).toBe(200);
		expect(res.headers["Content-Length"]).toBe(content.length);
		expect(res.headers["Cache-Control"]).toBe("public, max-age=31536000, immutable");
		expect(res.headers["Content-Encoding"]).toBe(encoding);
		expect(res.headers.Vary).toBe(encoding ? "Accept-Encoding" : undefined);
		expect(res.ended).toBe(true);
		expect(res.body()).toBeUndefined();
	});

	it("returns false without writing a response for a missing file", async () => {
		const res = fakeRes();

		expect(await serveStatic(fakeReq(), res, join(staticRoot, "missing.js"), true, staticRoot)).toBe(false);
		expect(res.statusCode).toBe(0);
		expect(res.headers).toEqual({});
		expect(res.ended).toBe(false);
	});

	it("returns false without writing a response when a sibling cannot be read", async () => {
		mkdirSync(`${filePath}.br`);
		const res = fakeRes();

		expect(await serveStatic(fakeReq("br"), res, filePath, true, staticRoot)).toBe(false);
		expect(res.statusCode).toBe(0);
		expect(res.headers).toEqual({});
		expect(res.ended).toBe(false);
	});

	it.each([
		["br", ".br"],
		["gzip", ".gz"],
	] as const)("rejects a %s sibling symlink outside the static root", async (encoding, suffix) => {
		const outsideRoot = join(dir, "web-outside");
		mkdirSync(outsideRoot);
		const outsideFile = join(outsideRoot, "secret");
		writeFileSync(outsideFile, "must not be served");
		symlinkSync(outsideFile, `${filePath}${suffix}`);
		const res = fakeRes();

		expect(await serveStatic(fakeReq(encoding), res, filePath, true, staticRoot)).toBe(true);
		expect(res.headers["Content-Encoding"]).toBeUndefined();
		expect(res.headers.Vary).toBeUndefined();
		expect(res.headers["Content-Length"]).toBe(source.length);
		expect(res.body()).toEqual(source);
	});

	it("waits for the asynchronous read before writing the response", async () => {
		const res = fakeRes();

		const pending = serveStatic(fakeReq(), res, filePath, true, staticRoot);
		expect(res.statusCode).toBe(0);
		expect(res.ended).toBe(false);
		expect(await pending).toBe(true);
		expect(res.body()).toEqual(source);
	});
});
