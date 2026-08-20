import { apiFetch, apiFetchResponse } from "./client.js";
import type {
	EvidenceMutationRequest,
	EvidenceSliceResponse,
	LocateRequest,
	LocateResponse,
	WikiPageSummary,
	WikiPageDetail,
	WikiGraphData,
	WikiStats,
} from "../types/wiki.js";

export async function listWikiPages(): Promise<WikiPageSummary[]> {
	return apiFetch<WikiPageSummary[]>("/api/wiki/pages");
}

export async function getWikiPage(path: string): Promise<WikiPageDetail> {
	return apiFetch<WikiPageDetail>(`/api/wiki/page?path=${encodeURIComponent(path)}`);
}

export async function updateWikiPage(path: string, content: string): Promise<WikiPageDetail> {
	return apiFetch<WikiPageDetail>("/api/wiki/page", {
		method: "PUT",
		body: JSON.stringify({ path, content }),
	});
}

export async function deleteWikiPage(path: string): Promise<void> {
	await apiFetch(`/api/wiki/page?path=${encodeURIComponent(path)}`, {
		method: "DELETE",
	});
}

export async function getWikiGraph(): Promise<WikiGraphData> {
	return apiFetch<WikiGraphData>("/api/wiki/graph");
}

export async function getWikiStats(): Promise<WikiStats> {
	return apiFetch<WikiStats>("/api/wiki/stats");
}

function sourceApiPath(sourceId: string, action: "content" | "evidence" | "locate"): string {
	return `/api/l2/sources/${encodeURIComponent(sourceId)}/${action}`;
}

function revisionHeaders(revision: string): HeadersInit {
	return { "If-Match": `"${revision}"` };
}

interface SourceRequestOptions {
	signal?: AbortSignal;
}

export async function getSourceEvidence(
	sourceId: string,
	blockId: string,
	revision: string,
	options: SourceRequestOptions = {},
): Promise<EvidenceSliceResponse> {
	return apiFetch<EvidenceSliceResponse>(
		`${sourceApiPath(sourceId, "evidence")}?blockId=${encodeURIComponent(blockId)}`,
		{ headers: revisionHeaders(revision), signal: options.signal },
	);
}

export async function locateSourceQuote(
	sourceId: string,
	request: LocateRequest,
	revision: string,
	options: SourceRequestOptions = {},
): Promise<LocateResponse> {
	return apiFetch<LocateResponse>(sourceApiPath(sourceId, "locate"), {
		method: "POST",
		headers: revisionHeaders(revision),
		body: JSON.stringify(request),
		signal: options.signal,
	});
}

export function sourceContentUrl(sourceId: string): string {
	return sourceApiPath(sourceId, "content");
}

export async function getSourceContent(
	sourceId: string,
	revision: string,
	options: SourceRequestOptions = {},
): Promise<Response> {
	return apiFetchResponse(sourceContentUrl(sourceId), {
		headers: revisionHeaders(revision),
		signal: options.signal,
	});
}

export async function refreshPageEvidence(request: EvidenceMutationRequest): Promise<WikiPageDetail> {
	return apiFetch<WikiPageDetail>("/api/wiki/page/evidence/refresh", {
		method: "POST",
		body: JSON.stringify(request),
	});
}

export async function removeStalePageEvidence(request: EvidenceMutationRequest): Promise<WikiPageDetail> {
	return apiFetch<WikiPageDetail>("/api/wiki/page/evidence/remove-stale", {
		method: "POST",
		body: JSON.stringify(request),
	});
}
