import type { EngineAttachmentItem } from "./engine.js";

export type DropMatchState = "match" | "mismatch" | "partial";

/** One measurable chunk of visible mirror text/geometry used for hit-testing. */
export interface FlowAtom {
	start: number;
	end: number;
	left: number;
	right: number;
	top: number;
	bottom: number;
}

// Chromium/WebKit renders the native green copy badge around the pointer. Keep
// the app-owned feedback just outside that badge instead of leaving a visible gap.
export const DRAG_FEEDBACK_OFFSET_X = 22;
export const DRAG_FEEDBACK_OFFSET_Y = 8;
export const DRAG_FEEDBACK_RING_SIZE = 20;

/**
 * Resolve a caret offset from the pre-measured flow atoms. The textarea sits
 * above the mirror and makes caretRangeFromPoint unreliable, so line selection
 * and half-atom snapping happen over the mirror's own geometry.
 */
export function offsetAtPointInAtoms(atoms: FlowAtom[], clientX: number, clientY: number): number | null {
	if (atoms.length === 0) return null;
	const lines = new Map<number, FlowAtom[]>();
	for (const atom of atoms) {
		const lineKey = Math.round((atom.top + atom.bottom) / 2);
		const line = lines.get(lineKey) ?? [];
		line.push(atom);
		lines.set(lineKey, line);
	}
	const orderedLines = Array.from(lines.values()).sort((a, b) => (a[0]?.top ?? 0) - (b[0]?.top ?? 0));
	const line = orderedLines.find((candidate) => {
		const top = Math.min(...candidate.map((atom) => atom.top));
		const bottom = Math.max(...candidate.map((atom) => atom.bottom));
		return clientY >= top && clientY <= bottom;
	}) ?? (clientY < (orderedLines[0]?.[0]?.top ?? 0) ? orderedLines[0] : orderedLines[orderedLines.length - 1]);
	if (!line || line.length === 0) return null;
	line.sort((a, b) => a.left - b.left || a.start - b.start);
	if (clientX <= line[0]!.left) return line[0]!.start;
	for (const atom of line) {
		if (clientX <= (atom.left + atom.right) / 2) return atom.start;
		if (clientX <= atom.right) return atom.end;
	}
	return line[line.length - 1]!.end;
}

/**
 * Auto-scroll delta (px per step) while pointer-dragging near the textarea
 * edges; 0 when the pointer is inside the safe band.
 */
export function autoScrollDelta(
	clientY: number,
	rect: { top: number; bottom: number; height: number },
	maxScroll: number,
): number {
	if (maxScroll <= 0 || rect.height <= 0) return 0;
	const edge = Math.min(56, Math.max(28, rect.height * 0.24));
	if (clientY <= rect.top + edge) {
		const distance = rect.top + edge - clientY;
		return -Math.min(24, Math.max(6, distance * 0.65));
	}
	if (clientY >= rect.bottom - edge) {
		const distance = clientY - (rect.bottom - edge);
		return Math.min(24, Math.max(6, distance * 0.65));
	}
	return 0;
}

/** Clamp the drag-following status pill inside the viewport, clear of the native badge. */
export function clampDropStatusPosition(x: number, y: number, width: number, height: number): { left: number; top: number } {
	const left = Math.max(8, Math.min(x + DRAG_FEEDBACK_OFFSET_X, window.innerWidth - width - 8));
	// Center with the 20px dwell ring so a taller status bar is not pushed downward.
	const centeredTop = y + DRAG_FEEDBACK_OFFSET_Y - Math.max(0, (height - DRAG_FEEDBACK_RING_SIZE) / 2);
	const top = Math.max(8, Math.min(centeredTop, window.innerHeight - height - 8));
	return { left, top };
}

