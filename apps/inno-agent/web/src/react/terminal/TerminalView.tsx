import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import type { ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { terminalStore } from "../../stores/terminal-store.js";
import { themeStore, type ThemeId } from "../../stores/theme-store.js";

interface TerminalViewProps {
	innoSessionId: string;
	workspaceId?: string;
	className?: string;
}

// Per-theme xterm color schemes. Light themes use a light terminal palette;
// dark themes use a dark one. Keys match ThemeId values.
const TERMINAL_THEMES: Record<ThemeId, ITheme> = {
	innospark: {
		background: "#ffffff", foreground: "#191922", cursor: "#555aff",
		cursorAccent: "#ffffff", selectionBackground: "#edeeff",
		black: "#191922", red: "#dc2626", green: "#22a06b", yellow: "#d99a08",
		blue: "#555aff", magenta: "#7c5cff", cyan: "#6a7cff", white: "#545469",
		brightBlack: "#9d9da9", brightRed: "#ef4444", brightGreen: "#2bbf7b",
		brightYellow: "#f5b62f", brightBlue: "#6b70ff", brightMagenta: "#8b70ff",
		brightCyan: "#8291ff", brightWhite: "#191922",
	},
};

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
			theme: TERMINAL_THEMES[themeStore.current],
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

		// React to theme switches live.
		const offTheme = themeStore.on("change", () => {
			term.options.theme = TERMINAL_THEMES[themeStore.current];
		});

		return () => {
			ro.disconnect();
			offOutput();
			offTheme();
			inputSub.dispose();
			term.dispose();
		};
		// Intentionally re-mount xterm only when innoSessionId/workspaceId change.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [innoSessionId, workspaceId]);

	return <div ref={hostRef} className={className ?? "h-full w-full"} />;
}
