import { localPtyBackend, type PtySession } from "./local-pty-backend.js";
import type { RunRecordStore } from "./run-record-store.js";
import type { RunRecord } from "./terminal-types.js";
import type { WorkspaceRegistry } from "../workspace/workspace-registry.js";

export interface TerminalCreateInput {
	sessionId: string;
	workspaceId: string;
	cols?: number;
	rows?: number;
}

export interface TerminalSession {
	id: string;
	sessionId: string;
	workspaceId: string;
	cwd: string;
	pty: PtySession;
	createdAt: number;
	// In-flight Run state used to slice pty output into a run record.
	activeRun?: RunRecord;
	// Sentinel-scanner state for the active run only.
	sentinelBuffer: string;
	sentinelTag?: string;
	// Set true once both echo + result of the sentinel have been processed and
	// we've collected an exit code (or run-cancel). The next chunk falls back
	// to pass-through immediately.
	sentinelDone: boolean;
}

export interface ProcessedChunk {
	/** Output to forward to client and append to log (sentinel artifacts removed). */
	cleaned: string;
	/** When the active run just completed via sentinel detection. */
	finishedRun?: { exitCode: number | null; signal?: string };
}

const SENTINEL_PREFIX = "__INNO_RUN_DONE_";
/** Max bytes we hold in the trailing-window buffer while scanning. */
const SENTINEL_SCAN_WINDOW = SENTINEL_PREFIX.length + 32 + 1 + 10 + 1;

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Manages live PTY sessions keyed by the inno session id (jsonl filename).
 *
 * Each inno session gets at most one terminal session at a time.
 * Re-creating for the same inno session kills the previous pty so we don't
 * leak shells when the web UI reconnects.
 */
export class TerminalSessionManager {
	private byInnoSession = new Map<string, TerminalSession>();
	private byTerminalId = new Map<string, TerminalSession>();

	constructor(
		private readonly registry: WorkspaceRegistry,
		private readonly runs: RunRecordStore,
	) {}

	create(input: TerminalCreateInput): TerminalSession {
		const cwd = this.registry.resolveWorkspaceDir(input.workspaceId);
		if (!cwd) throw new Error(`Workspace not found: ${input.workspaceId}`);

		// Kill any pre-existing terminal for this inno session.
		const previous = this.byInnoSession.get(input.sessionId);
		if (previous) this.close(previous.id);

		const pty = localPtyBackend.create({
			cwd,
			cols: input.cols ?? 100,
			rows: input.rows ?? 24,
			env: {
				...process.env,
				INNO_WORKSPACE: cwd,
				INNO_SESSION: input.sessionId,
			},
		});

		const ts: TerminalSession = {
			id: pty.id,
			sessionId: input.sessionId,
			workspaceId: input.workspaceId,
			cwd,
			pty,
			createdAt: Date.now(),
			sentinelBuffer: "",
			sentinelDone: false,
		};
		this.byInnoSession.set(input.sessionId, ts);
		this.byTerminalId.set(ts.id, ts);

		pty.onExit(() => {
			// Auto-cleanup when the shell process dies on its own.
			this.byInnoSession.delete(input.sessionId);
			this.byTerminalId.delete(ts.id);
		});

		return ts;
	}

	get(id: string): TerminalSession | undefined {
		return this.byTerminalId.get(id);
	}

	getByInnoSession(sessionId: string): TerminalSession | undefined {
		return this.byInnoSession.get(sessionId);
	}

	close(id: string): void {
		const ts = this.byTerminalId.get(id);
		if (!ts) return;
		try { ts.pty.kill(); } catch { /* already dead */ }
		this.byTerminalId.delete(id);
		this.byInnoSession.delete(ts.sessionId);
	}

	closeAll(): void {
		for (const id of Array.from(this.byTerminalId.keys())) {
			this.close(id);
		}
	}

