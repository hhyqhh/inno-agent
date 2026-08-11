import { posix } from "node:path";

/** L2 paths are persisted identifiers, so they always use POSIX separators. */
export function normalizeL2Path(value: string): string {
	return value.replace(/\\/g, "/");
}

export function joinL2Path(...segments: string[]): string {
	return posix.join(...segments.map(normalizeL2Path));
}
