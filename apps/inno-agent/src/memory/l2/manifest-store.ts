import { dirname, join } from "node:path";
import { appendJsonl, ensureDir, readJsonl, writeText } from "../../storage/file-store.js";
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

export function findManifestByRawPath(l2DataDir: string, rawPath: string): ManifestEntry | undefined {
	const normalized = rawPath.replace(/^\/+/, "");
	return readManifest(l2DataDir).find((e) => e.rawPath.replace(/^\/+/, "") === normalized);
}

export function writeManifest(l2DataDir: string, entries: ManifestEntry[]): void {
	const path = getManifestPath(l2DataDir);
	ensureDir(dirname(path));
	const content = entries.length > 0 ? `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n` : "";
	writeText(path, content);
}

export function removeManifestByRawPath(l2DataDir: string, rawPath: string): ManifestEntry | undefined {
	const normalized = rawPath.replace(/^\/+/, "");
	const entries = readManifest(l2DataDir);
	const removed = entries.find((entry) => entry.rawPath.replace(/^\/+/, "") === normalized);
	if (!removed) return undefined;
	writeManifest(
		l2DataDir,
		entries.filter((entry) => entry.rawPath.replace(/^\/+/, "") !== normalized),
	);
	return removed;
}
