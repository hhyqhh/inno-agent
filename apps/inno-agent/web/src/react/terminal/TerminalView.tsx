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

// Per-theme xterm color schemes. Keys match ThemeId values.
const TERMINAL_THEMES: Record<ThemeId, ITheme> = {
	light: {
		background: "#ffffff",
		foreground: "#1f1f1f",
		cursor: "#444746",
		cursorAccent: "#ffffff",
		selectionBackground: "#d5dae2",
		black: "#1f1f1f", red: "#c5221f", green: "#137333", yellow: "#b06000",
		blue: "#0b57d0", magenta: "#7627bb", cyan: "#0d9488", white: "#444746",
		brightBlack: "#5f6368", brightRed: "#dc2626", brightGreen: "#16a34a",
		brightYellow: "#d97706", brightBlue: "#3b82f6", brightMagenta: "#9333ea",
		brightCyan: "#06b6d4", brightWhite: "#1f1f1f",
	},
	dark: {
		background: "#171717", foreground: "#ececec", cursor: "#c5c5c5",
		cursorAccent: "#171717", selectionBackground: "#3b3b3b",
		black: "#262626", red: "#f39a92", green: "#8bd3a0", yellow: "#f7bd55",
		blue: "#a8c7fa", magenta: "#c58af9", cyan: "#78d9ec", white: "#c4c7cb",
		brightBlack: "#979797", brightRed: "#f6aea9", brightGreen: "#a8dab5",
		brightYellow: "#fdd663", brightBlue: "#c4ddfc", brightMagenta: "#dab5fb",
		brightCyan: "#a5e5f2", brightWhite: "#ececec",
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

		// Resize tracking. A splitter drag resizes the host every frame; refitting
		// xterm (DOM measure + canvas redraw + WS resize) at that rate drops
		// frames, so refresh periodically mid-drag. On release the dragging body
		// class is already gone, so the final resize delivery snaps to the
		// committed layout.
		let resizeTimer = 0;
		const refit = () => {
			try {
				fit.fit();
				terminalStore.resize(term.cols, term.rows);
			} catch {
				// ignore transient layout errors
			}
		};
		const ro = new ResizeObserver(() => {
			if (document.body.classList.contains("workspace-resizing") || document.body.classList.contains("inno-ui-resizing-columns")) {
				if (resizeTimer === 0) resizeTimer = window.setTimeout(() => { resizeTimer = 0; refit(); }, 150);
				return;
			}
			if (resizeTimer !== 0) {
				clearTimeout(resizeTimer);
				resizeTimer = 0;
			}
			refit();
		});
		ro.observe(host);

		// React to theme switches live.
		const offTheme = themeStore.on("change", () => {
			term.options.theme = TERMINAL_THEMES[themeStore.current];
		});

		return () => {
			if (resizeTimer !== 0) clearTimeout(resizeTimer);
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
