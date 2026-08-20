import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const l2Memory = vi.hoisted(() => ({
	indexPageByPath: vi.fn(async (_path: string): Promise<void> => undefined),
	removePage: vi.fn(async (_path: string): Promise<void> => undefined),
}));
const fsFault = vi.hoisted(() => ({
	failWikiRename: false,
	afterWikiTempClose: undefined as ((path: string) => void) | undefined,
	descriptorPaths: new Map<number, string>(),
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		openSync(path: string, flags: string | number, mode?: number): number {
			const descriptor = actual.openSync(path, flags, mode);
			fsFault.descriptorPaths.set(descriptor, path);
			return descriptor;
		},
		closeSync(descriptor: number): void {
			const path = fsFault.descriptorPaths.get(descriptor);
			try {
				actual.closeSync(descriptor);
			} finally {
				fsFault.descriptorPaths.delete(descriptor);
			}
			if (path && /[\\/]wiki[\\/]concepts[\\/]\.page\.md\..*\.tmp$/u.test(path)) {
				fsFault.afterWikiTempClose?.(path);
			}
		},
		renameSync(oldPath: string, newPath: string): void {
			if (fsFault.failWikiRename && newPath.endsWith(join("wiki", "concepts", "page.md"))) {
				throw new Error("injected Wiki rename failure");
			}
			actual.renameSync(oldPath, newPath);
		},
	};
});

vi.mock("../../memory/l2/l2-memory.js", () => ({
	getL2Memory: () => l2Memory,
}));

import {
	buildEvidenceIndex,
	type EvidenceBlock,
	writeEvidenceIndexAtomic,
} from "../../memory/l2/evidence-index.js";
import type { EvidenceRef } from "../../memory/l2/evidence-types.js";
import type { EvidenceCandidateSelector } from "../../memory/l2/evidence-selector.js";
import { readManifest, upsertManifest } from "../../memory/l2/manifest-store.js";
import type { ManifestEntry, WikiPageFrontmatter } from "../../memory/l2/types.js";
import {
	bodyRevision,
	fileRevision,
	serializeFrontmatter,
} from "../../memory/l2/wiki-maintainer.js";
import { handleWikiRoutes } from "./wiki.js";
import { DEFAULT_MAX_BODY_BYTES } from "../http-helpers.js";

let root: string;
let server: Server;
let baseUrl: string;
let routeSelector: EvidenceCandidateSelector | null | undefined;

