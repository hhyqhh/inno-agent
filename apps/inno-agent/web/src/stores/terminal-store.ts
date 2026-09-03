import { EventEmitter } from "./event-emitter.js";
import { closeTerminalSession, createTerminalSession, terminalWsUrl } from "../api/terminal.js";
import type { ClientTerminalEvent, ServerTerminalEvent } from "../types/terminal.js";

interface TerminalStoreEvents {
	change: void;
	/** Raw output chunk forwarded to whoever owns the xterm instance. */
	output: string;
}

export type TerminalStatus =
	| "idle"
	| "connecting"
	| "connected"
	| "running"
	| "disconnected"
	| "error";

class TerminalStoreImpl extends EventEmitter<TerminalStoreEvents> {
	terminalId: string | null = null;
	innoSessionId: string | null = null;
	workspaceId: string | null = null;
	cwd: string | null = null;
	status: TerminalStatus = "idle";
	error = "";
	isOpen = false;
	activeRunId: string | null = null;
	lastCommand: string | null = null;

	private ws: WebSocket | null = null;
	/** Commands queued while no live socket exists. Drained on the next
	 * connection's `ready` event and cleared on every failure path so a stale
	 * command can never fire into a later, unrelated session/workspace. */
	private pendingRuns: Array<{ command: string; sourceFile?: string; content?: string }> = [];
	/** Bumped on every connect()/disconnect(); a connect that wakes from an
	 * await to find the generation moved has been superseded and must stop
	 * before it touches shared state. StrictMode double-invokes the mounting
	 * effect, so two connect() calls routinely interleave in dev. */
	private connectGeneration = 0;

	setOpen(open: boolean): void {
		if (this.isOpen === open) return;
		this.isOpen = open;
		this.emit("change", undefined);
	}

	async connect(innoSessionId: string, workspaceId?: string, cols = 100, rows = 24): Promise<void> {
		// If already connected to same session, no-op.
		if (this.innoSessionId === innoSessionId && this.status === "connected" && this.ws) return;
		// A handshake for this same session is already in flight (StrictMode
		// mounts the terminal view twice) — a second attempt would tear it down.
		if (this.innoSessionId === innoSessionId && this.status === "connecting") return;
		// A code-block Run action opens the drawer first; the drawer then creates
		// its terminal connection. The queue is preserved across this teardown so
		// queued commands are delivered with the server's `ready` event.
		await this.teardown({ preserveQueue: true });
		const generation = ++this.connectGeneration;

		this.innoSessionId = innoSessionId;
		this.status = "connecting";
		this.error = "";
		this.emit("change", undefined);

		let info;
		try {
			info = await createTerminalSession({ sessionId: innoSessionId, workspaceId, cols, rows });
		} catch (err) {
			if (generation !== this.connectGeneration) return;
			this.pendingRuns = [];
			this.status = "error";
			this.error = err instanceof Error ? err.message : "Failed to create terminal";
			this.emit("change", undefined);
			return;
		}
		if (generation !== this.connectGeneration) {
			// Superseded while the session was being created — don't leak it.
			try { await closeTerminalSession(info.id); } catch { /* server may be gone */ }
			return;
		}
		this.terminalId = info.id;
		this.workspaceId = info.workspaceId;
		this.cwd = info.cwd;

		const ws = new WebSocket(terminalWsUrl(this.terminalId!));
		this.ws = ws;
		// Watchdog: if the server's `ready` event doesn't arrive within 5s,
		// flip to error so the UI stops showing 'connecting…' forever. The
		// most common cause is a dev-mode proxy that isn't forwarding WS.
		const watchdog = setTimeout(() => {
			if (this.ws !== ws) return;
			if (this.status === "connecting") {
				this.pendingRuns = [];
				this.status = "error";
				this.error = "WebSocket connect timed out (check vite proxy `ws: true`?)";
				this.emit("change", undefined);
				try { ws.close(); } catch { /* ignore */ }
			}
		}, 5000);
		ws.onmessage = (ev) => {
			// Ignore sockets from connections that were already replaced.
			if (this.ws !== ws) return;
			let event: ServerTerminalEvent;
			try {
				event = JSON.parse(ev.data) as ServerTerminalEvent;
			} catch {
				return;
			}
			switch (event.type) {
				case "ready":
					clearTimeout(watchdog);
					this.status = "connected";
					this.emit("change", undefined);
					if (this.pendingRuns.length > 0) {
						const queued = this.pendingRuns;
						this.pendingRuns = [];
						for (const pending of queued) {
							this.send({ type: "run", command: pending.command, sourceFile: pending.sourceFile, content: pending.content });
						}
					}
					break;
				case "output":
					this.emit("output", event.data);
					break;
				case "run_started":
					this.activeRunId = event.runId;
					this.lastCommand = event.command;
					this.status = "running";
					this.emit("change", undefined);
					break;
				case "exit":
					this.activeRunId = null;
					this.status = "connected";
					this.emit("change", undefined);
					break;
				case "error":
					this.error = event.message;
					this.emit("change", undefined);
					break;
			}
		};
		ws.onopen = () => {
			// status flips to 'connected' on the server's 'ready' event
		};
		ws.onclose = () => {
			clearTimeout(watchdog);
			// Ignore sockets from connections that were already replaced —
			// otherwise a late close would wipe the queue connect() restored.
			if (this.ws !== ws) return;
			this.ws = null;
			if (this.status !== "error") this.status = "disconnected";
			// A socket that closes before `ready` can never drain the queue.
			this.pendingRuns = [];
			this.emit("change", undefined);
		};
		ws.onerror = () => {
			clearTimeout(watchdog);
			// Same stale-socket guard as onclose: a replaced socket's error must
			// not clobber the live connection's status or wipe its queue.
			if (this.ws !== ws) return;
			this.pendingRuns = [];
			this.status = "error";
			this.error = "WebSocket error";
			this.emit("change", undefined);
		};
	}