	/**
	 * Start a Run on this terminal: writes the wrapped command, opens a run
	 * record, primes the sentinel scanner. The wrapped form:
	 *
	 *   ( <user command> ) ; printf '\n__INNO_RUN_DONE_<runId> %d\n' "$?"
	 *
	 * The `( ... )` subshell isolates the user command so a stray exit/return
	 * doesn't kill the interactive shell. The sentinel ALWAYS prints, so even
	 * non-zero exits are reported.
	 *
	 * The whole line is wrapped in `\e[200~ ... \e[201~` (bracketed paste mode)
	 * so the user's shell readline (esp. zsh-autosuggestions /
	 * zsh-syntax-highlighting) does NOT mangle the echoed sentinel tag with
	 * inline ANSI control codes — otherwise our scanner would never find the
	 * tag as a contiguous substring in the echoed line.
	 */
	startRun(ts: TerminalSession, command: string, sourceFile?: string): RunRecord {
		// Finalize any prior unfinished run before starting a new one.
		if (ts.activeRun) this.finishActiveRun(ts, null);
		const record = this.runs.start({
			sessionId: ts.sessionId,
			workspaceId: ts.workspaceId,
			command,
			cwd: ts.cwd,
			sourceFile,
		});
		ts.activeRun = record;
		ts.sentinelBuffer = "";
		ts.sentinelTag = `${SENTINEL_PREFIX}${record.id}`;
		ts.sentinelDone = false;

		const wrapped = `( ${command} ) ; printf '\\n%s %d\\n' "${ts.sentinelTag}" "$?"`;
		// \e[200~ ... \e[201~ = bracketed paste; \r submits.
		const BRACKETED_PASTE_START = "\x1b[200~";
		const BRACKETED_PASTE_END = "\x1b[201~";
		ts.pty.write(`${BRACKETED_PASTE_START}${wrapped}${BRACKETED_PASTE_END}\r`);
		return record;
	}

	/**
	 * Filter a pty output chunk while a run is active.
	 *
	 * Strategy: the user shell's readline echoes the wrapped command back with
	 * embedded ANSI escapes (zsh-syntax-highlighting wraps every char in
	 * `\e[7m...\e[27m`, zsh-autosuggestions inserts `\e[K`, etc.), so the
	 * echoed sentinel tag is rarely a contiguous substring in our pty stream.
	 *
	 * The printf marker line, on the other hand, is pure shell stdout and is
	 * NOT subject to readline highlighting. So we scan for the unique pattern
	 * `<tag> <int>` — which can only appear in the printf result — using a
	 * regex. We strip that line from the forwarded stream and capture the
	 * exit code.
	 *
	 * The echoed wrapper line itself is passed through to xterm unchanged.
	 * The user briefly sees the wrapper command in the terminal. Acceptable
	 * for an MVP; cosmetic improvements (e.g. line-rewriting) can come later.
	 */
	processOutput(ts: TerminalSession, chunk: string): ProcessedChunk {
		if (!ts.activeRun || !ts.sentinelTag || ts.sentinelDone) {
			return { cleaned: chunk };
		}

		ts.sentinelBuffer += chunk;
		const buf = ts.sentinelBuffer;
		const pattern = new RegExp(`${escapeRegex(ts.sentinelTag)}\\s+(-?\\d+)\\s*(\\n|\\r\\n)?`);
		const m = pattern.exec(buf);

		if (!m) {
			// Hold the trailing window so we don't miss a split marker.
			const cut = Math.max(0, buf.length - SENTINEL_SCAN_WINDOW);
			const out = buf.slice(0, cut);
			ts.sentinelBuffer = buf.slice(cut);
			return { cleaned: out };
		}

		const exitCode = Number.parseInt(m[1], 10);
		const matchEnd = m.index + m[0].length;
		// Strip the entire line containing the marker so the user doesn't see it.
		const lineStart = buf.lastIndexOf("\n", m.index - 1) + 1;
		const cleaned = buf.slice(0, lineStart) + buf.slice(matchEnd);
		ts.sentinelBuffer = "";
		ts.sentinelDone = true;
		return {
			cleaned,
			finishedRun: { exitCode },
		};
	}

	/** Capture a chunk into the active run's log (if any). */
	recordOutput(ts: TerminalSession, chunk: string): void {
		if (!ts.activeRun) return;
		try {
			this.runs.appendOutput(ts.activeRun, chunk);
		} catch {
			// best-effort; don't break the pty stream
		}
	}

	/** Mark the active run as complete based on a shell exit-code echo. */
	finishActiveRun(ts: TerminalSession, exitCode: number | null, signal?: string): RunRecord | null {
		const run = ts.activeRun;
		if (!run) return null;
		ts.activeRun = undefined;
		ts.sentinelBuffer = "";
		ts.sentinelTag = undefined;
		ts.sentinelDone = false;
		return this.runs.finish(run, { exitCode, signal });
	}
}
