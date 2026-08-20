import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";

import {
	normalizeEvidenceTextForQuoteMatching,
	type EvidenceBlock,
	type SourceEvidenceIndex,
} from "../../memory/l2/evidence-index.js";
import type { EvidenceLocator } from "../../memory/l2/evidence-types.js";
import {
	openSourceById,
	readEvidenceIndexForSource,
	readSourceBytes,
	SourceAccessError,
	type OpenedSource,
} from "../../memory/l2/source-access.js";
import { HttpError, json, readBody } from "../http-helpers.js";

export interface L2SourceRouteContext {
	l2DataDir: string;
}

const STRONG_SOURCE_ETAG = /^"(sha256:[0-9a-f]{64})"$/u;
const SHA256_REVISION = /^sha256:[0-9a-f]{64}$/u;
const MAX_QUOTE_CODE_POINTS = 500;
const EVIDENCE_NEIGHBOR_RADIUS = 2;

interface SourceRouteMatch {
	sourceId: string;
	action: "content" | "evidence" | "locate";
	url: URL;
}

interface ByteRange {
	start: number;
	end: number;
}

function sourceError(
	res: ServerResponse,
	status: number,
	error: string,
	code: string,
	details?: unknown,
): void {
	json(res, status, { error, code, ...(details === undefined ? {} : { details }) });
}

function routeMatch(url: string): SourceRouteMatch | null {
	let parsed: URL;
	try {
		parsed = new URL(url, "http://localhost");
	} catch {
		return null;
	}
	const match = parsed.pathname.match(/^\/api\/l2\/sources\/([^/]+)\/(content|evidence|locate)$/u);
	if (!match) return null;
	let sourceId: string;
	try {
		sourceId = decodeURIComponent(match[1]);
	} catch {
		sourceId = "";
	}
	return { sourceId, action: match[2] as SourceRouteMatch["action"], url: parsed };
}

function parseIfMatch(req: HttpReq, res: ServerResponse): string | null {
	const value = req.headers["if-match"];
	if (value === undefined) {
		sourceError(res, 428, "If-Match header is required", "if_match_required");
		return null;
	}
	if (Array.isArray(value)) {
		sourceError(res, 400, "Invalid If-Match header", "invalid_if_match");
		return null;
	}
	const match = STRONG_SOURCE_ETAG.exec(value);
	if (!match) {
		sourceError(res, 400, "Invalid If-Match header", "invalid_if_match");
		return null;
	}
	return match[1];
}

function sendAccessError(res: ServerResponse, error: unknown): void {
	if (!(error instanceof SourceAccessError)) {
		sourceError(res, 500, "Failed to open source", "source_access_failed");
		return;
	}
	switch (error.code) {
		case "source_not_found":
			sourceError(res, 404, "Source not found", error.code);
			return;
		case "source_file_not_found":
			sourceError(res, 404, "Source file not found", error.code);
			return;
		case "source_file_unavailable":
			sourceError(res, 404, "Source file unavailable", error.code);
			return;
		case "source_revision_mismatch":
		case "source_changed":
			sourceError(res, 412, "Source revision does not match", "source_revision_mismatch");
			return;
		case "source_too_large":
			sourceError(res, 413, "Source file is too large", error.code);
	}
}

function setRevisionHeaders(res: ServerResponse, sourceRevision: string): void {
	res.setHeader("ETag", `"${sourceRevision}"`);
	res.setHeader("X-Content-Type-Options", "nosniff");
}

