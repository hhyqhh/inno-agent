import { join } from "node:path";
import { appendJsonl, readJsonl } from "../../storage/file-store.js";
import type { ManifestEntry } from "./types.js";

const MANIFEST_FILE = "manifest.jsonl";

function getManifestPath(l2DataDir: string): string {
	return join(l2DataDir, MANIFEST_FILE);
}

export function appendManifest(l2DataDir: string, entry: ManifestEntry): void {
	appendJsonl(getManifestPath(l2DataDir), entry);
}

export function readManifest(l2DataDir: string): ManifestEntry[] {
	return readJsonl<ManifestEntry>(getManifestPath(l2DataDir));
}

export function findManifestById(l2DataDir: string, id: string): ManifestEntry | undefined {
	return readManifest(l2DataDir).find((e) => e.id === id);
}

export function findManifestByTitle(l2DataDir: string, title: string): ManifestEntry[] {
	const lower = title.toLowerCase();
	return readManifest(l2DataDir).filter((e) => e.title.toLowerCase().includes(lower));
}

export function findManifestByHash(l2DataDir: string, contentHash: string): ManifestEntry | undefined {
	return readManifest(l2DataDir).find((e) => e.contentHash === contentHash);
}
