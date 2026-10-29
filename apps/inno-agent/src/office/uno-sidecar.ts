/**
 * UNO sidecar manager (UNO sidecar 进程管理).
 *
 * Owns one `uno-bridge.py` process per backend instance: the bridge runs
 * under LibreOffice's bundled python, spawns a headless soffice with a
 * loopback UNO socket, and serves newline-delimited JSON RPC on stdio.
 *
 * Requests are serialized (one in flight at a time) because the bridge is
 * single-threaded by design — UNO automation is not re-entrant and parallel
 * edits to the same document would corrupt state anyway. If the bridge dies
 * (crash / killed soffice), the next call lazily starts a fresh one; open
 * documents do not survive a restart and callers see a clear error.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../logger.js";
import { findOfficePython, getOfficeEngine } from "./engine-locator.js";

const BRIDGE_SCRIPT = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"scripts",
	"uno-bridge.py",
);

const START_TIMEOUT_MS = 90_000;
const CALL_TIMEOUT_MS = 60_000;
const MAX_PENDING = 32;

export interface UnoCallResult<T = unknown> {
	ok: boolean;
	result?: T;
	error?: string;
}

export class UnoEngineUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UnoEngineUnavailableError";
	}
}

interface PendingCall {
	id: number;
	resolve: (value: UnoCallResult) => void;
	timer: NodeJS.Timeout;
}

export class UnoSidecar {
	private proc: ChildProcess | null = null;
	private reader: Interface | null = null;
	private ready = false;
	private starting: Promise<void> | null = null;
	private nextId = 1;
	private pending = new Map<number, PendingCall>();
	/** Serializes calls: a queued call starts only after the previous reply. */
	private queue: Promise<unknown> = Promise.resolve();
	private queued = 0;
	private stopped = false;

	/** Base port for the UNO socket; offset per restart to dodge TIME_WAIT. */
	private port = 20073 + (process.pid % 100) * 10;

	/** Resolve engine + python, throwing UnoEngineUnavailableError with
	 * actionable guidance when the machine has no usable LibreOffice. The
	 * engine comes from the shared async locator so the 26.8.0 CJK grid
	 * blacklist applies to UNO edits too. */
	private async resolveRuntime(): Promise<{ soffice: string; python: string }> {
		let engine: Awaited<ReturnType<typeof getOfficeEngine>>;
		try {
			engine = await getOfficeEngine();
		} catch (err) {
			const code = err instanceof Error ? err.message : String(err);
			if (code === "WORD_ENGINE_INCOMPATIBLE") {
				throw new UnoEngineUnavailableError(
					"检测到 LibreOffice 26.8.0，该版本存在中文行距回归（tdf#171275，26.8.1 修复），" +
					"文档引擎拒绝使用。请升级 LibreOffice 至 26.8.1 或更高版本。",
				);
			}
			throw new UnoEngineUnavailableError(
				"未找到 LibreOffice 引擎。桌面版安装包已内置；服务器/开发环境请安装 " +
				"LibreOffice（macOS: brew install --cask libreoffice）或设置 INNO_LIBREOFFICE_PATH。",
			);
		}
		const python = await findOfficePython(engine.path);
		if (!python) {
			throw new UnoEngineUnavailableError(
				`找到 LibreOffice（${engine.path}）但缺少可用的 python-uno 解释器。` +
				"Linux 请安装 python3-uno；macOS/Windows 请使用随包内置的引擎。",
			);
		}
		return { soffice: engine.path, python };
	}

	private async start(): Promise<void> {
		const { soffice, python } = await this.resolveRuntime();
		if (this.stopped) throw new Error("UNO sidecar is closed");
		this.port += 1;
		logger.info({ port: this.port }, "uno-sidecar: starting bridge");
		const proc = spawn(python, [BRIDGE_SCRIPT, "--soffice", soffice, "--port", String(this.port)], {
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		this.proc = proc;
		this.ready = false;

		proc.stderr?.on("data", (chunk) => {
			logger.debug({ bytes: chunk.length }, "uno-bridge stderr received");
		});
		proc.on("exit", (code, signal) => {
			logger.warn({ code, signal }, "uno-bridge exited");
			// An old process may exit after its replacement has already started.
			if (this.proc === proc) this.handleExit();
		});
		proc.stdin?.on("error", () => {
			if (this.proc === proc) { proc.kill(); this.handleExit(); }
		});

		this.reader = createInterface({ input: proc.stdout! });
		const readyPromise = new Promise<void>((resolveReady, rejectReady) => {
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				rejectReady(new Error(`uno-bridge did not become ready within ${START_TIMEOUT_MS}ms`));
			}, START_TIMEOUT_MS);
			// spawn errors emit `error`, without necessarily emitting `exit`.
			proc.once("error", (error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				rejectReady(new UnoEngineUnavailableError(`UNO bridge spawn failed: ${error.message}`));
			});
			proc.once("exit", (code, signal) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				rejectReady(new UnoEngineUnavailableError(
					`uno-bridge exited during startup (code=${code} signal=${signal ?? "none"})。` +
					"macOS 上若使用 /Applications 里的 LibreOffice，其内置 python 受启动约束保护，" +
					"无法被外部进程拉起——请改用随包内置引擎或设置 INNO_LIBREOFFICE_PATH 指向重签名副本。",
				));
			});
			this.reader!.on("line", (line) => {
				let msg: Record<string, unknown>;
				try {
					msg = JSON.parse(line);
				} catch {
					logger.warn("uno-bridge: non-JSON stdout line");
					return;
				}
				if (msg.type === "ready") {
					if (settled || this.proc !== proc) return;
					settled = true;
					clearTimeout(timer);
					this.ready = true;
					resolveReady();
					return;
				}
				if (msg.type === "error") {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					rejectReady(new UnoEngineUnavailableError(String(msg.error)));
					return;
				}
				this.dispatch(msg);
			});
		});
		await readyPromise;
	}

	private handleExit(): void {
		const wasReady = this.ready;
		this.ready = false;
		this.proc = null;
		this.reader?.removeAllListeners();
		this.reader?.close();
		this.reader = null;
		const error = wasReady
			? "LibreOffice 引擎进程意外退出，已打开的文档句柄失效。请重新打开文档后重试。"
			: "LibreOffice 引擎未能启动。";
		for (const call of this.pending.values()) {
			clearTimeout(call.timer);
			call.resolve({ ok: false, error });
		}
		this.pending.clear();
	}

	private dispatch(msg: Record<string, unknown>): void {
		const id = typeof msg.id === "number" ? msg.id : null;
		if (id === null) return;
		const call = this.pending.get(id);
		if (!call) return;
		this.pending.delete(id);
		clearTimeout(call.timer);
		call.resolve({
			ok: msg.ok === true,
			result: msg.result,
			error: typeof msg.error === "string" ? msg.error : undefined,
		});
	}

	private async ensureStarted(): Promise<void> {
		if (this.stopped) throw new Error("UNO sidecar is closed");
		if (this.ready && this.proc) return;
		if (!this.starting) {
			this.starting = this.start()
				.catch((err) => {
					this.proc?.kill();
					this.handleExit();
					throw err;
				})
				.finally(() => {
					this.starting = null;
				});
		}
		await this.starting;
	}

	/**
	 * Call the bridge, serialized through the internal queue. Never rejects:
	 * failures come back as { ok: false, error } so tool code can pass the
	 * message straight through to the model.
	 */
	call<T = unknown>(cmd: string, payload: Record<string, unknown> = {}): Promise<UnoCallResult<T>> {
		// Count queued requests too; serialized calls only ever put one item
		// in `pending`, so checking that map did not bound the actual queue.
		if (this.queued >= MAX_PENDING) return Promise.resolve({ ok: false, error: "UNO bridge 请求队列已满，请稍后再试。" });
		this.queued++;
		const run = async (): Promise<UnoCallResult<T>> => {
			try {
				await this.ensureStarted();
			} catch (err) {
				return { ok: false, error: err instanceof Error ? err.message : String(err) };
			}
			if (this.pending.size >= MAX_PENDING) {
				return { ok: false, error: "UNO bridge 请求队列已满，请稍后再试。" };
			}
			return await new Promise<UnoCallResult<T>>((resolveCall) => {
				const id = this.nextId++;
				const timer = setTimeout(() => {
					// A timed-out UNO operation can still be running. Retire that
					// process before another queued edit can use its uncertain state.
					this.pending.delete(id);
					this.proc?.kill();
					this.handleExit();
					resolveCall({ ok: false, error: `UNO 调用 ${cmd} 超时，文档句柄已失效，请重新打开。` });
				}, CALL_TIMEOUT_MS);
				this.pending.set(id, { id, resolve: resolveCall as (v: UnoCallResult) => void, timer });
				try {
					this.proc!.stdin!.write(JSON.stringify({ id, cmd, ...payload }) + "\n");
				} catch (err) {
					this.pending.delete(id);
					clearTimeout(timer);
					resolveCall({ ok: false, error: err instanceof Error ? err.message : String(err) });
				}
			});
		};
		const result = this.queue.then(run, run).finally(() => { this.queued--; });
		this.queue = result.catch(() => undefined);
		return result as Promise<UnoCallResult<T>>;
	}

	async dispose(): Promise<void> {
		if (!this.proc) return;
		try {
			await this.call("shutdown");
		} catch {
			/* best effort */
		}
		this.proc?.kill();
		this.proc = null;
		this.ready = false;
	}

	/**
	 * Synchronous teardown for process-signal paths: SIGTERM the bridge (its
	 * own signal handler shuts soffice down) without waiting for a reply.
	 */
	killSync(): void {
		this.stopped = true;
		const proc = this.proc;
		this.handleExit();
		if (!proc) return;
		try {
			proc.kill("SIGTERM");
		} catch {
			/* already gone */
		}
	}
}

let shared: UnoSidecar | null = null;

/** Process-wide shared sidecar; one soffice instance serves all sessions. */
export function getUnoSidecar(): UnoSidecar {
	if (!shared) shared = new UnoSidecar();
	return shared;
}

/** Best-effort synchronous teardown of the shared sidecar (server shutdown). */
export function killSharedUnoSidecar(): void {
	shared?.killSync();
	shared = null;
}

/** For tests: reset the shared instance. */
export function resetUnoSidecarForTests(): void {
	shared = null;
}
