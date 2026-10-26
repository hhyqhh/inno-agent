import { ApiError } from "./client.js";

const MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
function documentUrl(path: string, workspaceId: string | null): string {
	return `/api/workspace/word-editor/document?${new URLSearchParams({ path, workspaceId: workspaceId ?? "tmp" })}`;
}
async function checked(response: Response): Promise<Response> {
	if (!response.ok) {
		const body = await response.json().catch(() => ({})) as Record<string, unknown>;
		throw new ApiError(response.status, String(body.code || body.error || response.statusText), body);
	}
	return response;
}
export async function openWordDocument(path: string, workspaceId: string | null, signal: AbortSignal) {
	const response = await checked(await fetch(documentUrl(path, workspaceId), { signal }));
	const version = response.headers.get("etag")?.replace(/^"|"$/g, "");
	if (!version) throw new Error("Missing document version");
	return { bytes: new Uint8Array(await response.arrayBuffer()), version };
}
export async function saveWordDocument(path: string, workspaceId: string | null, version: string, bytes: Uint8Array): Promise<{ version: string; savedAt: string }> {
	const response = await checked(await fetch(documentUrl(path, workspaceId), {
		method: "PUT", headers: { "Content-Type": MIME, "If-Match": `"${version}"` }, body: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: MIME }),
	}));
	return response.json();
}
export function downloadWordCopy(name: string, bytes: ArrayBuffer): void {
	const url = URL.createObjectURL(new Blob([bytes], { type: MIME }));
	const anchor = document.createElement("a");
	anchor.href = url; anchor.download = name; anchor.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}
