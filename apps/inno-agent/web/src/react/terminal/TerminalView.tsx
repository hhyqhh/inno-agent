import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { terminalStore } from "../../stores/terminal-store.js";

interface TerminalViewProps {
	innoSessionId: string;
	workspaceId?: string;
	className?: string;
}

/**
 * Mounts an xterm.js instance and wires it to the global terminalStore.
 * The store handles WS create/close + protocol. This component only owns the
 * DOM-level xterm + addon-fit lifecycle.
 */
export function TerminalView({ innoSessionId, workspaceId, className }: TerminalViewProps) {
	const hostRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;

		const term = new Terminal({
			fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
			fontSize: 13,
			cursorBlink: true,
			convertEol: true,
			theme: {
				background: "#0f172a",
				foreground: "#e2e8f0",
				cursor: "#cbd5e1",
				cursorAccent: "#0f172a",
				selectionBackground: "#334155",
				black: "#1e293b",
				red: "#f87171",
				green: "#34d399",
				yellow: "#fbbf24",
				blue: "#60a5fa",
				magenta: "#c084fc",
				cyan: "#22d3ee",
				white: "#e2e8f0",
				brightBlack: "#475569",
				brightRed: "#fca5a5",
				brightGreen: "#6ee7b7",
				brightYellow: "#fcd34d",
				brightBlue: "#93c5fd",
				brightMagenta: "#d8b4fe",
				brightCyan: "#67e8f9",
				brightWhite: "#f1f5f9",
			},
			scrollback: 5000,
		});
		const fit = new FitAddon();
		const links = new WebLinksAddon();
		term.loadAddon(fit);
		term.loadAddon(links);
		term.open(host);
		try { fit.fit(); } catch { /* container may not have layout yet */ }

		// Input → server
		const inputSub = term.onData((data) => {
			terminalStore.input(data);
		});

		// Server → xterm
		const offOutput = terminalStore.on("output", (chunk) => {
			term.write(chunk);
		});

		// Connect (idempotent if same session is already wired).
		void terminalStore.connect(innoSessionId, workspaceId, term.cols, term.rows);

		// Resize tracking
		const ro = new ResizeObserver(() => {
			try {
				fit.fit();
				terminalStore.resize(term.cols, term.rows);
			} catch {
				// ignore transient layout errors
			}
		});
		ro.observe(host);

		return () => {
			ro.disconnect();
			offOutput();
			inputSub.dispose();
			term.dispose();
		};
		// Intentionally re-mount xterm only when innoSessionId/workspaceId change.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [innoSessionId, workspaceId]);

	return <div ref={hostRef} className={className ?? "h-full w-full"} />;
}
