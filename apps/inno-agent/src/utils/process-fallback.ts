/**
 * Process-level last-resort handlers (`uncaughtException` / `unhandledRejection`).
 *
 * Without these, a single stray rejection or an exception thrown from inside a
 * catch block (e.g. the HTTP catch-all calling `json()` after SSE headers were
 * already sent) takes the whole process down with no log entry and no cleanup.
 * Node's own stance is that the process state is untrustworthy after an
 * uncaught exception, so these handlers log at fatal level and then shut down
 * gracefully rather than trying to soldier on.
 */

import { logger } from "../logger.js";

export interface ProcessFallbackOptions {
	/**
	 * Best-effort cleanup before exit (e.g. closing the HTTP server so
	 * in-flight SSE/terminal clients get a close frame instead of a hang).
	 * A thrown error here is ignored — the process exits regardless.
	 */
	onFatal?: () => void | Promise<void>;
	/** Max milliseconds to wait for `onFatal` before forcing exit. */
	exitTimeoutMs?: number;
}

export interface GracefulShutdownOptions {
	server: { close(callback: () => void): unknown };
	wss: {
		clients: Iterable<{ close(code: number, reason: string): void }>;
		close(callback: () => void): unknown;
	};
	/** Synchronous best-effort cleanup (child processes) before servers close. */
	cleanup?: () => void;
	exit: (code: number) => void;
	exitTimeoutMs?: number;
}

let installed = false;
// Fatal faults and signals must claim the same state so neither can start a
// second cleanup while the other path is already shutting down.
const shutdownState = { shuttingDown: false };

export function createGracefulShutdownHandler(
	options: GracefulShutdownOptions,
	state = shutdownState,
): () => void {
	return () => {
		if (state.shuttingDown) {
			options.exit(0);
			return;
		}
		state.shuttingDown = true;

		// Kill managed child processes (e.g. the UNO sidecar) before the
		// servers close so nothing lingers past the exit deadline.
		try { options.cleanup?.(); } catch { /* best effort */ }

		// SSE can keep server.close() pending forever. Leave two seconds before
		// Docker's default ten-second stop deadline rather than waiting for it.
		const forceExit = setTimeout(() => options.exit(0), options.exitTimeoutMs ?? 8_000);
		forceExit.unref();

		// ws 8.x does not close clients in noServer mode: send the going-away
		// frame explicitly before closing the servers, avoiding WS 1006 on exit.
		for (const ws of options.wss.clients) {
			try { ws.close(1001, "Server shutting down"); } catch { /* best effort */ }
		}

		void Promise.all([
			new Promise<void>((resolveClose) => {
				try { options.server.close(resolveClose); } catch { resolveClose(); }
			}),
			new Promise<void>((resolveClose) => {
				try { options.wss.close(resolveClose); } catch { resolveClose(); }
			}),
		]).then(() => {
			// HTTP close does not wait for upgraded sockets; let the WS close
			// handshakes finish too before exiting, unless the deadline wins.
			clearTimeout(forceExit);
			options.exit(0);
		});
	};
}

export function installProcessFallbacks(options: ProcessFallbackOptions = {}): void {
	if (installed) return;
	installed = true;

	const fatal = (kind: string, err: unknown): void => {
		// A second fault while shutting down (e.g. cleanup throws, or another
		// rejection lands) must not recurse — exit immediately.
		if (shutdownState.shuttingDown) {
			process.exit(1);
		}
		shutdownState.shuttingDown = true;

		logger.fatal({ err }, `[inno] ${kind} — shutting down`);

		const forceExit = setTimeout(() => process.exit(1), options.exitTimeoutMs ?? 3_000);
		forceExit.unref();

		Promise.resolve()
			.then(() => options.onFatal?.())
			.catch(() => {
				// Cleanup is best-effort; never let it block or prevent the exit.
			})
			.finally(() => process.exit(1));
	};

	process.on("uncaughtException", (err) => fatal("uncaughtException", err));
	process.on("unhandledRejection", (reason) => fatal("unhandledRejection", reason));
}
