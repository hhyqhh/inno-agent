import { chmodSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { spawn, type IPty } from "node-pty";

/**
 * node-pty ships its macOS/Linux `spawn-helper` binary without the executable
 * bit in some published artifacts (and electron-builder's asar unpack can drop
 * it too). When the bit is missing, node-pty's `posix_spawn` of the helper
 * fails with the opaque error "posix_spawnp failed." and the terminal never
 * connects. Restore the bit before the first spawn so this self-heals in both
 * the dev tree and the packaged app.
 */
let _helperChecked = false;
function ensureSpawnHelperExecutable(): void {
	if (_helperChecked || process.platform === "win32") return;
	_helperChecked = true;
	try {
		const require = createRequire(import.meta.url);
		const root = dirname(require.resolve("node-pty/package.json"));
		const candidates = [
			join(root, "build", "Release", "spawn-helper"),
			join(root, "build", "Debug", "spawn-helper"),
			join(root, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
		];
		for (const helper of candidates) {
			if (!existsSync(helper)) continue;
			const mode = statSync(helper).mode;
			if ((mode & 0o111) === 0) {
				chmodSync(helper, mode | 0o755);
			}
		}
	} catch {
		// Best-effort: if resolution or chmod fails (e.g. read-only install),
		// fall through and let spawn surface its own error.
	}
}

export interface PtySpawnOptions {
	cwd: string;
	cols: number;
	rows: number;
	shell?: string;
	env?: NodeJS.ProcessEnv;
}

export interface PtySession {
	id: string;
	pty: IPty;
	write(data: string): void;
	resize(cols: number, rows: number): void;
	onData(cb: (chunk: string) => void): () => void;
	onExit(cb: (e: { exitCode: number; signal?: number }) => void): () => void;
	kill(): void;
}

function defaultShell(): string {
	if (process.env.SHELL) return process.env.SHELL;
	if (process.platform === "win32") return "powershell.exe";
	return "/bin/bash";
}

/**
 * Sanitize the env handed to the child shell. Strips obvious API-key style
 * variables so they aren't leaked into user-run processes.
 */
function sanitizeEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = { ...base };
	for (const key of Object.keys(out)) {
		const upper = key.toUpperCase();
		if (
			upper.includes("API_KEY") ||
			upper.includes("APIKEY") ||
			upper.includes("SECRET") ||
			upper.includes("TOKEN") ||
			upper.includes("PASSWORD")
		) {
			delete out[key];
		}
	}
	// Make sure the child shell is not interactive in a way that breaks parsing.
	out.TERM = base.TERM || "xterm-256color";
	out.LANG = base.LANG || "en_US.UTF-8";
	return out;
}

let _seq = 0;

export class LocalPtyBackend {
	create(opts: PtySpawnOptions): PtySession {
		ensureSpawnHelperExecutable();
		const shell = opts.shell || defaultShell();
		const env = sanitizeEnv(opts.env ?? process.env);
		// A non-existent cwd makes node-pty fail with the same opaque
		// "posix_spawnp failed." error, so fall back to the user's home dir.
		const cwd = existsSync(opts.cwd) ? opts.cwd : (process.env.HOME || process.cwd());
		const pty = spawn(shell, [], {
			name: "xterm-256color",
			cols: opts.cols,
			rows: opts.rows,
			cwd,
			env: env as { [key: string]: string },
		});
		const id = `pty_${Date.now().toString(36)}_${(_seq++).toString(36)}`;

		return {
			id,
			pty,
			write(data: string) {
				pty.write(data);
			},
			resize(cols: number, rows: number) {
				try {
					pty.resize(cols, rows);
				} catch {
					// pty closed mid-resize; ignore
				}
			},
			onData(cb) {
				const sub = pty.onData(cb);
				return () => sub.dispose();
			},
			onExit(cb) {
				const sub = pty.onExit((e) => cb({ exitCode: e.exitCode, signal: e.signal }));
				return () => sub.dispose();
			},
			kill() {
				try {
					pty.kill();
				} catch {
					// already dead
				}
			},
		};
	}
}

export const localPtyBackend = new LocalPtyBackend();
