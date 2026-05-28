import { apiFetch } from "./client.js";

export interface RawUploadResult {
	fileName: string;
	mimeType: string;
	size: number;
	rawPath: string;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
	let binary = "";
	const bytes = new Uint8Array(buffer);
	const chunkSize = 0x8000;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		const chunk = bytes.subarray(i, i + chunkSize);
		binary += String.fromCharCode(...chunk);
	}
	return btoa(binary);
}

export async function uploadRawFile(file: File): Promise<RawUploadResult> {
	const dataBase64 = arrayBufferToBase64(await file.arrayBuffer());
	return apiFetch<RawUploadResult>("/api/l2/raw/upload", {
		method: "POST",
		body: JSON.stringify({
			fileName: file.name,
			mimeType: file.type || "application/octet-stream",
			dataBase64,
		}),
	});
}
