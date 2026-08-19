import { join } from "node:path";
import { appendJsonl, readJsonl, writeText } from "../../storage/file-store.js";
import type { ManifestEntry } from "./types.js";

const MANIFEST_FILE = "manifest.jsonl";

function getManifestPath(l2DataDir: string): string {
	return join(l2DataDir, MANIFEST_FILE);
}

export function appendManifest(l2DataDir: string, entry: ManifestEntry): void {
	appendJsonl(getManifestPath(l2DataDir), entry);
}

/** Insert a manifest entry or atomically replace the existing record with the same id. */
export function upsertManifest(l2DataDir: string, entry: ManifestEntry): void {
	const entries = readManifest(l2DataDir);
	const index = entries.findIndex((candidate) => candidate.id === entry.id);
	if (index >= 0) entries[index] = entry;
	else entries.push(entry);
	const lines = entries.map((candidate) => JSON.stringify(candidate)).join("\n");
	writeText(getManifestPath(l2DataDir), lines ? `${lines}\n` : "");
}

export function readManifest(l2DataDir: string): ManifestEntry[] {
	return readJsonl<ManifestEntry>(getManifestPath(l2DataDir));
}

/**
 * Remove a wiki page path from every manifest entry's `wikiPages` list.
 * Rewrites the JSONL file in place. Keeps entries even if their `wikiPages`
 * becomes empty (the source record is still valid).
 * Returns true if any entry was modified.
 */
export function removeWikiPathFromManifest(l2DataDir: string, wikiPath: string): boolean {
	const entries = readManifest(l2DataDir);
	let changed = false;
	for (const entry of entries) {
		if (entry.wikiPages.includes(wikiPath)) {
			entry.wikiPages = entry.wikiPages.filter((p) => p !== wikiPath);
			changed = true;
		}
	}
	if (changed) {
		const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
		writeText(getManifestPath(l2DataDir), lines);
	}
	return changed;
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
	const normalized = rawPath.replace(/\\/g, "/");
	return readManifest(l2DataDir).find((e) => e.rawPath.replace(/\\/g, "/") === normalized);
}

export function removeManifestEntry(l2DataDir: string, id: string): boolean {
	const entries = readManifest(l2DataDir);
	const next = entries.filter((entry) => entry.id !== id);
	if (next.length === entries.length) return false;
	const lines = next.map((entry) => JSON.stringify(entry)).join("\n");
	writeText(getManifestPath(l2DataDir), lines ? `${lines}\n` : "");
	return true;
}