function hash(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

function makeRoot(): string {
	const directory = mkdtempSync(join(tmpdir(), "inno-wiki-route-"));
	for (const category of ["sources", "entities", "concepts", "analysis"]) {
		mkdirSync(join(directory, "wiki", category), { recursive: true });
	}
	return directory;
}

function pageContent(
	sourceIds: string[],
	sources: string[],
	evidenceRefs: unknown,
	body: string,
): string {
	const frontmatter: WikiPageFrontmatter = {
		title: "Page",
		created: "2026-08-16",
		type: "concept",
		tags: ["learning-content"],
		sources,
		source_ids: sourceIds,
		updated: "2026-08-16",
		status: "draft",
		confidence: "medium",
		...(evidenceRefs === undefined ? {} : { evidence_refs: evidenceRefs as unknown[] }),
	};
	return `${serializeFrontmatter(frontmatter)}\n${body}`;
}

function createSource(id: string, text = "# Topic\n\nAlpha evidence.\n"): {
	entry: ManifestEntry;
	block: EvidenceBlock;
} {
	const rawPath = `raw/uploads/${id}.md`;
	const rawAbsolutePath = join(root, rawPath);
	mkdirSync(join(root, "raw", "uploads"), { recursive: true });
	writeFileSync(rawAbsolutePath, text, "utf8");
	const rawContentHash = hash(text);
	const stats = statSync(rawAbsolutePath);
	const entry: ManifestEntry = {
		id,
		title: "Source",
		sourceType: "markdown",
		rawPath,
		wikiPages: [],
		tags: [],
		contentHash: "legacy",
		rawContentHash,
		rawSize: stats.size,
		rawMtimeMs: stats.mtimeMs,
		rawKind: "uploaded-original",
		status: "indexed",
		source: { origin: "user_upload" },
		createdAt: "2026-08-16T00:00:00.000Z",
		updatedAt: "2026-08-16T00:00:00.000Z",
	};
	upsertManifest(root, entry);
	const index = buildEvidenceIndex({
		sourceId: id,
		sourceType: "markdown",
		rawContentHash,
		parsed: { text, pageCount: 1, pages: [{ pageNumber: 1, text }] },
	});
	writeEvidenceIndexAtomic(root, index);
	const block = index.blocks.find((candidate) => candidate.text.includes("Alpha evidence"));
	if (!block) throw new Error("Expected an evidence block.");
	return { entry, block };
}

function evidenceReference(
	entry: ManifestEntry,
	block: EvidenceBlock,
	body: string,
	selectedBy: "model" | "user" = "model",
): EvidenceRef {
	return {
		source_id: entry.id,
		quote: block.text,
		source_revision: `sha256:${entry.rawContentHash}`,
		page_revision: bodyRevision(body),
		index_version: 1,
		selected_by: selectedBy,
		locator: {
			kind: "markdown-block",
			block_id: block.id,
			...(block.heading === undefined ? {} : { heading: block.heading }),
			paragraph: block.paragraph!,
		},
	};
}

async function startServer(): Promise<void> {
	server = createServer((request, response) => {
		void handleWikiRoutes(
			request,
			response,
			request.method ?? "GET",
			request.url ?? "/",
			{ l2DataDir: root, evidenceSelector: routeSelector },
		).then((handled) => {
			if (!handled && !response.writableEnded) {
				response.writeHead(404, { "Content-Type": "application/json" });
				response.end(JSON.stringify({ error: "not found" }));
			}
		}).catch((error: unknown) => {
			if (!response.writableEnded) {
				response.writeHead(500, { "Content-Type": "application/json" });
				response.end(JSON.stringify({ error: error instanceof Error ? error.message : "route failed" }));
			}
		});
	});
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function request(
	method: "GET" | "PUT" | "POST" | "DELETE",
	path: string,
	body?: unknown,
): Promise<Response> {
	return fetch(`${baseUrl}${path}`, {
		method,
		...(body === undefined ? {} : {
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
	});
}

beforeEach(async () => {
	root = makeRoot();
	fsFault.failWikiRename = false;
	fsFault.afterWikiTempClose = undefined;
	fsFault.descriptorPaths.clear();
	routeSelector = undefined;
	l2Memory.indexPageByPath.mockClear();
	l2Memory.removePage.mockClear();
	await startServer();
});

afterEach(async () => {
	await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
	rmSync(root, { recursive: true, force: true });
});

describe("Wiki page routes", () => {
	it("GET returns the complete read-only WikiPageDetail", async () => {
		const wikiPath = "wiki/concepts/page.md";
		const content = pageContent([], [], undefined, "# Body\n\nClaim.\n");
		writeFileSync(join(root, wikiPath), content, "utf8");

		const response = await request("GET", `/api/wiki/page?path=${encodeURIComponent(wikiPath)}`);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			path: wikiPath,
			content,
			pageRevision: bodyRevision("# Body\n\nClaim.\n"),
			fileRevision: fileRevision(Buffer.from(content, "utf8")),
			provenance: { sourceGroups: [], legacyPaths: [], referenceIssues: [] },
		});
	});

	it("GET, PUT, and DELETE reject internal L2 files without changing their bytes", async () => {
		const targets = [
			["raw/uploads/secret.md", "immutable raw"],
			["extracted/evidence/by-id/private.json", "{\"private\":true}\n"],
			["manifest.jsonl", "{\"private\":true}\n"],
			["wiki/index.md", "private index"],
		] as const;
		for (const [relativePath, original] of targets) {
			const absolutePath = join(root, relativePath);
			mkdirSync(join(absolutePath, ".."), { recursive: true });
			writeFileSync(absolutePath, original, "utf8");
			const encoded = encodeURIComponent(relativePath);

			for (const [method, endpoint, body] of [
				["GET", `/api/wiki/page?path=${encoded}`, undefined],
				["PUT", "/api/wiki/page", { path: relativePath, content: "overwritten" }],
				["DELETE", `/api/wiki/page?path=${encoded}`, undefined],
			] as const) {
				const response = await request(method, endpoint, body);
				expect(response.status).toBe(400);
				expect(await response.json()).toEqual({
					error: "Invalid wiki path",
					code: "invalid_wiki_path",
				});
				expect(readFileSync(absolutePath, "utf8")).toBe(original);
			}
		}
		expect(l2Memory.indexPageByPath).not.toHaveBeenCalled();
		expect(l2Memory.removePage).not.toHaveBeenCalled();
	});

	it("PUT allows an ordinary body edit and returns a stale-page reference", async () => {
		const wikiPath = "wiki/concepts/page.md";
		const { entry, block } = createSource("l2src_route");
		const oldBody = "# Page\n\nOld claim.\n";
		const ref = evidenceReference(entry, block, oldBody);
		const oldContent = pageContent([entry.id], [entry.rawPath], [ref], oldBody);
		const newContent = pageContent([entry.id], [entry.rawPath], [ref], "# Page\n\nEdited claim.\n");
		writeFileSync(join(root, wikiPath), oldContent, "utf8");

		const response = await request("PUT", "/api/wiki/page", { path: wikiPath, content: newContent });
		const detail = await response.json() as {
			content: string;
			provenance: { sourceGroups: Array<{ references: Array<{ positionStatus: string }> }> };
		};

		expect(response.status).toBe(200);
		expect(detail.content).toBe(newContent);
		expect(detail.provenance.sourceGroups[0].references[0].positionStatus).toBe("stale-page");
		expect(readFileSync(join(root, wikiPath), "utf8")).toBe(newContent);
		expect(l2Memory.indexPageByPath).toHaveBeenCalledWith(wikiPath);
		expect(readdirSync(join(root, "wiki", "concepts")).filter((name) => name.includes(".tmp"))).toEqual([]);
	});

	it("PUT leaves the old page intact when atomic publication fails", async () => {
		const wikiPath = "wiki/concepts/page.md";
		const oldContent = pageContent([], [], undefined, "Old body\n");
		const newContent = pageContent([], [], undefined, "New body\n");
		writeFileSync(join(root, wikiPath), oldContent, "utf8");
		fsFault.failWikiRename = true;

		const response = await request("PUT", "/api/wiki/page", { path: wikiPath, content: newContent });

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({
			error: "Failed to save wiki page",
			code: "wiki_page_write_failed",
		});
		expect(readFileSync(join(root, wikiPath), "utf8")).toBe(oldContent);
		expect(readdirSync(join(root, "wiki", "concepts"))).toEqual(["page.md"]);
		expect(l2Memory.indexPageByPath).not.toHaveBeenCalled();
	});

	it("PUT does not publish or clean through a parent replaced by a junction", async () => {
		const wikiPath = "wiki/concepts/page.md";
		const pagePath = join(root, wikiPath);
		const concepts = join(root, "wiki", "concepts");
		const relocated = join(root, "relocated-concepts");
		const outside = join(root, "outside");
		const oldContent = pageContent([], [], undefined, "Old body\n");
		const newContent = pageContent([], [], undefined, "New body\n");
		let attackerTemp = "";
		writeFileSync(pagePath, oldContent, "utf8");
		fsFault.afterWikiTempClose = (temporaryPath) => {
			fsFault.afterWikiTempClose = undefined;
			renameSync(concepts, relocated);
			mkdirSync(outside);
			writeFileSync(join(outside, "page.md"), "outside sentinel", "utf8");
			attackerTemp = join(outside, basename(temporaryPath));
			writeFileSync(attackerTemp, "attacker temp", "utf8");
			symlinkSync(outside, concepts, process.platform === "win32" ? "junction" : "dir");
		};

		const response = await request("PUT", "/api/wiki/page", { path: wikiPath, content: newContent });

		expect(response.status).toBe(500);
		expect(readFileSync(join(relocated, "page.md"), "utf8")).toBe(oldContent);
		expect(readFileSync(join(outside, "page.md"), "utf8")).toBe("outside sentinel");
		expect(readFileSync(attackerTemp, "utf8")).toBe("attacker temp");
		expect(l2Memory.indexPageByPath).not.toHaveBeenCalled();
	});

	it("PUT does not publish or unlink a replacement of its owned temp file", async () => {
		const wikiPath = "wiki/concepts/page.md";
		const pagePath = join(root, wikiPath);
		const oldContent = pageContent([], [], undefined, "Old body\n");
		const newContent = pageContent([], [], undefined, "New body\n");
		let replacedTemp = "";
		writeFileSync(pagePath, oldContent, "utf8");
		fsFault.afterWikiTempClose = (temporaryPath) => {
			fsFault.afterWikiTempClose = undefined;
			replacedTemp = temporaryPath;
			unlinkSync(temporaryPath);
			writeFileSync(temporaryPath, "attacker replacement", "utf8");
		};

		const response = await request("PUT", "/api/wiki/page", { path: wikiPath, content: newContent });

		expect(response.status).toBe(500);
		expect(readFileSync(pagePath, "utf8")).toBe(oldContent);
		expect(readFileSync(replacedTemp, "utf8")).toBe("attacker replacement");
		expect(l2Memory.indexPageByPath).not.toHaveBeenCalled();
	});

	it("PUT does not publish or unlink an in-place modification of its owned temp file", async () => {
		const wikiPath = "wiki/concepts/page.md";
		const pagePath = join(root, wikiPath);
		const oldContent = pageContent([], [], undefined, "Old body\n");
		const newContent = pageContent([], [], undefined, "New body\n");
		let modifiedTemp = "";
		writeFileSync(pagePath, oldContent, "utf8");
		fsFault.afterWikiTempClose = (temporaryPath) => {
			fsFault.afterWikiTempClose = undefined;
			modifiedTemp = temporaryPath;
			writeFileSync(temporaryPath, "attacker in-place modification", "utf8");
		};

		const response = await request("PUT", "/api/wiki/page", { path: wikiPath, content: newContent });

		expect(response.status).toBe(500);
		expect(readFileSync(pagePath, "utf8")).toBe(oldContent);
		expect(readFileSync(modifiedTemp, "utf8")).toBe("attacker in-place modification");
		expect(l2Memory.indexPageByPath).not.toHaveBeenCalled();
	});

	it("PUT rejects a changed malformed evidence_refs value and leaves the page byte-identical", async () => {
		const wikiPath = "wiki/concepts/page.md";
		const oldContent = pageContent([], [], undefined, "Body\n");
		const newContent = pageContent([], [], { private: "must not leak" }, "Body\n");
		writeFileSync(join(root, wikiPath), oldContent, "utf8");

		const response = await request("PUT", "/api/wiki/page", { path: wikiPath, content: newContent });
		const responseText = await response.text();

		expect(response.status).toBe(422);
		expect(JSON.parse(responseText)).toEqual({
			error: "Invalid evidence references",
			code: "invalid_evidence_refs",
			details: { issues: [{ ordinal: 0, code: "not-object" }] },
		});
		expect(responseText).not.toContain("must not leak");
		expect(responseText).not.toContain(root);
		expect(readFileSync(join(root, wikiPath), "utf8")).toBe(oldContent);
		expect(l2Memory.indexPageByPath).not.toHaveBeenCalled();
	});

	it("PUT validates evidence_refs when the closing frontmatter delimiter has no trailing newline", async () => {
		const wikiPath = "wiki/concepts/page.md";
		const oldContent = pageContent([], [], undefined, "Body\n");
		const newContent = "---\nevidence_refs: secret\n---Body\n";
		writeFileSync(join(root, wikiPath), oldContent, "utf8");

		const response = await request("PUT", "/api/wiki/page", { path: wikiPath, content: newContent });

		expect(response.status).toBe(422);
		expect(await response.json()).toEqual({
			error: "Invalid evidence references",
			code: "invalid_evidence_refs",
			details: { issues: [{ ordinal: 0, code: "not-object" }] },
		});
		expect(readFileSync(join(root, wikiPath), "utf8")).toBe(oldContent);
		expect(l2Memory.indexPageByPath).not.toHaveBeenCalled();
	});

	it("PUT allows a body edit when the same malformed frontmatter is retained", async () => {
		const wikiPath = "wiki/concepts/page.md";
		const malformedFrontmatter = "---\ntitle: [broken\n---\n";
		const oldContent = `${malformedFrontmatter}Old body\n`;
		const newContent = `${malformedFrontmatter}New body\n`;
		writeFileSync(join(root, wikiPath), oldContent, "utf8");

		const response = await request("PUT", "/api/wiki/page", { path: wikiPath, content: newContent });

		expect(response.status).toBe(200);
		expect(readFileSync(join(root, wikiPath), "utf8")).toBe(newContent);
		expect(l2Memory.indexPageByPath).toHaveBeenCalledWith(wikiPath);
	});

	it("PUT rejects a structurally valid ref whose locator no longer resolves", async () => {
		const wikiPath = "wiki/concepts/page.md";
		const { entry, block } = createSource("l2src_bad_locator");
		const body = "Body\n";
		const originalRef = evidenceReference(entry, block, body);
		const changedRef: EvidenceRef = {
			...originalRef,
			locator: {
				kind: "markdown-block",
				block_id: block.id,
				...(block.heading === undefined ? {} : { heading: block.heading }),
				paragraph: 999,
			},
		};
		const oldContent = pageContent([entry.id], [entry.rawPath], [originalRef], body);
		const newContent = pageContent([entry.id], [entry.rawPath], [changedRef], body);
		writeFileSync(join(root, wikiPath), oldContent, "utf8");

		const response = await request("PUT", "/api/wiki/page", { path: wikiPath, content: newContent });

		expect(response.status).toBe(422);
		expect(await response.json()).toEqual({
			error: "Invalid evidence references",
			code: "invalid_evidence_refs",
			details: { issues: [{ ordinal: 0, sourceId: entry.id, code: "locator-invalid" }] },
		});
		expect(readFileSync(join(root, wikiPath), "utf8")).toBe(oldContent);
		expect(l2Memory.indexPageByPath).not.toHaveBeenCalled();
	});

	it("PUT allows deleting evidence_refs because the prospective page has no invalid reference", async () => {
		const wikiPath = "wiki/concepts/page.md";
		const { entry, block } = createSource("l2src_delete_refs");
		const body = "Body\n";
		const oldContent = pageContent([entry.id], [entry.rawPath], [evidenceReference(entry, block, body)], body);
		const newContent = pageContent([entry.id], [entry.rawPath], [], body);
		writeFileSync(join(root, wikiPath), oldContent, "utf8");

		const response = await request("PUT", "/api/wiki/page", { path: wikiPath, content: newContent });

		expect(response.status).toBe(200);
		expect(readFileSync(join(root, wikiPath), "utf8")).toBe(newContent);
		expect(l2Memory.indexPageByPath).toHaveBeenCalledWith(wikiPath);
	});

	it("evidence actions accept only path and both revisions", async () => {
		const response = await request("POST", "/api/wiki/page/evidence/refresh", {
			path: "wiki/concepts/page.md",
			expectedPageRevision: "sha256:" + "0".repeat(64),
			expectedFileRevision: "sha256:" + "0".repeat(64),
			candidates: [],
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: "Invalid evidence mutation request",
			code: "invalid_request",
		});
	});

	it("evidence actions return structured errors for malformed JSON", async () => {
		const response = await fetch(`${baseUrl}/api/wiki/page/evidence/refresh`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{not-json",
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: "Invalid JSON body",
			code: "invalid_request",
		});
	});

	it("evidence actions return a structured 413 and close oversized requests", async () => {
		const target = new URL(baseUrl);
		const result = await new Promise<{ status: number; connection?: string; body: string }>((resolveResult, rejectResult) => {
			const outgoing = httpRequest({
				hostname: target.hostname,
				port: target.port,
				path: "/api/wiki/page/evidence/refresh",
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Content-Length": String(DEFAULT_MAX_BODY_BYTES + 1),
				},
			}, (incoming) => {
				let body = "";
				incoming.setEncoding("utf8");
				incoming.on("data", (chunk: string) => { body += chunk; });
				incoming.on("end", () => resolveResult({
					status: incoming.statusCode ?? 0,
					connection: incoming.headers.connection,
					body,
				}));
			});
			outgoing.on("error", rejectResult);
			outgoing.end();
		});

		expect(result.status).toBe(413);
		expect(result.connection).toBe("close");
		expect(JSON.parse(result.body)).toEqual({
			error: `Request body too large (limit ${DEFAULT_MAX_BODY_BYTES} bytes)`,
			code: "request_too_large",
		});
	});

	it("refresh returns model_unavailable without changing the page", async () => {
		const wikiPath = "wiki/concepts/page.md";
		const { entry, block } = createSource("l2src_refresh_route");
		const body = "# Page\n\nClaim.\n";
		const content = pageContent([entry.id], [entry.rawPath], [evidenceReference(entry, block, body)], body);
		writeFileSync(join(root, wikiPath), content, "utf8");
		const detailResponse = await request("GET", `/api/wiki/page?path=${encodeURIComponent(wikiPath)}`);
		const detail = await detailResponse.json() as { pageRevision: string; fileRevision: string };

		const response = await request("POST", "/api/wiki/page/evidence/refresh", {
			path: wikiPath,
			expectedPageRevision: detail.pageRevision,
			expectedFileRevision: detail.fileRevision,
		});

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			error: "No model is available for evidence refresh.",
			code: "model_unavailable",
		});
		expect(readFileSync(join(root, wikiPath), "utf8")).toBe(content);
	});

	it("refresh replaces model refs and remove-stale works without a model", async () => {
		const wikiPath = "wiki/concepts/page.md";
		const { entry, block } = createSource("l2src_refresh_http");
		const body = "# Page\n\nClaim.\n";
		const staleModel = evidenceReference(entry, block, "Old body\n", "model");
		const userRef = evidenceReference(entry, block, body, "user");
		const content = pageContent([entry.id], [entry.rawPath], [staleModel, userRef], body);
		writeFileSync(join(root, wikiPath), content, "utf8");
		const detailResponse = await request("GET", `/api/wiki/page?path=${encodeURIComponent(wikiPath)}`);
		const detail = await detailResponse.json() as { pageRevision: string; fileRevision: string };
		routeSelector = { select: async () => [{ source_id: entry.id, block_id: block.id, quote: "Alpha evidence" }] };

		const refreshed = await request("POST", "/api/wiki/page/evidence/refresh", {
			path: wikiPath,
			expectedPageRevision: detail.pageRevision,
			expectedFileRevision: detail.fileRevision,
		});
		expect(refreshed.status).toBe(200);
		const refreshedDetail = await refreshed.json() as { fileRevision: string; provenance: { sourceGroups: Array<{ references: Array<{ selectedBy: string; positionStatus: string }> }> } };
		expect(refreshedDetail.fileRevision).not.toBe(detail.fileRevision);
		expect(refreshedDetail.provenance.sourceGroups[0]?.references).toHaveLength(2);
		expect(refreshedDetail.provenance.sourceGroups[0]?.references.every((ref) => ref.positionStatus === "verified")).toBe(true);

		const staleContent = pageContent(
			[entry.id],
			[entry.rawPath],
			[userRef, evidenceReference(entry, block, "Old body\n", "model")],
			body,
		);
		writeFileSync(join(root, wikiPath), staleContent, "utf8");
		const staleDetailResponse = await request("GET", `/api/wiki/page?path=${encodeURIComponent(wikiPath)}`);
		const staleDetail = await staleDetailResponse.json() as { pageRevision: string; fileRevision: string };
		const remove = await request("POST", "/api/wiki/page/evidence/remove-stale", {
			path: wikiPath,
			expectedPageRevision: staleDetail.pageRevision,
			expectedFileRevision: staleDetail.fileRevision,
		});
		expect(remove.status).toBe(200);
		const removed = await remove.json() as { provenance: { sourceGroups: Array<{ references: unknown[] }> } };
		expect(removed.provenance.sourceGroups[0]?.references).toHaveLength(1);
	});

	it("refresh rejects a stale revision after an ordinary PUT", async () => {
		const wikiPath = "wiki/concepts/page.md";
		const { entry, block } = createSource("l2src_refresh_cas");
		const body = "# Page\n\nClaim.\n";
		const content = pageContent([entry.id], [entry.rawPath], [evidenceReference(entry, block, body)], body);
		writeFileSync(join(root, wikiPath), content, "utf8");
		const detailResponse = await request("GET", `/api/wiki/page?path=${encodeURIComponent(wikiPath)}`);
		const detail = await detailResponse.json() as { pageRevision: string; fileRevision: string };
		let started!: () => void;
		const selectorStarted = new Promise<void>((resolve) => { started = resolve; });
		let release!: () => void;
		const waiting = new Promise<void>((resolve) => { release = resolve; });
		routeSelector = { select: async () => { started(); await waiting; return [{ source_id: entry.id, block_id: block.id, quote: "Alpha evidence" }]; } };
		const refreshPromise = request("POST", "/api/wiki/page/evidence/refresh", {
			path: wikiPath,
			expectedPageRevision: detail.pageRevision,
			expectedFileRevision: detail.fileRevision,
		});
		await selectorStarted;
		const put = await request("PUT", "/api/wiki/page", { path: wikiPath, content: content.replace("Claim.", "New claim.") });
		expect(put.status).toBe(200);
		release();
		const refresh = await refreshPromise;
		expect(refresh.status).toBe(409);
		expect(await refresh.json()).toEqual({
			error: "Wiki page changed while the evidence action was running.",
			code: "page_changed",
		});
	});

	it("refresh does not overwrite a direct edit made after its CAS read", async () => {
		const wikiPath = "wiki/concepts/page.md";
		const pagePath = join(root, wikiPath);
		const { entry, block } = createSource("l2src_refresh_publish_cas");
		const body = "# Page\n\nClaim.\n";
		const content = pageContent([entry.id], [entry.rawPath], [evidenceReference(entry, block, body)], body);
		const newer = pageContent([entry.id], [entry.rawPath], [], "# Page\n\nDirect edit.\n");
		writeFileSync(pagePath, content, "utf8");
		const detailResponse = await request("GET", `/api/wiki/page?path=${encodeURIComponent(wikiPath)}`);
		const detail = await detailResponse.json() as { pageRevision: string; fileRevision: string };
		routeSelector = { select: async () => [{ source_id: entry.id, block_id: block.id, quote: "Alpha evidence" }] };
		fsFault.afterWikiTempClose = () => {
			fsFault.afterWikiTempClose = undefined;
			writeFileSync(pagePath, newer, "utf8");
		};

		const response = await request("POST", "/api/wiki/page/evidence/refresh", {
			path: wikiPath,
			expectedPageRevision: detail.pageRevision,
			expectedFileRevision: detail.fileRevision,
		});

		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({ code: "page_changed" });
		expect(readFileSync(pagePath, "utf8")).toBe(newer);
	});

	it("refresh returns page_changed when DELETE wins while the selector is running", async () => {
		const wikiPath = "wiki/concepts/page.md";
		const { entry, block } = createSource("l2src_refresh_delete");
		const body = "# Page\n\nClaim.\n";
		const content = pageContent([entry.id], [entry.rawPath], [evidenceReference(entry, block, body)], body);
		writeFileSync(join(root, wikiPath), content, "utf8");
		const detailResponse = await request("GET", `/api/wiki/page?path=${encodeURIComponent(wikiPath)}`);
		const detail = await detailResponse.json() as { pageRevision: string; fileRevision: string };
		let started!: () => void;
		const selectorStarted = new Promise<void>((resolve) => { started = resolve; });
		let release!: () => void;
		const waiting = new Promise<void>((resolve) => { release = resolve; });
		routeSelector = { select: async () => { started(); await waiting; return [{ source_id: entry.id, block_id: block.id, quote: "Alpha evidence" }]; } };
		const refreshPromise = request("POST", "/api/wiki/page/evidence/refresh", {
			path: wikiPath,
			expectedPageRevision: detail.pageRevision,
			expectedFileRevision: detail.fileRevision,
		});
		await selectorStarted;
		const deleted = await request("DELETE", `/api/wiki/page?path=${encodeURIComponent(wikiPath)}`);
		expect(deleted.status).toBe(200);
		release();
		const refresh = await refreshPromise;
		expect(refresh.status).toBe(409);
		expect(await refresh.json()).toMatchObject({ code: "page_changed" });
		expect(existsSync(join(root, wikiPath))).toBe(false);
	});

	it("PUT validates the request body shape before resolving a path", async () => {
		const response = await request("PUT", "/api/wiki/page", { path: 42, content: ["not text"] });

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: "Missing path or content",
			code: "invalid_request",
		});
	});

	it("DELETE removes only an allowed page and updates the manifest and index", async () => {
		const wikiPath = "wiki/sources/source.md";
		const content = pageContent([], [], undefined, "Body\n");
		writeFileSync(join(root, wikiPath), content, "utf8");
		upsertManifest(root, {
			id: "l2src_manifest",
			title: "Source",
			sourceType: "markdown",
			rawPath: "raw/uploads/source.md",
			wikiPages: [wikiPath],
			tags: [],
			contentHash: "legacy",
			status: "indexed",
			source: { origin: "user_upload" },
			createdAt: "2026-08-16T00:00:00.000Z",
			updatedAt: "2026-08-16T00:00:00.000Z",
		});

		const response = await request("DELETE", `/api/wiki/page?path=${encodeURIComponent(wikiPath)}`);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ path: wikiPath, deleted: true });
		expect(existsSync(join(root, wikiPath))).toBe(false);
		expect(readManifest(root)[0].wikiPages).toEqual([]);
		expect(l2Memory.removePage).toHaveBeenCalledWith(wikiPath);
	});
});