	send(event: ClientTerminalEvent): void {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
		this.ws.send(JSON.stringify(event));
	}

	input(data: string): void {
		this.send({ type: "input", data });
	}

	resize(cols: number, rows: number): void {
		this.send({ type: "resize", cols, rows });
	}

	runCommand(command: string, sourceFile?: string, content?: string): void {
		if (!command.trim()) return;
		this.lastCommand = command;
		this.setOpen(true);
		// Any established session can take the command immediately — including
		// while a previous run is still executing (status "running"); the server
		// serializes runs. A missing or still-handshaking socket needs the queue.
		if (this.ws?.readyState === WebSocket.OPEN && (this.status === "connected" || this.status === "running")) {
			this.send({ type: "run", command, sourceFile, content });
		} else {
			this.pendingRuns.push({ command, sourceFile, content });
			// The socket died or errored with a session still bound (e.g. the
			// backend restarted) — revive it on demand so a Run click is never
			// a silent no-op. The queued command drains on `ready`.
			if (this.innoSessionId && (this.status === "disconnected" || this.status === "error")) {
				void this.connect(this.innoSessionId, this.workspaceId ?? undefined);
			}
		}
	}

	async disconnect(): Promise<void> {
		await this.teardown({ preserveQueue: false });
	}

	private async teardown({ preserveQueue }: { preserveQueue: boolean }): Promise<void> {
		// Invalidate any in-flight connect() still waiting on an await.
		this.connectGeneration += 1;
		const id = this.terminalId;
		const ws = this.ws;
		this.ws = null;
		this.terminalId = null;
		this.innoSessionId = null;
		this.workspaceId = null;
		this.cwd = null;
		this.activeRunId = null;
		if (!preserveQueue) this.pendingRuns = [];
		this.status = "idle";
		this.emit("change", undefined);
		if (ws) {
			try { ws.close(); } catch { /* ignore */ }
		}
		if (id) {
			try { await closeTerminalSession(id); } catch { /* server may be gone */ }
		}
	}
}

export const terminalStore = new TerminalStoreImpl();
