import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
		console.warn(`[file-store] Failed to parse JSON ${filePath}, falling back to default:`, err);
		return defaultValue;
	}
}

/**
 * Write a JSON file atomically (write to .tmp then rename).
 */
export function writeJson<T>(filePath: string, data: T): void {
	ensureDir(dirname(filePath));
	const tmp = filePath + ".tmp";
	writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
	renameSync(tmp, filePath);
}

/**
 * Append a single JSON record as a line to a JSONL file.
 */
export function appendJsonl<T>(filePath: string, record: T): void {
	ensureDir(dirname(filePath));
	appendFileSync(filePath, JSON.stringify(record) + "\n", "utf-8");
}

/**
 * Read all records from a JSONL file. Returns empty array if file does not exist.
 */
export function readJsonl<T>(filePath: string): T[] {
	if (!existsSync(filePath)) {
		return [];
	}
	const raw = readFileSync(filePath, "utf-8");
	const records: T[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			records.push(JSON.parse(line) as T);
		} catch (err) {
			console.warn(`[file-store] Skipping malformed JSONL line in ${filePath}:`, err);
		}
	}
	return records;
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
