import { afterEach, describe, expect, it, vi } from "vitest";

import {
	getSourceContent,
	getSourceEvidence,
	locateSourceQuote,
	refreshPageEvidence,
	removeStalePageEvidence,
	sourceContentUrl,
	updateWikiPage,
} from "./wiki.js";
import type {
	EvidenceMutationRequest,
	EvidenceSliceResponse,
	LocateRequest,
	WikiPageDetail,
} from "../types/wiki.js";

const REVISION = `sha256:${"a".repeat(64)}`;
const FILE_REVISION = `sha256:${"b".repeat(64)}`;

function jsonResponse(value: unknown): Response {
	return new Response(JSON.stringify(value), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function wikiDetail(content = "Body"): WikiPageDetail {
	return {
		path: "wiki/concepts/page.md",
		content,
		pageRevision: REVISION,
		fileRevision: FILE_REVISION,
		provenance: { sourceGroups: [], legacyPaths: [], referenceIssues: [] },
	};
}

describe("Wiki provenance API", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("gets an evidence slice with an encoded ID and strong If-Match", async () => {
		const controller = new AbortController();
		const payload: EvidenceSliceResponse = {
			sourceId: "legacy@example.com",
			sourceRevision: REVISION,
			indexVersion: 1,
			target: { id: "block/1", kind: "markdown", text: "target", paragraph: 1 },
			neighbors: [],
		};
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse(payload));
		vi.stubGlobal("fetch", fetchMock);

		expect(await getSourceEvidence("legacy@example.com", "block/1", REVISION, { signal: controller.signal })).toEqual(payload);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("/api/l2/sources/legacy%40example.com/evidence?blockId=block%2F1");
		expect(new Headers(init.headers).get("If-Match")).toBe(`"${REVISION}"`);
		expect(init.signal).toBe(controller.signal);
	});

	it("sends locate quotes only in the JSON body", async () => {
		const controller = new AbortController();
		const request: LocateRequest = {
			quote: "force / direction? #exact",
			sourceRevision: REVISION,
			indexVersion: 1,
		};
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ matches: [] }));
		vi.stubGlobal("fetch", fetchMock);

		await locateSourceQuote("../../source", request, REVISION, { signal: controller.signal });
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("/api/l2/sources/..%2F..%2Fsource/locate");
		expect(url).not.toContain("force");
		expect(init.method).toBe("POST");
		expect(JSON.parse(String(init.body))).toEqual(request);
		expect(new Headers(init.headers).get("If-Match")).toBe(`"${REVISION}"`);
		expect(init.signal).toBe(controller.signal);
	});

	it("keeps source content as a raw response", async () => {
		const controller = new AbortController();
		const fetchMock = vi.fn().mockResolvedValue(new Response("document", {
			status: 200,
			headers: { "Content-Type": "text/markdown" },
		}));
		vi.stubGlobal("fetch", fetchMock);

		expect(sourceContentUrl("legacy/source")).toBe("/api/l2/sources/legacy%2Fsource/content");
		const response = await getSourceContent("legacy/source", REVISION, { signal: controller.signal });
		expect(response.headers.get("Content-Type")).toBe("text/markdown");
		expect(await response.text()).toBe("document");
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(sourceContentUrl("legacy/source"));
		expect(new Headers(init.headers).get("If-Match")).toBe(`"${REVISION}"`);
		expect(init.signal).toBe(controller.signal);
	});

	it("returns the server detail after updating a page", async () => {
		const detail = wikiDetail("Saved body");
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse(detail));
		vi.stubGlobal("fetch", fetchMock);

		expect(await updateWikiPage(detail.path, detail.content)).toEqual(detail);
		expect(fetchMock).toHaveBeenCalledWith("/api/wiki/page", expect.objectContaining({
			method: "PUT",
			body: JSON.stringify({ path: detail.path, content: detail.content }),
		}));
	});

	it.each([
		["refresh", refreshPageEvidence, "/api/wiki/page/evidence/refresh"],
		["remove stale", removeStalePageEvidence, "/api/wiki/page/evidence/remove-stale"],
	] as const)("posts the strict mutation request for %s", async (_label, action, path) => {
		const detail = wikiDetail();
		const request: EvidenceMutationRequest = {
			path: detail.path,
			expectedPageRevision: REVISION,
			expectedFileRevision: FILE_REVISION,
		};
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse(detail));
		vi.stubGlobal("fetch", fetchMock);

		expect(await action(request)).toEqual(detail);
		expect(fetchMock).toHaveBeenCalledWith(path, expect.objectContaining({
			method: "POST",
			body: JSON.stringify(request),
		}));
	});
});
