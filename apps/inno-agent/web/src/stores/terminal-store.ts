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

	setOpen(open: boolean): void {
		if (this.isOpen === open) return;
		this.isOpen = open;
		this.emit("change", undefined);
	}

	async connect(innoSessionId: string, workspaceId?: string, cols = 100, rows = 24): Promise<void> {
		// If already connected to same session, no-op.
		if (this.innoSessionId === innoSessionId && this.status === "connected" && this.ws) return;
		// A code-block Run action opens the drawer first; the drawer then creates
		// its terminal connection. Keep queued commands across the connection's
		// internal cleanup so they are delivered with the server's `ready` event.
		const pendingRuns = this.pendingRuns;
		await this.disconnect();
		this.pendingRuns = pendingRuns;

		this.innoSessionId = innoSessionId;
		this.status = "connecting";
		this.error = "";
		this.emit("change", undefined);

		try {
			const info = await createTerminalSession({ sessionId: innoSessionId, workspaceId, cols, rows });
			this.terminalId = info.id;
			this.workspaceId = info.workspaceId;
			this.cwd = info.cwd;
		} catch (err) {
			this.pendingRuns = [];
			this.status = "error";
			this.error = err instanceof Error ? err.message : "Failed to create terminal";
			this.emit("change", undefined);
			return;
		}

		const ws = new WebSocket(terminalWsUrl(this.terminalId!));
		this.ws = ws;
		// Watchdog: if the server's `ready` event doesn't arrive within 5s,
		// flip to error so the UI stops showing 'connecting…' forever. The
		// most common cause is a dev-mode proxy that isn't forwarding WS.
		const watchdog = setTimeout(() => {
			if (this.status === "connecting") {
				this.pendingRuns = [];
				this.status = "error";
				this.error = "WebSocket connect timed out (check vite proxy `ws: true`?)";
				this.emit("change", undefined);
				try { ws.close(); } catch { /* ignore */ }
			}
		}, 5000);
		ws.onmessage = (ev) => {
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
		}
	}

	async disconnect(): Promise<void> {
		const id = this.terminalId;
		const ws = this.ws;
		this.ws = null;
		this.terminalId = null;
		this.innoSessionId = null;
		this.workspaceId = null;
		this.cwd = null;
		this.activeRunId = null;
		this.pendingRuns = [];
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
