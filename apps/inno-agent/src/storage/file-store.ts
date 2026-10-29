import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { readFile } from "node:fs/promises";
import { logger } from "../logger.js";

/**
 * Ensure a directory exists, creating it recursively if needed.
 */
export function ensureDir(dirPath: string): void {
	mkdirSync(dirPath, { recursive: true });
}

/**
 * Read and parse a JSON file. Returns defaultValue if file does not exist.
 */
export function readJson<T>(filePath: string, defaultValue: T): T {
	if (!existsSync(filePath)) {
		return defaultValue;
	}
	const raw = readFileSync(filePath, "utf-8");
	try {
		return JSON.parse(raw) as T;
	} catch (err) {
		logger.warn({ err }, `failed to parse JSON ${filePath}`);
		return defaultValue;
	}
}

/**
 * Write a JSON file atomically (write to .tmp then rename).
 *
 * `options.mode` (e.g. 0o600 for files containing secrets) is applied to the
 * final file — including pre-existing files left over from before the option
 * was introduced, whose permissions are corrected in place.
 */
export function writeJson<T>(filePath: string, data: T, options?: { mode?: number }): void {
	ensureDir(dirname(filePath));
	const tmp = filePath + ".tmp";
	writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { encoding: "utf-8", ...(options?.mode !== undefined ? { mode: options.mode } : {}) });
	renameSync(tmp, filePath);
	if (options?.mode !== undefined) {
		// rename only helps if the tmp file got the right mode at creation;
		// chmod unconditionally so old 0644 files are fixed on next write too.
		try {
			chmodSync(filePath, options.mode);
		} catch (err) {
			logger.warn({ err, filePath }, "failed to chmod file");
		}
	}
}

/**
 * Write records as a JSONL file (one JSON line each), atomically
 * (tmp + rename). Used to compact live-state logs such as dedupe.jsonl,
 * where rotation is unsafe (it would drop still-live entries).
 */
export function writeJsonl<T>(filePath: string, records: T[]): void {
	ensureDir(dirname(filePath));
	const tmp = filePath + ".tmp";
	writeFileSync(tmp, records.map((r) => JSON.stringify(r)).join("\n") + (records.length > 0 ? "\n" : ""), "utf-8");
	renameSync(tmp, filePath);
}

/**
 * Append a single JSON record as a line to a JSONL file.
 *
 * When `options.maxBytes` is set and the file already exceeds that size, the
 * current file is first rolled to a `<path>.<timestamp>.archive` sibling and a
 * fresh file is started. Append-only logs (runs, events, channel run-log) use
 * this to bound unbounded growth; live-state logs (e.g. dedupe) must NOT, since
 * rotation silently drops entries that are still meaningful.
 */
export function appendJsonl<T>(filePath: string, record: T, options?: { maxBytes?: number }): void {
	ensureDir(dirname(filePath));
	if (options?.maxBytes && existsSync(filePath)) {
		try {
			if (statSync(filePath).size >= options.maxBytes) {
				const stamp = new Date().toISOString().replace(/[:.]/g, "-");
				renameSync(filePath, `${filePath}.${stamp}.archive`);
			}
		} catch (err) {
			// Rotation is best-effort: failing to archive must never drop the record.
			logger.warn({ err }, `failed to rotate JSONL ${filePath}`);
		}
	}
	appendFileSync(filePath, JSON.stringify(record) + "\n", "utf-8");
}

function parseJsonlLines<T>(raw: string): T[] {
	const records: T[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			records.push(JSON.parse(line) as T);
		} catch (err) {
			logger.warn("skipping malformed JSONL line");
		}
	}
	return records;
}

/**
 * Read all records from a JSONL file. Returns empty array if file does not exist.
 */
export function readJsonl<T>(filePath: string): T[] {
	if (!existsSync(filePath)) {
		return [];
	}
	return parseJsonlLines(readFileSync(filePath, "utf-8"));
}

/**
 * Read only the last `maxBytes` of a JSONL file. The first line of the window
 * may be truncated mid-record and is dropped. Use for append-only logs whose
 * consumers only need recent history.
 */
export function readJsonlTail<T>(filePath: string, maxBytes: number): T[] {
	if (!existsSync(filePath)) {
		return [];
	}
	const size = statSync(filePath).size;
	if (size <= maxBytes) {
		return parseJsonlLines(readFileSync(filePath, "utf-8"));
	}
	const start = size - maxBytes;
	const fd = openSync(filePath, "r");
	let raw: string;
	try {
		const buf = Buffer.alloc(maxBytes);
		readSync(fd, buf, 0, maxBytes, start);
		raw = buf.toString("utf-8");
	} finally {
		closeSync(fd);
	}
	const lines = raw.split("\n");
	lines.shift(); // drop the possibly-partial first line of the window
	return parseJsonlLines(lines.join("\n"));
}

/**
 * Write a text file atomically (write to .tmp then rename).
 */
export function writeText(filePath: string, content: string): void {
	ensureDir(dirname(filePath));
	const tmp = filePath + ".tmp";
	writeFileSync(tmp, content, "utf-8");
	renameSync(tmp, filePath);
}

/**
 * Read a text file. Returns defaultValue if file does not exist.
 */
export function readText(filePath: string, defaultValue: string = ""): string {
	if (!existsSync(filePath)) return defaultValue;
	return readFileSync(filePath, "utf-8");
}

/** Request paths must not block the event loop while reading persisted data. */
export async function readTextAsync(filePath: string, defaultValue = ""): Promise<string> {
	try {
		return await readFile(filePath, "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return defaultValue;
		throw err;
	}
}

export async function readJsonAsync<T>(filePath: string, defaultValue: T): Promise<T> {
	const raw = await readTextAsync(filePath);
	if (!raw) return defaultValue;
	try {
		return JSON.parse(raw) as T;
	} catch {
		logger.warn("failed to parse JSON file");
		return defaultValue;
	}
}

export async function readJsonlAsync<T>(filePath: string): Promise<T[]> {
	return parseJsonlLines(await readTextAsync(filePath));
}

/**
 * Append text to a file.
 */
export function appendText(filePath: string, content: string): void {
	ensureDir(dirname(filePath));
	appendFileSync(filePath, content, "utf-8");
}

/**
 * Check if a file exists.
 */
export function fileExists(filePath: string): boolean {
	return existsSync(filePath);
}
