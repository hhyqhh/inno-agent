import type { ReactNode } from "react";
import { DndProvider } from "react-dnd";
import { HTML5Backend } from "react-dnd-html5-backend";
import { TouchBackend } from "react-dnd-touch-backend";

/**
 * Shared drag-and-drop provider. Touch devices get the Touch backend (HTML5
 * drag-and-drop is mouse-only); touchSlop matches the long-press context
 * menu's move tolerance: an immediate move drags the row, a stationary hold
 * opens the menu instead of starting a drag.
 */
const TOUCH_DND_OPTIONS = { enableMouseEvents: true, touchSlop: 10 };

export function InnoDndProvider({ children }: { children: ReactNode }) {
	const coarsePointer = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
	return coarsePointer ? (
		<DndProvider backend={TouchBackend} options={TOUCH_DND_OPTIONS}>
			{children}
		</DndProvider>
	) : (
		<DndProvider backend={HTML5Backend}>
			{children}
		</DndProvider>
	);
}
