import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { ensureDir, readJson, writeJson } from "../storage/file-store.js";
import type { RunRecord } from "./terminal-types.js";

/** Cap how much of a log file we'll slurp into memory when building a tail. */
const MAX_TAIL_BYTES = 256 * 1024;

function readTailBytes(path: string, maxBytes: number): string {
	const stat = statSync(path);
	if (stat.size <= maxBytes) {
		return readFileSync(path, "utf-8");
	}
	const fd = openSync(path, "r");
	try {
		const buf = Buffer.alloc(maxBytes);
		readSync(fd, buf, 0, maxBytes, stat.size - maxBytes);
		return buf.toString("utf-8");
	} finally {
		closeSync(fd);
	}
}

/**
 * Strip the most common terminal control sequences so archived logs and
 * agent-context injections read as plain text. Covers:
 * - CSI sequences (ESC [ ... letter)
 * - OSC sequences (ESC ] ... BEL or ESC \)
 * - Single-char ESC controls (ESC =, ESC >, ESC (B, etc.)
 * - Bracketed paste markers leftover in stream
 */
function stripAnsi(value: string): string {
	return value
		.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b[=>]/g, "")
		.replace(/\x1b\([AB012]/g, "")
		.replace(/\x1b\[200~|\x1b\[201~/g, "")
		.replace(/\r(?!\n)/g, "");
}

export interface StartRunInput {
	sessionId: string;
	workspaceId: string;
	command: string;
	cwd: string;
	sourceFile?: string;
}

export interface FinishRunInput {
	exitCode: number | null;
	signal?: string;
}

/**
 * Persist a JSON metadata file + matching `.log` for each terminal "Run".
 *
 * Layout:
 *   <dataDir>/runs/YYYY-MM-DD/<runId>.json
 *   <dataDir>/runs/YYYY-MM-DD/<runId>.log
 *
 * Designed so the agent can later cite "the last run" without parsing the
 * full pty transcript — metadata holds command + exit, log holds raw bytes.
 */
export class RunRecordStore {
	constructor(private readonly runsDir: string) {
		ensureDir(runsDir);
	}

	private dateDir(date = new Date()): string {
		const y = date.getUTCFullYear();
		const m = String(date.getUTCMonth() + 1).padStart(2, "0");
		const d = String(date.getUTCDate()).padStart(2, "0");
		const dir = join(this.runsDir, `${y}-${m}-${d}`);
		ensureDir(dir);
		return dir;
	}

	private metaPath(record: { id: string; logPath: string }): string {
		// derive sibling .json from .log
		return record.logPath.replace(/\.log$/, ".json");
	}

	start(input: StartRunInput): RunRecord {
		const id = `run_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
		const dir = this.dateDir();
		const logPath = join(dir, `${id}.log`);
		// Touch the log file so concurrent readers don't 404.
		appendFileSync(logPath, "");
		const record: RunRecord = {
			id,
			sessionId: input.sessionId,
			workspaceId: input.workspaceId,
			command: input.command,
			cwd: input.cwd,
			sourceFile: input.sourceFile,
			startedAt: new Date().toISOString(),
			logPath,
			outputBytes: 0,
		};
		writeJson(this.metaPath(record), record);
		return record;
	}

	appendOutput(record: RunRecord, chunk: string): void {
		appendFileSync(record.logPath, chunk);
		record.outputBytes += Buffer.byteLength(chunk, "utf-8");
		// Don't rewrite metadata on every chunk — periodic at finish() is fine.
	}

	finish(record: RunRecord, result: FinishRunInput): RunRecord {
		record.endedAt = new Date().toISOString();
		record.exitCode = result.exitCode;
		record.signal = result.signal;
		writeJson(this.metaPath(record), record);
		return record;
	}

	get(runId: string): RunRecord | null {
		// Scan recent date dirs from newest to oldest. Cap to last 14 days.
		const dirs = this.listDateDirs().slice(0, 14);
		for (const dir of dirs) {
			const meta = join(dir, `${runId}.json`);
			if (existsSync(meta)) {
				return readJson<RunRecord | null>(meta, null);
			}
		}
		return null;
	}

	getOutputTail(record: RunRecord, lines = 80, opts: { raw?: boolean } = {}): string {
		try {
			const raw = readTailBytes(record.logPath, MAX_TAIL_BYTES);
			if (!raw) return "";
			const text = opts.raw ? raw : stripAnsi(raw);
			const allLines = text.split("\n")
				// Drop the echoed wrapper line: even after stripping ANSI, it
				// still contains the sentinel tag as plain text.
				.filter((line) => !line.includes("__INNO_RUN_DONE_"));
			// Also collapse runs of blank lines that the stripped escapes leave behind.
			const collapsed: string[] = [];
			for (const line of allLines) {
				const trimmed = line.replace(/\s+$/, "");
				if (trimmed === "" && collapsed[collapsed.length - 1] === "") continue;
				collapsed.push(trimmed);
			}
			return collapsed.slice(Math.max(0, collapsed.length - lines)).join("\n");
		} catch {
			return "";
		}
	}

	listForSession(sessionId: string, limit = 20): RunRecord[] {
		const results: RunRecord[] = [];
		for (const dir of this.listDateDirs()) {
			for (const file of readdirSync(dir)) {
				if (!file.endsWith(".json")) continue;
				const meta = readJson<RunRecord | null>(join(dir, file), null);
				if (!meta) continue;
				if (meta.sessionId !== sessionId) continue;
				results.push(meta);
				if (results.length >= limit * 2) break;
			}
			if (results.length >= limit * 2) break;
		}
		results.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
		return results.slice(0, limit);
	}

	getLatestForSession(sessionId: string): RunRecord | null {
		const list = this.listForSession(sessionId, 1);
		return list[0] ?? null;
	}

	private listDateDirs(): string[] {
		if (!existsSync(this.runsDir)) return [];
		return readdirSync(this.runsDir)
			.filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name))
			.map((name) => join(this.runsDir, name))
			.filter((dir) => statSync(dir).isDirectory())
			.sort((a, b) => basename(b).localeCompare(basename(a)));
	}
}