export function parseAttachmentTransfer(dataTransfer: DataTransfer | null | undefined): EngineAttachmentItem[] {
	if (!dataTransfer) return [];
	try {
		const raw = dataTransfer.getData("application/x-inno-file");
		if (!raw) return [];
		const parsed = JSON.parse(raw) as {
			name?: unknown;
			path?: unknown;
			source?: unknown;
			items?: unknown;
		};
		const candidates = Array.isArray(parsed.items) ? parsed.items : [parsed];
		return candidates.flatMap((candidate): EngineAttachmentItem[] => {
			if (!candidate || typeof candidate !== "object") return [];
			const item = candidate as { name?: unknown; path?: unknown; source?: unknown };
			if (typeof item.name !== "string" || typeof item.path !== "string") return [];
			if (item.source !== "workspace" && item.source !== "local") return [];
			return [{
				name: item.name,
				path: item.path,
				source: item.source,
			}];
		});
	} catch {
		return [];
	}
}

export function dropMatchState(files: EngineAttachmentItem[], accepts: (name: string) => boolean): DropMatchState {
	const matched = files.reduce((count, file) => count + (accepts(file.name) ? 1 : 0), 0);
	if (matched === 0) return "mismatch";
	if (matched === files.length) return "match";
	return "partial";
}

let hiddenImageEl: HTMLCanvasElement | null = null;

/**
 * Build the shared drag file panel (extension badge + name, multi-file count
 * pill, stacked-sheet shadow). Used by the smart-input live follower and by
 * the native drag-image snapshots so every drag mode looks identical.
 * Pass `snapshot: true` for setDragImage use (parked offscreen).
 */
export function buildDragFilePanel(
	items: ReadonlyArray<{ name: string }>,
	snapshot = false,
): HTMLElement {
	const panel = document.createElement("div");
	panel.className = `inno-drag-follower${items.length > 1 ? " is-multi" : ""}${snapshot ? " is-snapshot" : ""}`;
	panel.setAttribute("aria-hidden", "true");
	if (items.length === 0) return panel;

	const files = document.createElement("div");
	files.className = "inno-drag-follower-files";
	// Multi-file drags collapse to one row (first file + count pill); a
	// stacked list reads as clutter next to the cursor.
	const shown = items.length > 1 ? items.slice(0, 1) : items.slice(0, 3);
	for (const item of shown) {
		const row = document.createElement("div");
		row.className = "inno-drag-follower-file";
		const ext = document.createElement("span");
		ext.className = "inno-drag-follower-ext";
		const dot = item.name.lastIndexOf(".");
		ext.textContent = dot > 0 ? item.name.slice(dot + 1).toUpperCase().slice(0, 4) : "FILE";
		row.appendChild(ext);
		const name = document.createElement("span");
		name.className = "inno-drag-follower-name";
		name.textContent = item.name;
		row.appendChild(name);
		files.appendChild(row);
	}
	if (items.length > 1) {
		const count = document.createElement("span");
		count.className = "inno-drag-follower-count";
		count.textContent = `×${items.length}`;
		files.querySelector(".inno-drag-follower-file")!.appendChild(count);
	} else if (items.length > 3) {
		const more = document.createElement("div");
		more.className = "inno-drag-follower-more";
		more.textContent = `+${items.length - 3}`;
		files.appendChild(more);
	}
	panel.appendChild(files);
	if (snapshot) {
		panel.style.position = "fixed";
		panel.style.top = "-10000px";
		panel.style.left = "-10000px";
		document.body.appendChild(panel);
	}
	return panel;
}

/**
 * 1x1 transparent canvas used as the native drag image when the smart-input
 * engine owns the live drag follower, so only one drag panel is visible.
 */
export function hiddenDragImage(): HTMLCanvasElement {
	if (!hiddenImageEl) {
		hiddenImageEl = document.createElement("canvas");
		hiddenImageEl.width = 1;
		hiddenImageEl.height = 1;
		// Must live in the DOM (offscreen) or Chromium renders the drag image
		// as a visible dot at the cursor.
		hiddenImageEl.style.position = "fixed";
		hiddenImageEl.style.top = "-10000px";
		hiddenImageEl.style.left = "-10000px";
		document.body.appendChild(hiddenImageEl);
	}
	return hiddenImageEl;
}