function safeContentDisposition(opened: OpenedSource): string {
	const disposition = opened.entry.sourceType === "word"
		|| opened.mimeType === "application/octet-stream"
		? "attachment"
		: "inline";
	const ascii = opened.displayName
		.replace(/[^\x20-\x7e]/gu, "_")
		.replace(/["\\]/gu, "_")
		.slice(0, 180) || "source";
	const encoded = encodeURIComponent(opened.displayName).replace(/[!'()*]/gu, (character) => (
		`%${character.charCodeAt(0).toString(16).toUpperCase()}`
	));
	return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function parseByteRange(value: string, size: number): ByteRange | null {
	if (value.includes(",")) return null;
	const match = value.match(/^bytes=(\d*)-(\d*)$/u);
	if (!match || (!match[1] && !match[2]) || size <= 0) return null;
	if (!match[1]) {
		const suffix = Number(match[2]);
		if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
		return { start: Math.max(0, size - suffix), end: size - 1 };
	}
	const start = Number(match[1]);
	const requestedEnd = match[2] ? Number(match[2]) : size - 1;
	if (
		!Number.isSafeInteger(start)
		|| !Number.isSafeInteger(requestedEnd)
		|| start < 0
		|| requestedEnd < start
		|| start >= size
	) {
		return null;
	}
	return { start, end: Math.min(requestedEnd, size - 1) };
}

async function writeBufferedBytes(
	bytes: Buffer,
	res: ServerResponse,
): Promise<void> {
	const waitForDrainOrClose = (): Promise<void> => new Promise((resolve, reject) => {
		const cleanup = (): void => {
			res.removeListener("drain", onDrain);
			res.removeListener("close", onClose);
			res.removeListener("error", onError);
		};
		const onDrain = (): void => {
			cleanup();
			resolve();
		};
		const onClose = (): void => {
			cleanup();
			reject(new SourceAccessError("source_changed"));
		};
		const onError = (): void => {
			cleanup();
			reject(new SourceAccessError("source_changed"));
		};
		res.once("drain", onDrain);
		res.once("close", onClose);
		res.once("error", onError);
		if (res.destroyed || res.writableEnded) onClose();
	});

	let offset = 0;
	while (offset < bytes.length) {
		const nextOffset = Math.min(offset + 64 * 1024, bytes.length);
		if (!res.write(bytes.subarray(offset, nextOffset))) await waitForDrainOrClose();
		offset = nextOffset;
	}
	res.end();
}

async function readReadyIndex(
	res: ServerResponse,
	l2DataDir: string,
	opened: OpenedSource,
): Promise<SourceEvidenceIndex | null> {
	let result;
	try {
		result = await readEvidenceIndexForSource(l2DataDir, opened);
	} catch (error) {
		sendAccessError(res, error);
		return null;
	}
	if (result.status === "ready") return result.index;
	if (result.status === "missing-index") {
		sourceError(res, 404, "Evidence index not found", "evidence_index_missing");
		return null;
	}
	if (result.status === "corrupt-index") {
		sourceError(res, 409, "Evidence index is unavailable", "evidence_index_corrupt");
		return null;
	}
	if (result.status === "stale-source") {
		sourceError(res, 409, "Evidence source revision conflicts", "source_revision_conflict");
		return null;
	}
	sourceError(res, 409, "Evidence index version conflicts", "index_version_conflict");
	return null;
}

function locatorForBlock(block: EvidenceBlock): EvidenceLocator {
	if (block.kind === "pdf") {
		return { kind: "pdf-page", page: block.page!, block_id: block.id };
	}
	if (block.kind === "markdown") {
		return {
			kind: "markdown-block",
			block_id: block.id,
			...(block.heading === undefined ? {} : { heading: block.heading }),
			paragraph: block.paragraph!,
		};
	}
	return {
		kind: "docx-paragraph",
		block_id: block.id,
		...(block.heading === undefined ? {} : { heading: block.heading }),
		paragraph: block.paragraph!,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(value).sort();
	const sorted = [...expected].sort();
	return keys.length === sorted.length && keys.every((key, index) => key === sorted[index]);
}

function validQuote(quote: string): boolean {
	if (normalizeEvidenceTextForQuoteMatching(quote).length === 0) return false;
	let count = 0;
	for (const _codePoint of quote) {
		count += 1;
		if (count > MAX_QUOTE_CODE_POINTS) return false;
	}
	return true;
}

function countQuoteOccurrences(text: string, quote: string): number {
	if (quote.length === 0) return 0;
	let count = 0;
	let offset = 0;
	while (offset <= text.length - quote.length) {
		const match = text.indexOf(quote, offset);
		if (match < 0) break;
		count += 1;
		// Count overlapping occurrences too; the resolver uses the same
		// definition when deciding whether a quote is unique.
		offset = match + 1;
	}
	return count;
}

async function handleContent(
	req: HttpReq,
	res: ServerResponse,
	method: "GET" | "HEAD",
	match: SourceRouteMatch,
	l2DataDir: string,
	revision: string,
): Promise<void> {
	if ([...match.url.searchParams.keys()].length > 0) {
		sourceError(res, 400, "Invalid source content request", "invalid_request");
		return;
	}
	let opened: OpenedSource;
	try {
		opened = await openSourceById(l2DataDir, match.sourceId, revision);
	} catch (error) {
		sendAccessError(res, error);
		return;
	}

	try {
		const size = opened.stat.size;
		const rangeHeader = method === "GET" ? req.headers.range : undefined;
		let range: ByteRange | undefined;
		if (rangeHeader !== undefined) {
			if (Array.isArray(rangeHeader) || opened.entry.sourceType !== "pdf") {
				res.setHeader("Content-Range", `bytes */${size}`);
				sourceError(res, 416, "Range is not satisfiable", "range_not_satisfiable");
				return;
			}
			const parsed = parseByteRange(rangeHeader, size);
			if (parsed === null) {
				res.setHeader("Content-Range", `bytes */${size}`);
				sourceError(res, 416, "Range is not satisfiable", "range_not_satisfiable");
				return;
			}
			range = parsed;
		}

		const start = range?.start ?? 0;
		const end = range?.end ?? Math.max(0, size - 1);
		const contentLength = range === undefined ? size : end - start + 1;
		const contentBytes = method === "GET"
			? await readSourceBytes(opened, start, contentLength)
			: undefined;
		setRevisionHeaders(res, opened.sourceRevision);
		const headers: Record<string, string | number> = {
			"Content-Type": opened.mimeType,
			"Content-Length": contentLength,
			"Content-Disposition": safeContentDisposition(opened),
		};
		if (opened.entry.sourceType === "pdf") headers["Accept-Ranges"] = "bytes";
		if (range !== undefined) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
		res.writeHead(range === undefined ? 200 : 206, headers);
		if (contentBytes === undefined || contentBytes.length === 0) {
			res.end();
			return;
		}
		await writeBufferedBytes(contentBytes, res);
	} catch (error) {
		if (!res.headersSent) sendAccessError(res, error);
		else if (!res.writableEnded) res.end();
	} finally {
		await opened.handle.close().catch(() => undefined);
	}
}

async function handleEvidence(
	res: ServerResponse,
	match: SourceRouteMatch,
	l2DataDir: string,
	revision: string,
): Promise<void> {
	const keys = [...match.url.searchParams.keys()];
	const blockIds = match.url.searchParams.getAll("blockId");
	if (keys.length !== 1 || keys[0] !== "blockId" || blockIds.length !== 1 || blockIds[0].length === 0) {
		sourceError(res, 400, "Invalid evidence request", "invalid_request");
		return;
	}
	let opened: OpenedSource;
	try {
		opened = await openSourceById(l2DataDir, match.sourceId, revision);
	} catch (error) {
		sendAccessError(res, error);
		return;
	}
	try {
		const index = await readReadyIndex(res, l2DataDir, opened);
		if (index === null) return;
		const targetIndex = index.blocks.findIndex((block) => block.id === blockIds[0]);
		if (targetIndex < 0) {
			sourceError(res, 422, "Evidence block is invalid", "invalid_block_id");
			return;
		}
		const before = index.blocks.slice(Math.max(0, targetIndex - EVIDENCE_NEIGHBOR_RADIUS), targetIndex);
		const after = index.blocks.slice(targetIndex + 1, targetIndex + 1 + EVIDENCE_NEIGHBOR_RADIUS);
		setRevisionHeaders(res, opened.sourceRevision);
		json(res, 200, {
			sourceId: match.sourceId,
			sourceRevision: opened.sourceRevision,
			indexVersion: 1,
			target: index.blocks[targetIndex],
			precedingNeighborCount: before.length,
			neighbors: [...before, ...after],
		});
	} finally {
		await opened.handle.close().catch(() => undefined);
	}
}

async function handleLocate(
	req: HttpReq,
	res: ServerResponse,
	match: SourceRouteMatch,
	l2DataDir: string,
	headerRevision: string,
): Promise<void> {
	if ([...match.url.searchParams.keys()].length > 0) {
		sourceError(res, 400, "Invalid locate request", "invalid_request");
		return;
	}
	let body: unknown;
	try {
		body = await readBody(req);
	} catch (error) {
		if (error instanceof HttpError) {
			if (error.statusCode === 413) res.setHeader("Connection", "close");
			sourceError(res, error.statusCode, error.message, error.statusCode === 413 ? "request_too_large" : "invalid_request");
			return;
		}
		throw error;
	}
	if (
		!isRecord(body)
		|| !exactKeys(body, ["quote", "sourceRevision", "indexVersion"])
		|| typeof body.quote !== "string"
		|| !validQuote(body.quote)
		|| typeof body.sourceRevision !== "string"
		|| !SHA256_REVISION.test(body.sourceRevision)
		|| typeof body.indexVersion !== "number"
		|| !Number.isSafeInteger(body.indexVersion)
	) {
		sourceError(res, 400, "Invalid locate request", "invalid_request");
		return;
	}
	if (body.sourceRevision !== headerRevision) {
		sourceError(res, 409, "Source revision conflicts", "source_revision_conflict");
		return;
	}
	if (body.indexVersion !== 1) {
		sourceError(res, 409, "Evidence index version conflicts", "index_version_conflict");
		return;
	}

	let opened: OpenedSource;
	try {
		opened = await openSourceById(l2DataDir, match.sourceId, headerRevision);
	} catch (error) {
		sendAccessError(res, error);
		return;
	}
	try {
		const index = await readReadyIndex(res, l2DataDir, opened);
		if (index === null) return;
		const quote = normalizeEvidenceTextForQuoteMatching(body.quote);
		const matches = index.blocks.flatMap((block) => {
			const occurrenceCount = countQuoteOccurrences(
				normalizeEvidenceTextForQuoteMatching(block.text),
				quote,
			);
			if (occurrenceCount <= 0) return [];
			const locator = locatorForBlock(block);
			if (occurrenceCount === 1) return [{ locator }];
			return Array.from({ length: occurrenceCount }, (_, index) => ({
				locator,
				occurrence: index + 1,
				occurrenceCount,
			}));
		});
		const fallbackLocator = index.blocks[0] === undefined ? undefined : locatorForBlock(index.blocks[0]);
		setRevisionHeaders(res, opened.sourceRevision);
		json(res, 200, {
			matches,
			...(fallbackLocator === undefined ? {} : { fallbackLocator }),
		});
	} finally {
		await opened.handle.close().catch(() => undefined);
	}
}

/** Handle source-ID-only raw content, evidence slice, and quote location APIs. */
export async function handleL2SourceRoutes(
	req: HttpReq,
	res: ServerResponse,
	method: string,
	url: string,
	ctx: L2SourceRouteContext,
): Promise<boolean> {
	const match = routeMatch(url);
	if (match === null) return false;
	if (
		(method !== "GET" && method !== "HEAD" && method !== "POST")
		|| (match.action === "content" && method !== "GET" && method !== "HEAD")
		|| (match.action === "evidence" && method !== "GET")
		|| (match.action === "locate" && method !== "POST")
	) {
		return false;
	}
	if (match.sourceId.trim().length === 0) {
		sourceError(res, 400, "Invalid source ID", "invalid_source_id");
		return true;
	}
	const revision = parseIfMatch(req, res);
	if (revision === null) return true;

	if (match.action === "content") {
		await handleContent(req, res, method as "GET" | "HEAD", match, ctx.l2DataDir, revision);
	} else if (match.action === "evidence") {
		await handleEvidence(res, match, ctx.l2DataDir, revision);
	} else {
		await handleLocate(req, res, match, ctx.l2DataDir, revision);
	}
	return true;
}
