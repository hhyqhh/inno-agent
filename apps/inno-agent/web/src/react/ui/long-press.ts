import type { TouchEvent } from "react";

/**
 * Long-press counterpart to `onContextMenu` for touch devices.
 *
 * Returns touch handlers that fire `open` with the touch point after a 500ms
 * hold (cancelled by a >10px move, i.e. scrolling), and suppress the synthetic
 * tap that would otherwise follow the long-press and trigger the row's onClick.
 *
 * Usage: spread next to an existing onContextMenu handler —
 * `<div onContextMenu={...} {...getLongPressHandlers((x, y) => ...)} />`
 */
export function getLongPressHandlers(open: (x: number, y: number) => void) {
	let timer: number | null = null;
	let startX = 0;
	let startY = 0;
	let fired = false;

	const cancel = () => {
		if (timer !== null) {
			window.clearTimeout(timer);
			timer = null;
		}
	};

	return {
		onTouchStart: (e: TouchEvent) => {
			const touch = e.touches[0];
			if (!touch) return;
			startX = touch.clientX;
			startY = touch.clientY;
			fired = false;
			timer = window.setTimeout(() => {
				timer = null;
				fired = true;
				open(startX, startY);
			}, 500);
		},
		onTouchMove: (e: TouchEvent) => {
			const touch = e.touches[0];
			if (!touch) return;
			if (Math.abs(touch.clientX - startX) > 10 || Math.abs(touch.clientY - startY) > 10) cancel();
		},
		onTouchEnd: (e: TouchEvent) => {
			cancel();
			if (fired) {
				fired = false;
				// Swallow the synthetic tap that follows a long-press. touchend is
				// not one of React's root-passive events, so preventDefault works here.
				e.preventDefault();
			}
		},
		onTouchCancel: cancel,
	};
}
