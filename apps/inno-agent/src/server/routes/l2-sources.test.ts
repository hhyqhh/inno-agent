import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
	mkdirSync,
	mkdtempSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import {
	createServer,
	type IncomingMessage as HttpReq,
	type Server,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const routeRace = vi.hoisted(() => ({
	beforeOpen: undefined as ((path: string) => void) | undefined,
	beforeRead: undefined as ((path: string) => void) | undefined,
	closedPaths: [] as string[],
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		async open(path: Parameters<typeof actual.open>[0], flags: Parameters<typeof actual.open>[1]) {
			routeRace.beforeOpen?.(String(path));
			const handle = await actual.open(path, flags);
			const pathText = String(path);
			return new Proxy(handle, {
				get(target, property) {
					if (property === "read") {
						return (...args: Parameters<typeof target.read>) => {
							routeRace.beforeRead?.(pathText);
							return target.read(...args);
						};
					}
					if (property === "close") {
						return async () => {
							routeRace.closedPaths.push(pathText);
							await target.close();
						};
					}
					const value = Reflect.get(target, property, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
		},
	};
});

import {
	buildEvidenceIndex,
	type SourceEvidenceIndex,
	writeEvidenceIndexAtomic,
} from "../../memory/l2/evidence-index.js";
import { upsertManifest } from "../../memory/l2/manifest-store.js";
import type { ManifestEntry, RawSourceType } from "../../memory/l2/types.js";
import { DEFAULT_MAX_BODY_BYTES } from "../http-helpers.js";
import { handleL2SourceRoutes } from "./l2-sources.js";

let root: string;
let server: Server;
let baseUrl: string;

class ControlledResponse extends EventEmitter {
	readonly headers = new Map<string, string | number | readonly string[]>();
	readonly chunks: Buffer[] = [];
	headersSent = false;
	writableEnded = false;
	destroyed = false;
	statusCode = 200;
	backpressured = false;
	private resolveFirstWrite!: () => void;
	readonly firstWrite = new Promise<void>((resolveWrite) => {
		this.resolveFirstWrite = resolveWrite;
	});

	setHeader(name: string, value: string | number | readonly string[]): this {
		this.headers.set(name.toLowerCase(), value);
		return this;
	}

	getHeader(name: string): string | number | readonly string[] | undefined {
		return this.headers.get(name.toLowerCase());
	}

	writeHead(statusCode: number, headers?: Record<string, string | number>): this {
		this.statusCode = statusCode;
		for (const [name, value] of Object.entries(headers ?? {})) this.setHeader(name, value);
		this.headersSent = true;
		return this;
	}

	write(chunk: string | Uint8Array): boolean {
		this.headersSent = true;
		this.chunks.push(Buffer.from(chunk));
		this.resolveFirstWrite();
		return !this.backpressured;
	}

	end(chunk?: string | Uint8Array): this {
		if (chunk !== undefined) this.chunks.push(Buffer.from(chunk));
		this.headersSent = true;
		this.writableEnded = true;
		return this;
	}

	bodyText(): string {
		return Buffer.concat(this.chunks).toString("utf8");
	}
}

function controlledRequest(headers: Record<string, string>): HttpReq & PassThrough {
	const requestStream = new PassThrough() as HttpReq & PassThrough;
	requestStream.headers = headers;
	return requestStream;
}

function hash(bytes: string | Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function samePath(left: string, right: string): boolean {
	return process.platform === "win32"
		? left.toLowerCase() === right.toLowerCase()
		: left === right;
}

function evidencePath(sourceId: string): string {
	return join(root, "extracted", "evidence", "by-id", `${hash(sourceId)}.json`);
}

function extensionFor(sourceType: RawSourceType): string {
	if (sourceType === "pdf") return ".pdf";
	if (sourceType === "word") return ".docx";
	if (sourceType === "image") return ".png";
	return ".md";
}

function manifest(id: string, rawPath: string, sourceType: RawSourceType, title = "Source"): ManifestEntry {
	return {
		id,
		title,
		sourceType,
		rawPath,
		wikiPages: [],
		tags: [],
		contentHash: "legacy",
		status: "indexed",
		source: { origin: "user_upload" },
		createdAt: "2026-08-16T00:00:00.000Z",
		updatedAt: "2026-08-16T00:00:00.000Z",
	};
}

function addSource(input: {
	id: string;
	sourceType?: RawSourceType;
	bytes: string | Buffer;
	title?: string;
	indexText?: string;
	rawFileStem?: string;
}): { entry: ManifestEntry; revision: string; index?: SourceEvidenceIndex } {
	const sourceType = input.sourceType ?? "markdown";
	const rawPath = `raw/uploads/${input.rawFileStem ?? input.id}${extensionFor(sourceType)}`;
	const absolutePath = join(root, rawPath);
	mkdirSync(join(root, "raw", "uploads"), { recursive: true });
	writeFileSync(absolutePath, input.bytes);
	const rawContentHash = hash(input.bytes);
	const entry = {
		...manifest(input.id, rawPath, sourceType, input.title),
		rawContentHash,
		rawSize: Buffer.byteLength(input.bytes),
		rawKind: "uploaded-original" as const,
	};
	upsertManifest(root, entry);

	let index: SourceEvidenceIndex | undefined;
	if (input.indexText !== undefined) {
		index = buildEvidenceIndex({
			sourceId: input.id,
			sourceType: "markdown",
			rawContentHash,
			parsed: {
				text: input.indexText,
				pageCount: 1,
				pages: [{ pageNumber: 1, text: input.indexText }],
			},
		});
		writeEvidenceIndexAtomic(root, index);
	}
	return { entry, revision: `sha256:${rawContentHash}`, index };
}

async function startServer(): Promise<void> {
	server = createServer((request, response) => {
		void handleL2SourceRoutes(
			request,
			response,
			request.method ?? "GET",
			request.url ?? "/",
			{ l2DataDir: root },
		).then((handled) => {
			if (!handled && !response.writableEnded) {
				response.writeHead(404, { "Content-Type": "application/json" });
				response.end(JSON.stringify({ error: "not found" }));
			}
		}).catch(() => {
			if (!response.writableEnded) {
				response.writeHead(500, { "Content-Type": "application/json" });
				response.end(JSON.stringify({ error: "route failed" }));
			}
		});
	});
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function request(
	method: "GET" | "HEAD" | "POST",
	path: string,
	options: { revision?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
	return fetch(`${baseUrl}${path}`, {
		method,
		headers: {
			...(options.revision === undefined ? {} : { "If-Match": `"${options.revision}"` }),
			...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
			...options.headers,
		},
		...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
	});
}

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "inno-l2-source-route-"));
	routeRace.beforeOpen = undefined;
	routeRace.beforeRead = undefined;
	routeRace.closedPaths.length = 0;
	await startServer();
});

afterEach(async () => {
	await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
	rmSync(root, { recursive: true, force: true });
});

describe("L2 source routes", () => {
	it("serves legacy manifest source IDs through their encoded source-ID route", async () => {
		const id = "legacy@example.com";
		const source = addSource({ id, bytes: "Legacy source." });

		const response = await request(
			"GET",
			`/api/l2/sources/${encodeURIComponent(id)}/content`,
			{ revision: source.revision },
		);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("Legacy source.");
	});

	it("treats path-looking legacy IDs only as exact hashed lookup keys", async () => {
		const id = "../../Visible-Source-ID/\u79d8\u5bc6";
		const text = "Legacy evidence.";
		const source = addSource({
			id,
			bytes: text,
			indexText: text,
			rawFileStem: "legacy-path-looking-id",
		});
		const encodedId = encodeURIComponent(id);
		const blockId = source.index!.blocks[0].id;

		const content = await request("GET", `/api/l2/sources/${encodedId}/content`, {
			revision: source.revision,
		});
		expect(content.status).toBe(200);
		expect(await content.text()).toBe(text);

		const evidence = await request(
			"GET",
			`/api/l2/sources/${encodedId}/evidence?blockId=${encodeURIComponent(blockId)}`,
			{ revision: source.revision },
		);
		expect(evidence.status).toBe(200);
		expect(await evidence.json()).toMatchObject({ sourceId: id });

		const locate = await request("POST", `/api/l2/sources/${encodedId}/locate`, {
			revision: source.revision,
			body: { quote: "Legacy evidence", sourceRevision: source.revision, indexVersion: 1 },
		});
		expect(locate.status).toBe(200);
		expect((await locate.json() as { matches: unknown[] }).matches).toHaveLength(1);

		const nearMiss = await request(
			"GET",
			`/api/l2/sources/${encodeURIComponent(id.toLowerCase())}/content`,
			{ revision: source.revision },
		);
		expect(nearMiss.status).toBe(404);
		expect(await nearMiss.json()).toMatchObject({ code: "source_not_found" });
	});

	it("requires If-Match for content, evidence, and locate", async () => {
		const id = "l2src_required";
		const source = addSource({ id, bytes: "Alpha evidence.", indexText: "Alpha evidence." });
		const blockId = source.index!.blocks[0].id;
		for (const [method, path, body] of [
			["GET", `/api/l2/sources/${id}/content`, undefined],
			["GET", `/api/l2/sources/${id}/evidence?blockId=${encodeURIComponent(blockId)}`, undefined],
			["POST", `/api/l2/sources/${id}/locate`, {
				quote: "Alpha",
				sourceRevision: source.revision,
				indexVersion: 1,
			}],
		] as const) {
			const response = await request(method, path, { body });
			expect(response.status).toBe(428);
			expect(await response.json()).toMatchObject({ code: "if_match_required" });
		}
	});

	it.each(["*", `W/\"sha256:${"0".repeat(64)}\"`, `sha256:${"0".repeat(64)}`, `\"sha256:${"0".repeat(64)}\", \"sha256:${"0".repeat(64)}\"`])(
		"rejects a non-strong or multi-value If-Match header: %s",
		async (ifMatch) => {
			const id = "l2src_bad_etag";
			addSource({ id, bytes: "content" });
			const response = await request("GET", `/api/l2/sources/${id}/content`, {
				headers: { "If-Match": ifMatch },
			});
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ code: "invalid_if_match" });
		},
	);

	it("serves Markdown GET and HEAD with revision and safe content headers", async () => {
		const id = "l2src_markdown_content";
		const bytes = "# Lesson\n\nAlpha evidence.\n";
		const source = addSource({ id, bytes, title: "Lesson" });

		const get = await request("GET", `/api/l2/sources/${id}/content`, { revision: source.revision });
		expect(get.status).toBe(200);
		expect(get.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
		expect(get.headers.get("content-length")).toBe(String(Buffer.byteLength(bytes)));
		expect(get.headers.get("etag")).toBe(`"${source.revision}"`);
		expect(get.headers.get("x-content-type-options")).toBe("nosniff");
		expect(get.headers.get("content-disposition")).toContain("inline");
		expect(await get.text()).toBe(bytes);

		const head = await request("HEAD", `/api/l2/sources/${id}/content`, { revision: source.revision });
		expect(head.status).toBe(200);
		expect(head.headers.get("content-length")).toBe(String(Buffer.byteLength(bytes)));
		expect(head.headers.get("etag")).toBe(`"${source.revision}"`);
		expect((await head.arrayBuffer()).byteLength).toBe(0);
	});

	it("serves a PDF byte range and rejects an unsatisfiable range", async () => {
		const id = "l2src_pdf_range";
		const bytes = Buffer.from("%PDF-1.7\n0123456789abcdef\n", "ascii");
		const source = addSource({ id, sourceType: "pdf", bytes, title: "Document" });

		const partial = await request("GET", `/api/l2/sources/${id}/content`, {
			revision: source.revision,
			headers: { Range: "bytes=9-14" },
		});
		expect(partial.status).toBe(206);
		expect(partial.headers.get("accept-ranges")).toBe("bytes");
		expect(partial.headers.get("content-range")).toBe(`bytes 9-14/${bytes.length}`);
		expect(partial.headers.get("content-length")).toBe("6");
		expect(Buffer.from(await partial.arrayBuffer())).toEqual(bytes.subarray(9, 15));

		const openEnded = await request("GET", `/api/l2/sources/${id}/content`, {
			revision: source.revision,
			headers: { Range: "bytes=20-" },
		});
		expect(openEnded.status).toBe(206);
		expect(Buffer.from(await openEnded.arrayBuffer())).toEqual(bytes.subarray(20));

		const suffix = await request("GET", `/api/l2/sources/${id}/content`, {
			revision: source.revision,
			headers: { Range: "bytes=-4" },
		});
		expect(suffix.status).toBe(206);
		expect(Buffer.from(await suffix.arrayBuffer())).toEqual(bytes.subarray(-4));

		const invalid = await request("GET", `/api/l2/sources/${id}/content`, {
			revision: source.revision,
			headers: { Range: "bytes=999-" },
		});
		expect(invalid.status).toBe(416);
		expect(invalid.headers.get("content-range")).toBe(`bytes */${bytes.length}`);
		expect(await invalid.json()).toMatchObject({ code: "range_not_satisfiable" });

		const multiple = await request("GET", `/api/l2/sources/${id}/content`, {
			revision: source.revision,
			headers: { Range: "bytes=0-1,4-5" },
		});
		expect(multiple.status).toBe(416);
		expect(await multiple.json()).toMatchObject({ code: "range_not_satisfiable" });

		const head = await request("HEAD", `/api/l2/sources/${id}/content`, { revision: source.revision });
		expect(head.status).toBe(200);
		expect(head.headers.get("accept-ranges")).toBe("bytes");
		expect(head.headers.get("content-type")).toBe("application/pdf");
		expect(head.headers.get("content-length")).toBe(String(bytes.length));
		expect(head.headers.get("etag")).toBe(`"${source.revision}"`);
		expect(head.headers.get("x-content-type-options")).toBe("nosniff");
		expect((await head.arrayBuffer()).byteLength).toBe(0);
	});

	it.each([
		{ label: "full GET", sourceType: "markdown" as const, range: undefined },
		{ label: "PDF byte range", sourceType: "pdf" as const, range: "bytes=8-23" },
	])("rejects a same-size in-place mutation before serving $label under a stale ETag", async ({
		sourceType,
		range,
	}) => {
		const id = `l2src_changed_during_${sourceType}`;
		const original = Buffer.alloc(64, "a");
		const replacement = Buffer.alloc(original.length, "b");
		const source = addSource({ id, sourceType, bytes: original });
		const rawAbsolutePath = join(root, source.entry.rawPath);
		let rawReadCount = 0;
		routeRace.beforeRead = (openedPath) => {
			if (!samePath(openedPath, rawAbsolutePath)) return;
			rawReadCount += 1;
			if (rawReadCount !== 2) return;
			routeRace.beforeRead = undefined;
			writeFileSync(rawAbsolutePath, replacement);
		};

		const response = await request("GET", `/api/l2/sources/${id}/content`, {
			revision: source.revision,
			...(range === undefined ? {} : { headers: { Range: range } }),
		});
		const responseText = await response.text();

		expect(rawReadCount).toBe(2);
		expect(response.status).toBe(412);
		expect(response.headers.get("etag")).toBeNull();
		expect(JSON.parse(responseText)).toMatchObject({ code: "source_revision_mismatch" });
		expect(responseText).not.toContain(root);
		expect(routeRace.closedPaths.some((path) => samePath(path, rawAbsolutePath))).toBe(true);
	});

	it("serves Word content only as a controlled attachment", async () => {
		const id = "l2src_word_attachment";
		const source = addSource({ id, sourceType: "word", bytes: "docx bytes", title: "Report" });

		const response = await request("GET", `/api/l2/sources/${id}/content`, { revision: source.revision });

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe(
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		);
		expect(response.headers.get("content-disposition")).toContain("attachment");
		expect(response.headers.get("content-disposition")).toContain("Report.docx");
	});

	it("returns a target evidence block and two neighbors on each side", async () => {
		const id = "l2src_evidence_slice";
		const text = ["One.", "Two.", "Three target.", "Four.", "Five.", "Six."].join("\n\n");
		const source = addSource({ id, bytes: text, indexText: text });
		const target = source.index!.blocks[2];

		const response = await request(
			"GET",
			`/api/l2/sources/${id}/evidence?blockId=${encodeURIComponent(target.id)}`,
			{ revision: source.revision },
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("etag")).toBe(`"${source.revision}"`);
		expect(await response.json()).toEqual({
			sourceId: id,
			sourceRevision: source.revision,
			indexVersion: 1,
			target,
			precedingNeighborCount: 2,
			neighbors: [
				source.index!.blocks[0],
				source.index!.blocks[1],
				source.index!.blocks[3],
				source.index!.blocks[4],
			],
		});
		expect(routeRace.closedPaths.some((path) => samePath(path, join(root, source.entry.rawPath)))).toBe(true);
		expect(routeRace.closedPaths.some((path) => samePath(path, evidencePath(id)))).toBe(true);
	});

	it("returns only canonical block fields from a persisted evidence index", async () => {
		const id = "l2src_sanitized_blocks";
		const text = "Evidence block.";
		const source = addSource({ id, bytes: text, indexText: text });
		writeFileSync(evidencePath(id), `${JSON.stringify({
			...source.index!,
			blocks: source.index!.blocks.map((block) => ({
				...block,
				absolutePath: join(root, "private.txt"),
				unrelated: "private metadata",
			})),
		})}\n`, "utf8");

		const response = await request(
			"GET",
			`/api/l2/sources/${id}/evidence?blockId=${encodeURIComponent(source.index!.blocks[0].id)}`,
			{ revision: source.revision },
		);
		const responseText = await response.text();
		const body = JSON.parse(responseText) as { target: Record<string, unknown> };

		expect(response.status).toBe(200);
		expect(body.target).not.toHaveProperty("absolutePath");
		expect(body.target).not.toHaveProperty("unrelated");
		expect(responseText).not.toContain(root);
	});

	it("settles a backpressured content stream and closes its handle when the client disconnects", async () => {
		const id = "l2src_disconnected_stream";
		const source = addSource({ id, bytes: Buffer.alloc(128 * 1024, "x") });
		const rawAbsolutePath = join(root, source.entry.rawPath);
		const req = controlledRequest({ "if-match": `"${source.revision}"` });
		const res = new ControlledResponse();
		res.backpressured = true;
		const handling = handleL2SourceRoutes(
			req,
			res as unknown as ServerResponse,
			"GET",
			`/api/l2/sources/${id}/content`,
			{ l2DataDir: root },
		);

		await res.firstWrite;
		res.destroyed = true;
		res.emit("close");
		const outcome = await Promise.race([
			handling.then(() => "settled" as const),
			new Promise<"pending">((resolvePending) => setTimeout(() => resolvePending("pending"), 250)),
		]);
		if (outcome === "pending") {
			res.backpressured = false;
			res.emit("drain");
		}
		await handling;

		expect([
			outcome,
			res.writableEnded,
			routeRace.closedPaths.length,
		]).toEqual(["settled", true, 1]);
		expect(routeRace.closedPaths.some((path) => samePath(path, rawAbsolutePath))).toBe(true);
	});

	it("closes the connection after rejecting an oversized locate body", async () => {
		const revision = `sha256:${"0".repeat(64)}`;
		const req = controlledRequest({
			"if-match": `"${revision}"`,
			"content-length": String(DEFAULT_MAX_BODY_BYTES + 1),
		});
		const res = new ControlledResponse();

		const handled = await handleL2SourceRoutes(
			req,
			res as unknown as ServerResponse,
			"POST",
			"/api/l2/sources/l2src_oversized/locate",
			{ l2DataDir: root },
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(413);
		expect(res.getHeader("connection")).toBe("close");
		expect(JSON.parse(res.bodyText())).toMatchObject({ code: "request_too_large" });
	});

	it("distinguishes zero, one, and multiple quote locations", async () => {
		const id = "l2src_locate";
		const text = [
			"Unique alpha phrase.",
			"Shared beta phrase in the first block.",
			"Shared beta phrase in the second block.",
		].join("\n\n");
		const source = addSource({ id, bytes: text, indexText: text });
		const locate = async (quote: string): Promise<Response> => request(
			"POST",
			`/api/l2/sources/${id}/locate`,
			{
				revision: source.revision,
				body: { quote, sourceRevision: source.revision, indexVersion: 1 },
			},
		);

		const none = await locate("not in the source");
		expect(none.status).toBe(200);
		expect(await none.json()).toEqual({
			matches: [],
			fallbackLocator: {
				kind: "markdown-block",
				block_id: source.index!.blocks[0].id,
				paragraph: 1,
			},
		});

		const one = await locate("Unique alpha");
		expect(one.status).toBe(200);
		expect(one.headers.get("etag")).toBe(`"${source.revision}"`);
		expect((await one.json() as { matches: unknown[] }).matches).toHaveLength(1);

		const many = await locate("Shared beta phrase");
		expect(many.status).toBe(200);
		expect((await many.json() as { matches: unknown[] }).matches).toHaveLength(2);
	});

	it("treats repeated occurrences inside one block as ambiguous", async () => {
		const id = "l2src_locate_repeated";
		const text = "Repeated beta phrase appears once, then Repeated beta phrase appears twice.";
		const source = addSource({ id, bytes: text, indexText: text });
		const response = await request(
			"POST",
			`/api/l2/sources/${id}/locate`,
			{
				revision: source.revision,
				body: { quote: "Repeated beta phrase", sourceRevision: source.revision, indexVersion: 1 },
			},
		);

		expect(response.status).toBe(200);
		const payload = await response.json() as {
			matches: Array<{ locator: unknown; occurrence?: number; occurrenceCount?: number }>;
		};
		expect(payload.matches).toHaveLength(2);
		expect(payload.matches.map((match) => match.occurrence)).toEqual([1, 2]);
		expect(payload.matches.every((match) => match.occurrenceCount === 2)).toBe(true);
	});

	it.each(["   \n\t", "x".repeat(501)])("rejects an invalid locate quote without echoing it", async (quote) => {
		const id = "l2src_invalid_quote";
		const source = addSource({ id, bytes: "Evidence.", indexText: "Evidence." });

		const response = await request("POST", `/api/l2/sources/${id}/locate`, {
			revision: source.revision,
			body: { quote, sourceRevision: source.revision, indexVersion: 1 },
		});
		const responseText = await response.text();
		expect(response.status).toBe(400);
		expect(JSON.parse(responseText)).toMatchObject({ code: "invalid_request" });
		expect(responseText).not.toContain(quote);
	});

	it("rejects an unknown block and reports corrupt, stale, and incompatible indexes", async () => {
		const id = "l2src_index_states";
		const text = "Evidence block.";
		const source = addSource({ id, bytes: text, indexText: text });
		const requestEvidence = (): Promise<Response> => request(
			"GET",
			`/api/l2/sources/${id}/evidence?blockId=unknown-block`,
			{ revision: source.revision },
		);

		const unknownBlock = await requestEvidence();
		expect(unknownBlock.status).toBe(422);
		expect(await unknownBlock.json()).toMatchObject({ code: "invalid_block_id" });

		writeFileSync(evidencePath(id), "{not-json", "utf8");
		const corrupt = await requestEvidence();
		expect(corrupt.status).toBe(409);
		expect(await corrupt.json()).toMatchObject({ code: "evidence_index_corrupt" });

		writeFileSync(evidencePath(id), `${JSON.stringify({
			...source.index!,
			raw_content_hash: "a".repeat(64),
		})}\n`, "utf8");
		const stale = await requestEvidence();
		expect(stale.status).toBe(409);
		expect(await stale.json()).toMatchObject({ code: "source_revision_conflict" });

		writeFileSync(evidencePath(id), `${JSON.stringify({ ...source.index!, version: 2 })}\n`, "utf8");
		const incompatible = await requestEvidence();
		expect(incompatible.status).toBe(409);
		expect(await incompatible.json()).toMatchObject({ code: "index_version_conflict" });
	});

	it("returns stable conflicts for body revision and index version without echoing quote or paths", async () => {
		const id = "l2src_conflict";
		const text = "Private quote value.";
		const source = addSource({ id, bytes: text, indexText: text });
		const otherRevision = `sha256:${"a".repeat(64)}`;

		const revisionConflict = await request("POST", `/api/l2/sources/${id}/locate`, {
			revision: source.revision,
			body: { quote: text, sourceRevision: otherRevision, indexVersion: 1 },
		});
		const revisionText = await revisionConflict.text();
		expect(revisionConflict.status).toBe(409);
		expect(JSON.parse(revisionText)).toMatchObject({ code: "source_revision_conflict" });
		expect(revisionText).not.toContain(text);
		expect(revisionText).not.toContain(root);

		const versionConflict = await request("POST", `/api/l2/sources/${id}/locate`, {
			revision: source.revision,
			body: { quote: text, sourceRevision: source.revision, indexVersion: 2 },
		});
		expect(versionConflict.status).toBe(409);
		expect(await versionConflict.json()).toMatchObject({ code: "index_version_conflict" });
	});

	it("returns 412 when the current raw no longer matches If-Match", async () => {
		const id = "l2src_stale";
		const source = addSource({ id, bytes: "original" });
		writeFileSync(join(root, source.entry.rawPath), "changed", "utf8");

		const response = await request("GET", `/api/l2/sources/${id}/content`, { revision: source.revision });
		const responseText = await response.text();
		expect(response.status).toBe(412);
		expect(JSON.parse(responseText)).toMatchObject({ code: "source_revision_mismatch" });
		expect(responseText).not.toContain(root);

		const head = await request("HEAD", `/api/l2/sources/${id}/content`, { revision: source.revision });
		expect(head.status).toBe(412);
	});

	it("returns 412 for stale evidence and locate requests without echoing the quote", async () => {
		const id = "l2src_stale_evidence";
		const quote = "Private quote value.";
		const source = addSource({ id, bytes: quote, indexText: quote });
		writeFileSync(join(root, source.entry.rawPath), "changed", "utf8");

		const evidence = await request(
			"GET",
			`/api/l2/sources/${id}/evidence?blockId=${encodeURIComponent(source.index!.blocks[0].id)}`,
			{ revision: source.revision },
		);
		expect(evidence.status).toBe(412);
		expect(await evidence.json()).toMatchObject({ code: "source_revision_mismatch" });

		const locate = await request("POST", `/api/l2/sources/${id}/locate`, {
			revision: source.revision,
			body: { quote, sourceRevision: source.revision, indexVersion: 1 },
		});
		const locateText = await locate.text();
		expect(locate.status).toBe(412);
		expect(JSON.parse(locateText)).toMatchObject({ code: "source_revision_mismatch" });
		expect(locateText).not.toContain(quote);
		expect(locateText).not.toContain(root);
	});

	it("returns 412 when the raw pathname changes while opening its evidence index", async () => {
		const id = "l2src_changed_before_index";
		const original = "Evidence.";
		const source = addSource({ id, bytes: original, indexText: original });
		const rawPath = join(root, source.entry.rawPath);
		const relocatedPath = join(root, "raw", "uploads", `${id}-relocated.md`);
		const indexPath = evidencePath(id);
		routeRace.beforeOpen = (openedPath) => {
			if (!samePath(openedPath, indexPath)) return;
			routeRace.beforeOpen = undefined;
			renameSync(rawPath, relocatedPath);
			writeFileSync(rawPath, original, "utf8");
		};

		const response = await request(
			"GET",
			`/api/l2/sources/${id}/evidence?blockId=${encodeURIComponent(source.index!.blocks[0].id)}`,
			{ revision: source.revision },
		);
		const responseText = await response.text();
		expect(response.status).toBe(412);
		expect(JSON.parse(responseText)).toMatchObject({ code: "source_revision_mismatch" });
		expect(responseText).not.toContain(root);
	});

	it("does not accept disk paths through query parameters or locate bodies", async () => {
		const id = "l2src_no_paths";
		const source = addSource({ id, bytes: "Evidence.", indexText: "Evidence." });
		const blockId = source.index!.blocks[0].id;

		const content = await request("GET", `/api/l2/sources/${id}/content?path=manifest.jsonl`, {
			revision: source.revision,
		});
		expect(content.status).toBe(400);
		expect(await content.json()).toMatchObject({ code: "invalid_request" });

		const evidence = await request(
			"GET",
			`/api/l2/sources/${id}/evidence?blockId=${encodeURIComponent(blockId)}&path=manifest.jsonl`,
			{ revision: source.revision },
		);
		expect(evidence.status).toBe(400);
		expect(await evidence.json()).toMatchObject({ code: "invalid_request" });

		const locate = await request("POST", `/api/l2/sources/${id}/locate`, {
			revision: source.revision,
			body: {
				quote: "Evidence",
				sourceRevision: source.revision,
				indexVersion: 1,
				path: "manifest.jsonl",
			},
		});
		expect(locate.status).toBe(400);
		expect(await locate.json()).toMatchObject({ code: "invalid_request" });
	});

	it("keeps content available when the evidence index is missing", async () => {
		const id = "l2src_missing_index";
		const source = addSource({ id, bytes: "Raw remains available." });

		const content = await request("GET", `/api/l2/sources/${id}/content`, { revision: source.revision });
		expect(content.status).toBe(200);
		expect(await content.text()).toBe("Raw remains available.");

		const evidence = await request("GET", `/api/l2/sources/${id}/evidence?blockId=missing`, {
			revision: source.revision,
		});
		expect(evidence.status).toBe(404);
		expect(await evidence.json()).toMatchObject({ code: "evidence_index_missing" });
	});

	it("keeps raw content available when the evidence directory is unsafe", async () => {
		const id = "l2src_unsafe_index";
		const bytes = "Raw remains trusted.";
		const source = addSource({ id, bytes, indexText: bytes });
		const byIdPath = join(root, "extracted", "evidence", "by-id");
		const savedByIdPath = `${byIdPath}-saved`;
		const outside = mkdtempSync(join(tmpdir(), "inno-l2-source-index-outside-"));
		renameSync(byIdPath, savedByIdPath);
		symlinkSync(outside, byIdPath, process.platform === "win32" ? "junction" : "dir");

		try {
			const content = await request("GET", `/api/l2/sources/${id}/content`, { revision: source.revision });
			expect(content.status).toBe(200);
			expect(await content.text()).toBe(bytes);

			const evidence = await request(
				"GET",
				`/api/l2/sources/${id}/evidence?blockId=${encodeURIComponent(source.index!.blocks[0].id)}`,
				{ revision: source.revision },
			);
			expect(evidence.status).toBe(409);
			expect(await evidence.json()).toMatchObject({ code: "evidence_index_corrupt" });
		} finally {
			rmSync(byIdPath, { recursive: true, force: true });
			renameSync(savedByIdPath, byIdPath);
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("distinguishes an unknown source from a missing source file", async () => {
		const revision = `sha256:${"0".repeat(64)}`;
		const unknown = await request("GET", "/api/l2/sources/l2src_unknown/content", { revision });
		expect(unknown.status).toBe(404);
		expect(await unknown.json()).toMatchObject({ code: "source_not_found" });

		const id = "l2src_missing_file";
		upsertManifest(root, manifest(id, `raw/uploads/${id}.md`, "markdown"));
		const missing = await request("GET", `/api/l2/sources/${id}/content`, { revision });
		expect(missing.status).toBe(404);
		expect(await missing.json()).toMatchObject({ code: "source_file_not_found" });
	});
});
